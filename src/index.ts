/**
 * wisp-client：把当前 pi 会话作为 agent 挂到 wisp-gateway。
 *
 * 事件模型沿用 yangyang0507/pi-wechat 验证过的模式：
 * - 收到 task → sendUserMessage 注入（带来源标签前缀）
 * - before_agent_start → 附加 system_prompt（task 下发 + 微信回复约束）
 * - agent_end → 提取最终 assistant 文本 → ws reply 帧
 * - agent_start/agent_end → ws typing on/off
 * - 任务进度：turn_start / tool_call 更新本地进度，每 10 秒（或状态变化时）发 status 帧；
 *   收到 gateway 的 probe 帧立刻回报一次（带外查询，不打断正在跑的 agent 循环）
 * 断线指数退避重连，重连后发 resume 补领未完结任务。
 * WS 用 Node 22+ 原生 WebSocket，零依赖。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, mkdirSync, openSync, readSync, closeSync, renameSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { Type } from '@sinclair/typebox'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@mariozechner/pi-coding-agent'

type NotificationLevel = 'info' | 'warning' | 'error'

/** 一条注入给 pi 的内容块（与 pi 的 TextContent/ImageContent 结构一致） */
type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

/**
 * agent_id 的生成模式（v0.2，多会话支持）：
 * - `off`（默认）：全机共用一个 `agent_id`。多开会被网关互相顶替（只有最后一个在线）。
 * - `dir`：`<agent_id>-<工作区目录名>`。**同目录多个会话仍然共用一个 id**（会互相踢）。
 * - `session`：`<agent_id>-<目录名>-<短会话id>`。每个 pi 会话独立身份，互不顶替。
 *
 * 老配置 `agent_id_per_session = true` 等价于 `dir`（不改变已有行为）。
 */
type AgentIdMode = 'off' | 'dir' | 'session'

interface GatewayConfig {
  agentId: string
  token: string
  url: string // e.g. wss://gateway.example.com/agent
  agentIdMode: AgentIdMode
  /** 打开目录/扩展加载就自动连（默认 true）；false 时只能手动 /wisp-login */
  autoConnect?: boolean
  /** 让 pi-web 别把这个会话按空闲回收（默认 true）；见 `syncLiveness` */
  keepAlive?: boolean
}

/** pi-web 的「会话存活挂钩」注册表（`globalThis[Symbol.for(...)]`）。
 *
 *  为什么需要它（2026-11-16 查明的真正根因）：**pi-web 默认 10 分钟空闲就把会话整个关掉**
 *  （`PI_WEB_IDLE_TIMEOUT_MS`，默认 600000）。会话进程一死，扩展和它的 WebSocket 一起消失，
 *  网关那边就是「过一段时间这个 client 掉线了」。这不是网络/NAT，也不是 pi 本体的问题。
 *  pi-web 给了官方挂钩：扩展可以注册一个 `isActive()` 提供者，只要它返回 true，
 *  回收器就放过这个会话（README「Integration Hooks」/ 服务端注册表 `.../session-liveness/v1`）。
 *  我们钉住的条件是「连着网关、用户没 /wisp-offline」—— 这样微信随时来消息都有人接；
 *  真正不用的会话用 `/wisp-offline` 释放，pi-web 照旧能回收。 */
const LIVENESS_SYMBOL = Symbol.for('@agegr/pi-web/session-liveness/v1')

interface LivenessProvider {
  name: string
  sessionId: string
  sessionFile?: string
  isActive: () => boolean
}

/** 取 pi-web 的存活注册表；不在 pi-web 里（纯 CLI 跑 pi）就返回 null。
 *  **不自己造一个**：宿主那份是懒初始化的，造假对象会让它的 `list()` 等分支失效。 */
function livenessRegistry(): { register: (p: LivenessProvider) => () => void } | null {
  try {
    const reg = (globalThis as unknown as Record<symbol, any>)[LIVENESS_SYMBOL]
    if (reg && typeof reg === 'object' && reg.version === 1 && typeof reg.register === 'function') return reg
  } catch {
    // 老版本 pi-web / 非 pi-web：忽略
  }
  return null
}

/** 配置里的 `agent_id_per_session` → 模式（兼容 true/false 与字符串） */
function parseAgentIdMode(raw: Record<string, unknown>): AgentIdMode {
  const get = (k: string) => raw[k] ?? raw[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())]
  const v = get('agent_id_per_session') ?? get('agent_id_mode')
  if (v === true) return 'dir'
  if (v === false || v === undefined || v === null) return 'off'
  const t = String(v).trim().toLowerCase()
  if (t === 'session' || t === 'per-session' || t === 'persession') return 'session'
  if (t === 'dir' || t === 'directory' || t === 'per-dir') return 'dir'
  if (t === 'off' || t === 'none' || t === 'false' || t === '0') return 'off'
  return 'off'
}


/** task 帧里的入站媒体（网关已解密落盘；url 是网关相对路径） */
interface GwMedia {
  kind: string // image | file
  id: string
  name: string
  mime: string
  size: number
  url: string
}

interface GwTask {
  deliveryId: string
  account: string
  /** 账号显示名（v3.34）：一对一模型里「账号就是对方」，注入标签用它（没有就退回 openid 前缀） */
  accountName?: string
  wxUser: string
  text: string
  systemPrompt: string | null
  media: GwMedia[]
  /** 微信侧 /model 给本 agent 选的模型：{provider, model, label}；无则 null（沿用会话默认） */
  model: Record<string, unknown> | null
}

/** 网关连接配置（v3.5 起是 TOML）：**全局唯一一份**，含 token → 0600、不进 git。
 *  字段用 snake_case：url / token / agent_id / agent_id_per_session / auto_connect（手写 camelCase 也认）。 */
const CONFIG_PATH = join(homedir(), '.wisp-gateway.toml')
/** 旧版 JSON 配置：首次读到就自动迁移成 TOML（原文件改名 .bak 保留，不删） */
const LEGACY_CONFIG_PATH = join(homedir(), '.wisp-gateway.json')
const SESSIONS_DIR = join(homedir(), '.pi', 'agent', 'sessions')
/** 微信发来的文件落到工作区这个子目录（与 pi-wechat-assistant 同名，便于互相找） */
const WECHAT_FILES_SUBDIR = '.pi-wechat-files'
/** 注入模型前的媒体上限（与网关侧落盘上限一致；超限只记一行提示，不注入） */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024
const FILE_MAX_BYTES = 50 * 1024 * 1024
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000
const PREVIEW_LIMIT = 60
/** 进度心跳间隔：任务在跑时多久至少报一次（gateway 侧 /task 靠它答缓存） */
const PROGRESS_HEARTBEAT_MS = 10_000

/** 客户端日志（v3.21）：`~/.wisp-client.log`。
 *
 *  为什么非要有它：任务到底收没收到、回复有没有发出去、为什么被踢下线，
 *  在这之前**全无线索** —— 线上排「网关一直说 home-marci 还在处理、但 pi 这边没动静」时，
 *  网关侧只能看到「投递成功」，agent 侧什么都看不到，只能猜。 */
const CLIENT_LOG_PATH = join(homedir(), '.wisp-client.log')
const LOG_MAX_BYTES = 512 * 1024
let logOff = false
/** 日志带 agent id：~/.wisp-client.log 是**全机共享**的（所有 pi 会话写同一个文件），
 *  不带 id 就没法分清「哪条 closed 是哪个会话的」—— 排查某台机器「一直掉线」时就踩过这个坑 */
let logAgentPrefix = ''
function logLine(msg: string): void {
  if (logOff) return
  const who = logAgentPrefix
  try {
    if (existsSync(CLIENT_LOG_PATH) && statSync(CLIENT_LOG_PATH).size > LOG_MAX_BYTES) {
      // 只截掉前半（保留最近的），别让日志无限长大
      const buf = readFileSync(CLIENT_LOG_PATH)
      writeFileSync(CLIENT_LOG_PATH, buf.subarray(buf.byteLength - LOG_MAX_BYTES / 2))
    }
    appendFileSync(CLIENT_LOG_PATH, `${new Date().toISOString()} ${who}${msg}\n`)
  } catch {
    logOff = true // 目录只读/无权限：静默停掉，绝不影响主流程
  }
}
/** 两次「工具变化」上报之间的最小间隔，避免一个长任务里刷几十条 status */
const PROGRESS_MIN_GAP_MS = 2_000
/** 工具入参摘要的最大长度（超长截断；detail 会落库并可能推到微信） */
const TOOL_DETAIL_LIMIT = 80
/** 摘要里的敏感值：`token=xxx` / `api_key: xxx` / `Authorization: Bearer x` / `--password xxx` → ***
 *
 *  每个分支都把「要保留的前缀」放进捕获组（前导分隔符 + 键名与分隔符），值统一替换成 ***。
 *  这样切点由正则决定，不用事后猜「分隔符在第几个字符」—— 猜的写法在两个地方翻过车：
 *  ① `Bearer abc:def` 会被当成 key=value 截在 `abc:` → 只脱掉 def，abc 泄漏；
 *  ② 用 `(?:[A-Za-z][\w.-]*\s+)?` 表示「可选 scheme 词」会贪婪吃掉「值 + 空格」，
 *     于是 `api_key=sk-xxx model=gpt` 里的 `model=gpt` 被当成值一起脱掉。
 *  所以 scheme 词只允许白名单里的几个（bearer/basic/token/digest）。
 */
const SECRET_RE = new RegExp(
  [
    // key=value / key: value。键名必须以敏感词**结尾**（`tokenizer=`、`passwordless` 不算）。
    // 值允许被引号包裹 —— `api_key="sk-xxx"`、`token='abc'` 是 shell/JSON 里最常见的写法，
    // 值字符类若不允许引号，整条分支会失配（**完全不脱敏**）。
    '(^|[\\s,;&|"\'])((?:--?)?[\\w-]*(?:token|secret|password|passwd|api[_-]?key)(?![\\w-])\\s*[=:]\\s*)(?:(?:bearer|basic|token|digest)\\s+)?(?:"[^"]*"|\'[^\']*\'|[^\\s,;&|"\']+)',
    // Authorization: <scheme> <值>
    '(^|[\\s,;&|"\'])(authorization\\s*[:=]\\s*)(?:(?:bearer|basic|token|digest)\\s+)?(?:"[^"]*"|\'[^\']*\'|[^\\s,;&|"\']+)',
    // Bearer <值>
    '(^|[\\s,;&|"\'])(bearer\\s+)(?:"[^"]*"|\'[^\']*\'|[^\\s,;&|"\']+)',
    // --password xxx（空格分隔的 CLI 写法）；值同样可能是引号包裹的（可含空格）
    '(^|[\\s,;&|"\'])((?:--?)[\\w-]*(?:token|secret|password|passwd|api[_-]?key)(?![\\w-])\\s+)(?:"[^"]*"|\'[^\']*\'|\\S+)'
  ].join('|'),
  'gi'
)

function redactSecrets(s: string): string {
  return s.replace(SECRET_RE, (...args: any[]) => {
    // 分支顺序 = 组顺序（每分支 2 组：前导分隔符、要保留的前缀），找第一个非空的即可
    // 组数 = 分支数 × 2（前导分隔符 + 要保留的前缀）；末尾两个参数是 offset 与整个字符串
    const groups = args.slice(1, args.length - 2) as Array<string | undefined>
    for (let i = 0; i < groups.length; i += 2) {
      if (groups[i + 1] !== undefined) return `${groups[i] ?? ''}${groups[i + 1]}***`
    }
    return '***'
  })
}

export default function gatewayClientExtension(pi: ExtensionAPI): void {
  try {
    const c0 = loadConfig()
    if (c0) logAgentPrefix = `[${effectiveAgentId(c0)}] `
  } catch {
    /* 配置没就绪时先不带前缀，connect 成功后会有 */
  }
  let ws: WebSocket | null = null
  let running = false
  let agentIdle = true
  let latestContext: ExtensionContext | ExtensionCommandContext | null = null
  /** 本实例**最后一次确认过**的工作区目录名（sticky）。
   *
   *  踩过（2026-11-16）：pi-web 里边连上边有会话，过一阵 `ctx.cwd` 就可能给不出值、
   *  `PI_SESSION_FILE` 也未必带着 → `cwdSource()` 变 null → `connect()` 的 wait-cwd 闸门
   *  直接把重连挡死，客户端从此**永久静默离线**（日志里 1000+ 行 wait-cwd / self-heal）。
   *  目录一旦确定过就不该再丢：宁可复用上一次的目录（同一个会话不会换工作区），
   *  也别为了「怕算错 id」拒绝重连 —— 算错的风险是顶替，不连的风险是彻底失联。 */
  let stickyDir: string | null = null

  // ---------- pi-web 会话存活钉（keep-alive）----------
  // 详见 `LIVENESS_SYMBOL` 的注释：pi-web 默认 10 分钟空闲回收会话，
  // 回收 = 这个会话的 WebSocket 也一起没了 = 网关看见「掉线」。
  let keepAliveWanted = true
  let releaseLiveness: (() => void) | null = null

  /** 与「该不该被 pi-web 回收」对齐：自动连 + keep_alive（默认都开）且用户没叫停 */
  function syncLiveness(): void {
    try {
      if (disposed || standDown || !keepAliveWanted) {
        if (releaseLiveness) {
          releaseLiveness()
          releaseLiveness = null
          logLine('keep-alive: 已释放 pi-web 存活钉（会话可以按空闲回收）')
        }
        return
      }
      if (releaseLiveness) return
      const sid = sessionIdOf() || process.env.PI_SESSION_ID || ''
      if (!sid) return // 会话 id 还没就绪，下一次 sync（self-heal / session_start）再来
      const reg = livenessRegistry()
      if (!reg) return // 不在 pi-web 里（纯 CLI），无需钉
      const sf = process.env.PI_SESSION_FILE
      releaseLiveness = reg.register({
        name: 'wisp-gateway',
        sessionId: sid,
        ...(sf ? { sessionFile: sf } : {}),
        // ★ 每次回收检查都会调它：只读闭包变量，不碰文件/网络
        isActive: () => !disposed && !standDown && keepAliveWanted
      })
      logLine(`keep-alive: 已向 pi-web 注册存活钉（session …${sid.slice(-8)}），空闲不回收`)
    } catch {
      // pi-web 版本变了/接口不兼容：静默降级（回到「有 10 分钟空闲回收」的老行为）
    }
  }

  const inbound: GwTask[] = []
  let pendingInjection: GwTask | null = null
  let activeTask: GwTask | null = null

  // ---------- 配置 ----------

  /** 旧 JSON 已迁移的提示（只提示一次） */
  let migratedFrom: string | null = null

  /** 取第一个存在的键（TOML 里认 snake_case，也认老的 camelCase —— 免得照旧文档手写后静默失配） */
  function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
    for (const k of keys) {
      if (raw[k] !== undefined) return raw[k]
    }
    return undefined
  }

  function asString(v: unknown): string {
    return typeof v === 'string' ? v.trim() : ''
  }

  /** 任意来源的配置对象 → 内部结构（缺 url/token/agent_id 就当没配置） */
  function normalizeConfig(raw: Record<string, unknown>): GatewayConfig | null {
    const url = asString(pick(raw, 'url'))
    const token = asString(pick(raw, 'token'))
    const agentId = asString(pick(raw, 'agent_id', 'agentId'))
    if (!url || !token || !agentId) return null
    return {
      url,
      token,
      agentId,
      agentIdMode: parseAgentIdMode(raw),
      autoConnect: pick(raw, 'auto_connect', 'autoConnect') !== false,
      keepAlive: pick(raw, 'keep_alive', 'keepAlive') !== false
    }
  }

  /** 读配置：没有 TOML 就看有没有旧的 JSON，有就顺手迁过来（只做一次） */
  function loadConfig(): GatewayConfig | null {
    try {
      if (existsSync(CONFIG_PATH)) {
        const raw = parseToml(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>
        return normalizeConfig(raw)
      }
      return migrateLegacyConfig()
    } catch (e) {
      notify(`读取配置失败（${CONFIG_PATH}）：${(e as Error).message}`, 'warning')
      return null
    }
  }

  /** 旧 ~/.wisp-gateway.json → ~/.wisp-gateway.toml（原文件留 .bak） */
  function migrateLegacyConfig(): GatewayConfig | null {
    if (!existsSync(LEGACY_CONFIG_PATH)) return null
    try {
      const raw = JSON.parse(readFileSync(LEGACY_CONFIG_PATH, 'utf-8')) as Record<string, unknown>
      const cfg = normalizeConfig(raw)
      if (!cfg) return null
      saveConfig(cfg)
      renameSync(LEGACY_CONFIG_PATH, `${LEGACY_CONFIG_PATH}.bak`)
      migratedFrom = LEGACY_CONFIG_PATH
      return cfg
    } catch (e) {
      notify(`迁移旧配置失败（${LEGACY_CONFIG_PATH}）：${(e as Error).message}`, 'warning')
      return null
    }
  }

  function saveConfig(cfg: GatewayConfig): void {
    // JSON 的字符串转义就是合法的 TOML 基础字符串（双引号/反斜杠/\n/\uXXXX 同一套）
    const q = (v: string) => JSON.stringify(v)
    const lines = [
      '# wisp gateway 连接配置（wisp-client 扩展读这一份）',
      '# 改完在 pi 里执行 /wisp-reload 重新读取并重连；含 token，不要提交到 git。',
      `url = ${q(cfg.url)}`,
      `token = ${q(cfg.token)}`,
      `agent_id = ${q(cfg.agentId)}`,
      // 写成字符串三态；`off` 时也写出来，省得用户猜默认值
      `agent_id_per_session = ${q(cfg.agentIdMode)}`,
      `auto_connect = ${cfg.autoConnect !== false}`,
      `keep_alive = ${cfg.keepAlive !== false}`,
      ''
    ]
    writeFileSync(CONFIG_PATH, lines.join('\n'), { mode: 0o600 })
  }

  /** token 掩码（回显用；明文别打到状态栏/日志里） */
  function maskSecret(v: string): string {
    if (!v) return '****'
    return v.length <= 8 ? '****' : `${v.slice(0, 4)}****${v.slice(-4)}`
  }

  /** 装了配置就自动连（`auto_connect = false` 除外；已在连接/已连接时不重复） */
  function maybeAutoConnect(): void {
    const cfg = loadConfig()
    if (cfg) keepAliveWanted = cfg.keepAlive !== false && cfg.autoConnect !== false
    syncLiveness()
    if (!cfg || cfg.autoConnect === false || running) return
    connect(cfg, true)
  }

  /** 实际用于 hello 的 agentId。
   *
   *  gateway 对同一 agent_id **只保留一条连接**（后连的顶替前一个，给旧连接发 kick），
   *  所以身份粒度决定了能同时在线几个会话：
   *  - `off`：全局一个 id（多开必互踢）；
   *  - `dir`：带目录名（同目录的多个会话仍互踢）；
   *  - `session`：再带**短会话 id** —— 同目录多会话各自独立，互不顶替。
   *
   *  ★ 会话 id 必须**跨重启稳定**：微信侧绑定记的是 agent_id，重启后 id 变了就等于失联。
   *    `ctx.sessionManager.getSessionId()` 是 pi 自己持久化的，`--continue`/重启都不变。 */
  function effectiveAgentId(cfg: GatewayConfig): string {
    if (cfg.agentIdMode === 'off') return cfg.agentId
    const src = cwdSource()
    // 到这里还拿不到来源时（极端情况）才退回进程 cwd，并留下明显的日志线索
    const dir = (src ? src.dir : basename(process.cwd())).replace(/[^\w.-]/g, '-') || 'root'
    if (cfg.agentIdMode === 'dir') return `${cfg.agentId}-${dir}`
    const sid = shortSessionId()
    return sid ? `${cfg.agentId}-${dir}-${sid}` : `${cfg.agentId}-${dir}-p${process.pid}`
  }

  /** 本会话的完整 id（没有上下文时返回 ''） */
  function sessionIdOf(): string {
    try {
      const id = latestContext?.sessionManager?.getSessionId?.()
      return typeof id === 'string' ? id : ''
    } catch {
      return ''
    }
  }

  /** 会话短 id：取 uuid 的**最后**一段前 4 位。
   *
   *  为什么不用开头：pi 的 session id 是 uuid v7（时间前缀），同一分钟开的两个会话前 4 位
   *  很可能一样 → 又撞成一个 agent_id。尾部是随机段，短且足够区分。
   *  拿不到 sessionId 时退到 `PI_SESSION_FILE` 文件名里的 uuid 段。 */
  function shortSessionId(): string {
    const id = sessionIdOf()
    const src = id || sessionFileId()
    if (!src) return ''
    const clean = src.replace(/[^\w]/g, '')
    if (clean.length < 4) return ''
    return clean.slice(-4).toLowerCase()
  }

  /** `~/.pi/agent/sessions/--cwd--/<时间>_<uuid>.jsonl` → uuid */
  function sessionFileId(): string {
    const f = process.env.PI_SESSION_FILE
    if (!f) return ''
    const base = basename(f).replace(/\.jsonl$/i, '')
    const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
    return m ? m[1] : ''
  }

  /** 会话标题（pi 里可以给会话命名），给网关列表显示用 */
  function sessionTitleOf(): string {
    try {
      const t = latestContext?.sessionManager?.getSessionName?.()
      return typeof t === 'string' ? t.trim().slice(0, 60) : ''
    } catch {
      return ''
    }
  }

  /**
   * 算 agent id 用的工作区目录，以及它从哪来。
   *
   * ① 会话上下文（最准，`session_start`/`agent_start` 之后就有）；
   * ② `PI_SESSION_FILE` 的目录名 —— pi 把工作区编码进会话目录（`--C--ws-wisp--`），
   *    空闲会话还没上下文时靠它兜底（pi-web 里 `process.cwd()` 是**安装目录**，
   *    拿它当工作区会把所有会话算成同一个 id，2026-10-09 的踢来踢去就是这么来的）；
   * ③ 都没有 → null（宁可等，也别算错 id）。
   */
  function cwdSource(): { dir: string; from: 'session' | 'session-file' | 'sticky' } | null {
    const c = latestContext?.cwd
    if (typeof c === 'string' && c) {
      const dir = basename(c)
      if (dir) {
        stickyDir = dir
        return { dir, from: 'session' }
      }
    }
    const f = process.env.PI_SESSION_FILE
    if (f) {
      const parts = basename(dirname(f)).split('--').filter(Boolean)
      const ws = parts[parts.length - 1]
      if (ws) {
        stickyDir = ws
        return { dir: ws, from: 'session-file' }
      }
    }
    // ③ 本实例之前确认过的目录（sticky）—— 见 `stickyDir` 的注释
    if (stickyDir) return { dir: stickyDir, from: 'sticky' }
    return null
  }

  /** 会话上下文就绪了吗（有没有能用来源都算就绪，见 `cwdSource`） */
  function hasSessionCwd(): boolean {
    return cwdSource() !== null
  }

  /** wait-cwd 日志限流：上下文迟迟不就绪时，每 5 分钟最多记一条。
   *
   *  以前是**每次** connect/self-heal 都记 —— pi-web 里十来个会话同时没上下文时，
   *  14 分钟就写出 1000+ 行同样的日志，把真正有用的「closed/kick」全冲掉了。 */
  let lastWaitCwdLogAt = 0
  function noteWaitCwd(): void {
    const now = Date.now()
    if (now - lastWaitCwdLogAt < 5 * 60_000) return
    lastWaitCwdLogAt = now
    logLine(
      `wait-cwd: 会话上下文还没就绪，先不连（agent_id_per_session 算 id 要用会话工作区，用进程 cwd 会撞 id）`
    )
  }

  /** 底部状态栏（pi-web 也支持 setStatus）：连接 + agentId + 队列 + 进度 */
  function updateStatus(): void {
    const ctx = latestContext
    if (!ctx?.hasUI) return
    const cfg = loadConfig()
    const state = ws ? WebSocketStateLabel(ws.readyState) : 'offline'
    const icon = state === 'open' ? '✅' : state === 'connecting' ? '…' : '⏸'
    const bits: string[] = [`微信 ${icon} ${state}`]
    if (cfg) bits.push(effectiveAgentId(cfg))
    if (inbound.length) bits.push(`队列 ${inbound.length}`)
    if (activeTask) {
      bits.push(progress ? `第 ${progress.turn} 步${progress.tool ? ` · ${progress.tool}` : ''}` : '任务中')
    }
    ctx.ui.setStatus('gw', `[${bits.join(' | ')}]`)
  }

  function notify(message: string, level: NotificationLevel = 'info'): void {
    if (latestContext?.hasUI) {
      latestContext.ui.notify(message, level)
      return
    }
    const printer = level === 'error' ? console.error : console.log
    printer(`[gw-client/${level}] ${message}`)
  }

  // ---------- WS 连接 ----------

  function sendFrame(obj: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj))
      return
    }
    // 以前这里静默丢弃 —— 回复帧就这么消失了，gateway 那边任务永远是「进行中」。
    const o = obj as { type?: string; delivery_id?: string }
    logLine(`drop ${o?.type} ${String(o?.delivery_id ?? '').slice(0, 8)}（socket 未连接）`)
  }

  /** 已终结的 delivery_id → 那一帧（幂等 + 断线补发）。
   *
   *  修两个真实故障：
   *  1. 回复帧在 socket 断开时被丢掉 → gateway 永远等不到终结帧，微信端被「还在处理」刷屏；
   *  2. gateway 重投同一 delivery_id（resume / 排队补投）→ 客户端会**重跑**一遍任务，
   *     用户收到两条不一致的回答。
   *  都不是理论：线上 home-marci 一整天反复上下线，任务卡了 31 分钟没人收尾（v3.21）。 */
  const answered = new Map<string, { frame: Record<string, unknown>; at: number }>()
  const ANSWER_KEEP = 200
  /** 断线期间要发的帧（重连后补发） */
  const outbox: Array<Record<string, unknown>> = []
  const OUTBOX_MAX = 50

  function rememberAnswer(frame: Record<string, unknown>): void {
    const id = String(frame.delivery_id ?? '')
    if (!id) return
    answered.set(id, { frame, at: Date.now() })
    while (answered.size > ANSWER_KEEP) {
      const oldest = answered.keys().next().value
      if (oldest === undefined) break
      answered.delete(oldest)
    }
  }

  /** 发终结帧（reply / error）：**永远不能默默丢**。断线就进 outbox，连上再补。 */
  function sendTerminal(frame: Record<string, unknown>): void {
    if (String(frame.delivery_id ?? '')) rememberAnswer(frame)
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame))
      logLine(`send ${frame.type} ${String(frame.delivery_id ?? '').slice(0, 8)} len=${String(frame.text ?? '').length}`)
      return
    }
    if (outbox.length < OUTBOX_MAX) outbox.push(frame)
    logLine(`queued ${frame.type} ${String(frame.delivery_id ?? '').slice(0, 8)}（socket 未连接，重连后补发）`)
    notify('gateway 未连接，回复先存着，连上就补发', 'warning')
  }

  function flushOutbox(): void {
    if (!outbox.length) return
    const n = outbox.length
    for (const f of outbox) sendFrame(f)
    outbox.length = 0
    logLine(`flushed ${n} 帧（重连补发）`)
  }

  /** 已取消但仍在跑的 delivery_id（agent_end 时丢弃其回复） */
  const cancelled = new Set<string>()
  /** 被 /abort 中止的任务：agent_end 抽不出正文时发「已中止」，而不是含糊的「没产出正文」 */
  const aborted = new Set<string>()

  // ---------- 任务进度（长任务可见性） ----------

  interface Progress {
    startedAt: number
    turn: number
    tool: string | null
    detail: string | null
    lastSentAt: number
    /** v3.22 自报：用户问的是什么（微信任务用注入文本，本地任务用 before_agent_start.prompt） */
    prompt: string | null
    /** AI 正在写的字（流式增量截尾）—— 只进内存并自报给网关展示，不落任何日志/库 */
    draft: string
    /** AI 正在**想**什么（thinking 增量截尾，v3.36/v3.43）。
     *  比 draft 信息量大得多（draft 往往只有半句话），但更长更乱 —— 网关侧只在用户**主动问状态**
     *  时用它，并且交给 AI 收成一句话，不直接甩给用户。同样只进内存 + 自报，不落日志/库。 */
    think: string
    /** **第一次**思考（一轮里第一个 thinking 块，截尾）：那是最能说明「它打算怎么做」的内容 */
    firstThink: string
    /** 第一个 thinking 块已经结束（后面的 thinking 不再进 firstThink） */
    firstThinkDone: boolean
    /** 当前工具的执行状态：executing / done / error（tool_call 只知道「要跑」） */
    toolState: string | null
    /** 卡在等人交互（ui_prompt_start）：kind = confirm/select/input/... */
    waiting: { kind: string; title: string } | null
    tokensIn: number
    tokensOut: number
    /** 本地任务（pi 里直接输入的，没有 delivery_id）—— 也要让网关看得见 */
    local: boolean
  }
  let progress: Progress | null = null
  /** 最近一次 before_agent_start 的用户输入（本地任务的自报内容来源） */
  let lastPrompt = ''

  /** 新建进度快照：**所有**创建点都走它，免得以后加字段漏在某一处。 */
  function newProgress(prompt: string | null, local: boolean): Progress {
    return {
      startedAt: Date.now(),
      turn: 0,
      tool: null,
      detail: null,
      lastSentAt: 0,
      prompt,
      draft: '',
      think: '',
      firstThink: '',
      firstThinkDone: false,
      toolState: null,
      waiting: null,
      tokensIn: 0,
      tokensOut: 0,
      local
    }
  }
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  /** 最近一次收到网关任何帧的时间（心跳看门狗用）。
   *  后台标签 setInterval 会被浏览器节流到 ≥1min，所以判活按时间戳不数 tick。 */
  let lastFrameAt = 0

  /** 心跳保活：welcome advertise 的 heartbeat_ms 此前两边都没真正实现 ——
   *  空闲连接被 NAT/代理掐掉后就变成「一段时间后就下线」。周期发 ping（网关回 pong
   *  刷新 lastFrameAt）；长时间没任何帧就主动断开，由 close 处理器按退避重连 ——
   *  半死连接不会触发 close，只能靠这个看门狗。 */
  function startKeepalive(heartbeatMs: number): void {
    stopKeepalive()
    lastFrameAt = Date.now()
    const every = Math.min(Math.max(heartbeatMs / 2, 10_000), 30_000)
    // 后台标签定时器可能被节流到 ~1min，stale 门槛要 ≥ 两个节流周期，避免误杀
    const staleMs = Math.max(heartbeatMs * 4, 120_000)
    keepaliveTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastFrameAt > staleMs) {
        logLine('心跳超时（>120s 没收到任何帧）→ 断开重连')
        notify('gateway 心跳超时，断开重连', 'warning')
        ws.close() // close 处理器会安排重连；半死连接靠这一步才检测得出来
        return
      }
      sendFrame({ type: 'ping' })
    }, every)
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }

  /** 工具入参摘要：按工具名取最有信息量的字段（截断 + 脱敏，别把整段代码/密钥塞进 status） */
  function summarizeToolInput(toolName: string, input: unknown): string | null {
    if (!input || typeof input !== 'object') return null
    const o = input as Record<string, unknown>
    // 每个工具取哪个字段最有信息量（命不中就落到下面的通用优先级）
    const preferred: Record<string, string[]> = {
      bash: ['command'],
      shell: ['command'],
      exec: ['command'],
      read: ['path', 'file_path'],
      write: ['path', 'file_path'],
      edit: ['path', 'file_path'],
      grep: ['pattern'],
      glob: ['pattern'],
      search: ['query'],
      web_search: ['query'],
      fetch: ['url'],
      http_fetch: ['url'],
      task: ['prompt'],
      agent: ['prompt']
    }
    const byName = (preferred[toolName.toLowerCase()] ?? [])
      .map((k) => o[k])
      .find((v) => typeof v === 'string' && v.trim())
    const pick =
      byName ?? o.command ?? o.path ?? o.file_path ?? o.pattern ?? o.query ?? o.url ?? o.name ?? o.prompt
    if (typeof pick !== 'string' || !pick.trim()) return null
    const one = redactSecrets(pick).replace(/\s+/g, ' ').trim()
    return one.length > TOOL_DETAIL_LIMIT ? `${one.slice(0, TOOL_DETAIL_LIMIT - 1)}…` : one
  }

  function statusFrame(): Record<string, unknown> | null {
    const task = activeTask
    if (!task || !progress) return null
    return {
      type: 'status',
      delivery_id: task.deliveryId,
      phase: 'running',
      turn: progress.turn,
      ...(progress.tool ? { tool: progress.tool } : {}),
      ...(progress.detail ? { detail: progress.detail } : {}),
      elapsed_ms: Date.now() - progress.startedAt
    }
  }

  /** 上报进度（没有进行中的任务就什么都不发）。`force` = 忽略最小间隔（probe/心跳用） */
  function sendProgress(force = false): void {
    if (!progress || !activeTask) return
    const now = Date.now()
    if (!force && now - progress.lastSentAt < PROGRESS_MIN_GAP_MS) return
    const frame = statusFrame()
    if (!frame) return
    progress.lastSentAt = now
    sendFrame(frame)
  }

  function startProgressHeartbeat(): void {
    stopProgressHeartbeat()
    heartbeat = setInterval(() => sendProgress(true), PROGRESS_HEARTBEAT_MS)
  }

  /** 只清定时器（不碰 progress）—— progress 的生命周期由 agent_start / clearProgress 管 */
  function stopProgressHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  /** 停表并丢弃进度（任务结束/断线/关闭会话时调用） */
  function clearProgress(): void {
    stopProgressHeartbeat()
    progress = null
  }

  // ---------- v3.22 自报（report）：让 gateway 知道「我手上有什么、此刻在干什么」 ----------
  //
  // 两件事：① 网关侧幽灵任务判定靠 `held`（我声称还欠着的 delivery_id 集合）；
  // ② WebUI / 微信 /task 靠 `running` 显示「在问什么、正在写什么、卡在哪」。
  // 空闲也照发 —— 网关得先知道「我不忙」才能判幽灵。

  const REPORT_EVERY_MS = 10_000
  let reportTimer: ReturnType<typeof setInterval> | null = null
  let reportLastSentAt = 0

  /** 我手上所有还没被网关确认终结的任务：在跑 + 待注入 + 排队 + outbox 里没送出去的终结帧 */
  function heldIds(): string[] {
    const ids = new Set<string>()
    if (activeTask) ids.add(activeTask.deliveryId)
    if (pendingInjection) ids.add(pendingInjection.deliveryId)
    for (const t of inbound) ids.add(t.deliveryId)
    for (const f of outbox) {
      const id = String((f as { delivery_id?: unknown }).delivery_id ?? '')
      if (id) ids.add(id)
    }
    return [...ids]
  }

  /** 上下文占用百分比（pi 自己算的），拿不到就 null */
  function contextPct(): number | null {
    try {
      const u = latestContext?.getContextUsage()
      return u && typeof u.percent === 'number' ? Math.round(u.percent) : null
    } catch {
      return null
    }
  }

  function reportFrame(): Record<string, unknown> {
    const p = progress
    const pct = contextPct()
    const running = p
      ? {
          // 本地任务没有 delivery_id：网关侧只当「它在忙」，不参与幽灵判定
          ...(activeTask ? { delivery_id: activeTask.deliveryId } : {}),
          ...(p.prompt ? { prompt: p.prompt.slice(0, 300) } : {}),
          ...(p.draft ? { draft: p.draft.slice(-200) } : {}),
          // thinking 比 draft 长，多给一点（网关侧 AI 收口，不直接给用户）
          ...(p.think ? { think: p.think.slice(-400) } : {}),
          // 第一次思考：网关的状态摘要优先用它 —— 那是「计划」，后面的多半是细节
          ...(p.firstThink ? { first_think: p.firstThink.slice(-400) } : {}),
          turn: p.turn,
          ...(p.tool ? { tool: p.tool } : {}),
          ...(p.toolState ? { tool_state: p.toolState } : {}),
          ...(p.waiting
            ? { waiting: { kind: p.waiting.kind, title: p.waiting.title.slice(0, 120) } }
            : {}),
          ...(p.tokensIn || p.tokensOut ? { tokens_in: p.tokensIn, tokens_out: p.tokensOut } : {}),
          elapsed_ms: Date.now() - p.startedAt,
          ...(pct === null ? {} : { context_pct: pct })
        }
      : null
    const m = latestContext?.model
    return {
      type: 'report',
      held: heldIds(),
      ...(running ? { running } : {}),
      ...(m ? { model: { provider: m.provider, model: m.id } } : {}),
      queue: inbound.length,
      idle: agentIdle && !activeTask && !pendingInjection
    }
  }

  /** 自报一次（1 秒节流；force 忽略节流）。连不上就静默丢掉 —— 自报是尽力而为。 */
  function sendReport(force = false): void {
    if (!running || !ws || ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (!force && now - reportLastSentAt < 1000) return
    reportLastSentAt = now
    sendFrame(reportFrame())
  }

  function startReport(): void {
    stopReport()
    sendReport(true)
    reportTimer = setInterval(() => sendReport(true), REPORT_EVERY_MS)
  }

  function stopReport(): void {
    if (reportTimer) clearInterval(reportTimer)
    reportTimer = null
  }

  /** 注入卡死看门狗（v3.27）：pendingInjection 从什么时候开始、能忍多久没跑起来。
   *  没有它的话「注入失败」会让整个状态机永久停摆（见文件头注释的实测）。 */
  let pendingSince = 0
  let pendingGraceMs = 20_000

  /** 会话是否真的空闲（`isIdle()` 是 SDK 的权威判断，比我们自己的 agentIdle 准：
   *  agent_end 处理器执行期间 run 还没结束，我们自己以为空闲了、SDK 说没有）。 */
  function sessionIdle(): boolean {
    try {
      const fn = latestContext?.isIdle
      return typeof fn === 'function' ? Boolean(fn.call(latestContext)) : true
    } catch {
      return true // 拿不到就当空闲（老运行时不支持时别把任务卡住）
    }
  }

  /** 等会话真正空闲（最多 `maxMs`）；返回是否等到了 */
  async function waitIdle(maxMs: number): Promise<boolean> {
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
      if (sessionIdle()) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  /** 连接代次：每次 connect 递增。旧 socket 的 close 回调靠它判断「我已经过气了」，
   *  否则重登时旧连接会把**新连接**的状态清空，还会再建出第三条连接。 */
  let connSeq = 0
  /** 丢弃所有进行中的桥接状态（断线/下线时调用，避免任务卡在已 ack 状态） */
  function resetBridgeState(): void {
    stopKeepalive()
    stopReport()
    cancelled.clear()
    aborted.clear()
    inbound.length = 0
    activeTask = null
    pendingInjection = null
    pendingSince = 0
    agentIdle = true
    clearProgress()
  }

  /** URL 回显掩码：只留 scheme+host+path，userinfo 与查询串一律隐藏 */
function maskUrl(url?: string): string {
  if (!url) return '-'
  try {
    const u = new URL(url)
    const auth = u.username || u.password ? '***@' : ''
    return `${u.protocol}//${auth}${u.host}${u.pathname}`
  } catch {
    return url.replace(/\?.*$/, '?***').replace(/\/\/[^@/]*@/, '//***@')
  }
}

  /** 用户/网关明确要求「本机别再连了」：被顶替(kick)、token 被拒(denied)、/wisp-offline。
   *  只有 /wisp-login、/wisp-reload 或重新加载会清掉它 —— 别的路径一律不再自动重连。 */
  let standDown = false
  /** 卡死看门狗：每 5s 看一眼「注入进去的任务是不是一直没跑起来」 */
  let injectWatchdogTimer: ReturnType<typeof setInterval> | null = null

  /** 本实例是否已作废（`session_shutdown` = 会话换了新实例）。
   *  ★ **所有定时器都必须看它**：旧实例的看门狗不清掉会继续重连，
   *  和新实例抢同一个 agent_id → 线上表现就是反复上下线的踢来踢去（2026-10-09 实测）。 */
  let disposed = false

  /** 停掉本实例的所有定时器（shutdown 时一次性清干净，别再漏） */
  function disposeTimers(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    if (selfHealTimer) clearInterval(selfHealTimer)
    selfHealTimer = null
    if (injectWatchdogTimer) clearInterval(injectWatchdogTimer)
    injectWatchdogTimer = null
    stopKeepalive()
    stopReport()
  }

  /**
   * 注入卡死兜底（v3.27）：`pendingInjection` 超过宽限还在那儿，说明注入根本没生效
   * （SDK 吞了错误、我们无从得知）。这时必须：告诉网关这条终结了 + 松开队列，
   * 否则后续所有任务都会永久卡在队列里 —— 线上表现就是「收到任务从不回复、每分钟提醒还在处理」。
   */
  function startInjectWatchdog(): void {
    if (injectWatchdogTimer) return
    injectWatchdogTimer = setInterval(() => {
      if (disposed) return
      const task = pendingInjection
      if (!task || !pendingSince) return
      if (Date.now() - pendingSince < pendingGraceMs) return
      const secs = Math.round((Date.now() - pendingSince) / 1000)
      logLine(`stuck-inject: ${task.deliveryId.slice(0, 8)} 注入 ${secs}s 没跑起来 → 回报错误并松开队列`)
      pendingInjection = null
      pendingSince = 0
      sendTerminal({
        type: 'error',
        delivery_id: task.deliveryId,
        text: `没能把这条消息交给 pi（注入后 ${secs}s 没跑起来），请重发一次`
      })
      sendFrame({ type: 'typing', delivery_id: task.deliveryId, on: false })
      drainQueue()
    }, 5_000)
  }

  /** 自愈看门狗：每 30s 检查一次「该连却没连」 */
  let selfHealTimer: ReturnType<typeof setInterval> | null = null
  const SELF_HEAL_MS = 30_000

  /**
   * 自愈（v3.25）：**只要进程活着、用户没叫停，就一定会连回网关**。
   *
   * 为什么需要它：2026-10-09 实测「点插件更新 + 重新加载会话」后本会话再也连不上 ——
   * pi 的 reload 先发 `session_shutdown`（我们置 running=false 并关掉 socket），
   * 之后的 `session_start` 兜底没生效，客户端就永久静默（日志里一条都没有）。
   * 与其依赖宿主的事件顺序，不如让客户端自己收敛：没连上就再试。
   *
   * 只在「既没有活连接、也没有待重试定时器」时动手，避免和 connect/退避循环打架。
   */
  function startSelfHeal(): void {
    startInjectWatchdog()
    if (selfHealTimer) return
    selfHealTimer = setInterval(() => {
      if (disposed) return
      const cfg = loadConfig()
      // 定期对账存活钉：pi-web 注册表晚于扩展初始化也能补上
      keepAliveWanted = !!cfg && cfg.autoConnect !== false && cfg.keepAlive !== false
      syncLiveness()
      if (standDown) return
      if (!cfg || cfg.autoConnect === false) return
      if (running && (reconnectTimer || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)))) {
        return // 正常路径在处理，别插手
      }
      // 还拿不到工作区目录：等上下文就绪，别刷日志（以前每 30s 一条，一天几千行）
      if (cfg.agentIdMode !== 'off' && !hasSessionCwd()) {
        noteWaitCwd()
        return
      }
      // 僵尸 socket（readyState 既不是 OPEN 也不是 CONNECTING）先彻底丢掉，
      // 否则 connect() 的重复守卫和 close 事件都可能被它挡住
      if (ws) {
        logLine(`self-heal: 丢掉僵尸连接（readyState=${ws.readyState}）`)
        try {
          ws.close()
        } catch {
          // 已经关了就算了
        }
        ws = null
        resetBridgeState()
      }
      logLine('self-heal: 未连接（无活连接也无重试定时器），主动重连')
      connect(cfg, true)
    }, SELF_HEAL_MS)
  }

function connect(cfg: GatewayConfig, quiet = false): void {
    if (disposed) return // 实例已作废（会话换新了）：绝不建连，否则抢新实例的 agent_id
    // ★ 会话上下文还没就绪时**绝不连接**（v3.26）：per-session 模式下 agentId 由会话工作区
    //   算出来，退回 process.cwd() 会算出错的 id —— pi-web 里 pi 跑在服务端进程内，
    //   process.cwd() 的 basename 是 "pi-web"，于是所有会话都叫 `<agent_id>-pi-web` 互相顶替
    //   （2026-10-09 那条永不停止的 kick 风暴就是这么来的）。等 session_start 或自愈再看。
    if (cfg.agentIdMode !== 'off' && !hasSessionCwd()) {
      noteWaitCwd()
      return
    }
    // 已在连接中/已连接就不重复建连（重复 connect 会漏掉旧 socket 的 close，导致双连接）
    if (running && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      if (!quiet) notify('gateway 已连接，忽略重复连接请求', 'warning')
      return
    }
    running = true
    let backoff = RECONNECT_BASE_MS
    const seq = ++connSeq // 本次连接属于哪一代

    const openOnce = (): void => {
      if (!running || seq !== connSeq) return
      notify(`连接 gateway：${cfg.url}`, 'info')
      const sock = new WebSocket(cfg.url)
      ws = sock

      sock.addEventListener('open', () => {
        backoff = RECONNECT_BASE_MS
        reconnectTimer = null
        logAgentPrefix = `[${effectiveAgentId(cfg)}] `
        logLine(`connected ${maskUrl(cfg.url)} agent=${effectiveAgentId(cfg)}`)
        sendFrame({
          type: 'hello',
          agent_id: effectiveAgentId(cfg),
          token: cfg.token,
          meta: {
            hostname: hostnameSafe(),
            cwd: latestContext?.cwd ?? process.cwd(),
            cwd_source: cwdSource()?.from ?? 'process',
            node: process.version,
            // v0.2：网关侧按 dir 归组、按 title 显示 —— 同目录多会话才分得清谁是谁
            dir: cwdSource()?.dir ?? '',
            session_id: sessionIdOf(),
            session_title: sessionTitleOf(),
            agent_id_mode: cfg.agentIdMode
          }
        })
        updateStatus()
      })

      sock.addEventListener('message', (ev: MessageEvent) => {
        lastFrameAt = Date.now() // 任何帧（含 pong）都算活跃
        let v: any
        try {
          v = JSON.parse(String(ev.data))
        } catch {
          return
        }
        handleFrame(v)
      })

      sock.addEventListener('close', (ev: CloseEvent) => {
        // 旧代次的 close 什么都不做：不能清新连接的状态，也不能再建一条连接
        if (seq !== connSeq) return
        logLine(
          `closed code=${ev?.code ?? 0} reason=${ev?.reason || '-'} url=${maskUrl(cfg.url)}（重连退避 ${backoff}ms）`
        )
        if (ws === sock) ws = null
        // 连接断了任务没法回报，全部丢弃 —— 等 gateway 的 resume 重投 / 超时兜底
        resetBridgeState()
        updateStatus()
        if (!running) return
        reconnectTimer = setTimeout(openOnce, backoff)
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
      })

      sock.addEventListener('error', () => {
        // close 会跟着触发，重连逻辑在 close 里
        logLine('socket error')
      })
    }

    openOnce()
  }

  /** 网关下发的控制帧（v3.22）：从微信/WebUI 遥控这个 pi 会话。
   *
   *  每个 op 都回一帧 ctl_result（微信侧据此给「到底成没成」），然后立刻自报一次
   *  （状态可能刚变了：中止/切模型/压缩都会影响 report）。 */
  async function handleCtl(v: any): Promise<void> {
    const id = String(v?.id ?? '')
    const op = String(v?.op ?? '')
    const args = (v?.args && typeof v.args === 'object' ? v.args : {}) as Record<string, unknown>
    let ok = false
    let detail = ''
    const ctx = latestContext
    try {
      switch (op) {
        case 'say': {
          const text = String(args.text ?? '')
          const mode = args.mode === 'followUp' ? 'followUp' : 'steer'
          if (!text.trim()) {
            detail = '空内容'
            break
          }
          // 来源标签（v3.33）：网关在 ctl 帧里带 peer，注入时拼成 `[微信:xxx]`——
          // 与任务投递那条一致（AGENTS.md 要求注入消息带来源，扩展不得假设自己只服务一个会话）。
          // 老网关不带 peer → 不拼（宁可没有，也不拼个假的）。
          const peer = (v?.peer && typeof v.peer === 'object' ? v.peer : {}) as {
            account?: unknown
            account_name?: unknown
            wx_user?: unknown
          }
          const wx = typeof peer.wx_user === 'string' ? peer.wx_user : ''
          const name = typeof peer.account_name === 'string' ? peer.account_name.trim() : ''
          const label = name || (wx ? shortPeer(wx) : '')
          const body = label ? `[微信:${label}]\n${text}` : text
          // steer = 立刻插话引导当前轮；followUp = 等这轮跑完再排上
          pi.sendUserMessage(body, { deliverAs: mode })
          ok = true
          detail = mode === 'steer' ? '已插话（会引导当前这轮）' : '已排队，等这轮跑完'
          logLine(`ctl say mode=${mode} len=${text.length} peer=${wx ? 'yes' : 'no'}`)
          break
        }
        case 'abort': {
          if (!ctx) {
            detail = '没有可用上下文'
            break
          }
          if (ctx.isIdle()) {
            ok = true
            detail = '本来就没在跑'
            break
          }
          if (activeTask) aborted.add(activeTask.deliveryId)
          ctx.abort()
          ok = true
          detail = '已中止当前运行'
          logLine('ctl abort')
          break
        }
        case 'compact': {
          if (!ctx) {
            detail = '没有可用上下文'
            break
          }
          const before = contextPct()
          const ins = typeof args.instructions === 'string' ? args.instructions.trim() : ''
          ctx.compact({
            ...(ins ? { customInstructions: ins } : {}),
            onComplete: () => {
              logLine('compact 完成')
              notify('会话已压缩', 'info')
              sendReport(true)
            },
            onError: (e: Error) => {
              logLine(`compact 失败：${e.message}`)
              notify(`压缩失败：${e.message}`, 'warning')
            }
          })
          ok = true
          detail = before === null ? '已触发压缩' : `已触发压缩（压缩前上下文 ${before}%）`
          logLine('ctl compact')
          break
        }
        case 'model': {
          const reg = ctx?.modelRegistry
          const provider = String(args.provider ?? '')
          const mid = String(args.model ?? '')
          if (!reg) {
            detail = '本机没有模型注册表'
            break
          }
          const m = provider && mid ? reg.find(provider, mid) : undefined
          if (!m) {
            detail = `本机注册表里没有 ${provider}/${mid}`
            break
          }
          ok = await pi.setModel(m)
          detail = ok ? `${provider}/${mid} 已生效` : `${provider}/${mid} 切换被拒绝（可能没配 API key）`
          logLine(`ctl model ${provider}/${mid} ok=${ok}`)
          break
        }
        case 'status': {
          sendReport(true)
          ok = true
          detail = '已回报当前状态'
          break
        }
        default:
          detail = `不认识的 op：${op}`
      }
    } catch (e) {
      ok = false
      detail = `执行失败：${(e as Error).message}`
      logLine(`ctl ${op} 失败：${(e as Error).message}`)
    }
    sendFrame({ type: 'ctl_result', id, op, ok, detail })
    sendReport(true)
  }

  function handleFrame(v: any): void {
    switch (v?.type) {
      case 'welcome':
        // 断线时未终结的任务交给 gateway 的 resume 重投（重连时原样重发 payload）。
        // 注意：gateway 的 TTL 兜底只管 `queued`（补投失败）的任务，**sent/acked/running 没有终结器** ——
        // agent 一直不回来的话该 delivery 会停在非终态。这是有意的取舍：
        // 宁可挂着，也不要先发「任务未完成」、紧接着又被重投的真实回复打脸。
        sendFrame({ type: 'resume' })
        // resume 让 gateway 重投未终结任务，重投的 delivery_id 命中 answered 时会直接重发上次的
        // 终结帧（不重跑）；outbox 里则是断线期间没能发出去的回复。两边都幂等，顺序无所谓。
        flushOutbox()
        // v3.22：连上就自报（网关据此判幽灵任务 / WebUI 显示在忙什么）
        startReport()
        startKeepalive(typeof v.heartbeat_ms === 'number' && v.heartbeat_ms > 0 ? v.heartbeat_ms : 30_000)
        notify(`已连上 gateway（agent=${loadConfig() ? effectiveAgentId(loadConfig()!) : '?'}）`, 'info')
        // 上报本机可用模型（gateway 存库，微信 /models 列表 / /model 切换用）。
        // 重连也会在 welcome 后重发，覆盖旧的列表。
        sendFrame({ type: 'models', models: produceModels() })
        updateStatus()
        drainQueue()
        break
      case 'task': {
        const did = String(v.delivery_id ?? '')
        // 重投（resume / 排队补投）：把上次的终结帧再发一次，**不重跑** —— 重跑会多出一条
        // 不一样的回答，还白烧 token。
        const done = did ? answered.get(did) : undefined
        if (done) {
          logLine(`dup task ${did.slice(0, 8)}：重发上次的 ${String(done.frame.type)}，不重跑`)
          sendFrame(done.frame)
          break
        }
        // 同一 delivery_id 已在队列/已注入/正在跑：只 ack，不重复入队
        if (
          did &&
          (activeTask?.deliveryId === did ||
            pendingInjection?.deliveryId === did ||
            inbound.some((t) => t.deliveryId === did))
        ) {
          logLine(`dup task ${did.slice(0, 8)}：已在处理，忽略重复投递`)
          break
        }
        inbound.push({
          deliveryId: did || randomUUID(),
          account: String(v.account ?? ''),
          accountName: v.account_name === undefined || v.account_name === null ? undefined : String(v.account_name),
          wxUser: String(v.wx_user ?? ''),
          text: String(v.text ?? ''),
          systemPrompt: v.system_prompt ?? null,
          media: parseMedia(v.media),
          model: (v.model && typeof v.model === 'object' ? v.model : null) as Record<string, unknown> | null
        })
        // 只记标识与长度，不记正文（隐私）
        logLine(`task ${did.slice(0, 8)} from ${String(v.wx_user ?? '')} len=${String(v.text ?? '').length} media=${Array.isArray(v.media) ? v.media.length : 0}`)
        updateStatus()
        drainQueue()
        break
      }
      case 'cancel': {
        const id = String(v.delivery_id ?? '')
        const qi = inbound.findIndex((t) => t.deliveryId === id)
        if (qi >= 0) {
          const [t] = inbound.splice(qi, 1)
          sendTerminal({ type: 'error', delivery_id: id, text: '已取消（排队中）' })
          logLine(`cancel ${id.slice(0, 8)}（排队中）`)
          notify(`任务已取消：${preview(t.text)}`, 'info')
          break
        }
        // 已 ack、已注入但还没开始跑：必须发终结帧 + typing off，
        // 否则该 delivery 永远没有 reply/error，gateway 侧任务卡住、微信端 typing 常亮
        if (pendingInjection && pendingInjection.deliveryId === id) {
          const t = pendingInjection
          pendingInjection = null
          sendTerminal({ type: 'error', delivery_id: id, text: '已取消（注入后未开始）' })
          sendFrame({ type: 'typing', delivery_id: id, on: false })
          logLine(`cancel ${id.slice(0, 8)}（注入后未开始）`)
          notify(`任务已取消（已注入，结果不再回复）：${preview(t.text)}`, 'info')
          drainQueue()
          break
        }
        if (activeTask && activeTask.deliveryId === id) {
          cancelled.add(id)
          // 还要发一帧 error 作为终结帧：否则 gateway 侧任务永远停在进行中（本进程重启后更是无从补）
          sendTerminal({ type: 'error', delivery_id: id, text: '已取消（任务已中断）' })
          logLine(`cancel ${id.slice(0, 8)}（正在跑）`)
          notify(`任务已取消（正在跑，结果不再回复）：${preview(activeTask.text)}`, 'info')
        }
        // 正在跑的 agent loop 无法中断，gateway 侧也会忽略迟到回复
        break
      }
      case 'ctl':
        // v3.22 遥控：/say /abort /compact /model /status，回执走 ctl_result 帧
        void handleCtl(v)
        break
      case 'ping':
        sendFrame({ type: 'pong' })
        break
      case 'probe':
        // 带外查询：立刻回报一次进度，然后继续跑原来的任务（不注入、不打断）
        sendProgress(true)
        break
      case 'kick':
        // 同一 agent_id 被另一处连接顶替：本机**故意不再自动重连**，否则两台机器会互相顶成
        // 反复掉线（线上一台机器整天每几秒上下线一次就是这么来的）。
        // 代价是本机变成「静默离线」，所以这里必须把话说清楚、并写进日志。
        logLine(`kick: ${String(v.reason ?? '')}（本机停止连接，不再自动重连）`)
        standDown = true
        syncLiveness()
        notify(
          `被 gateway 踢下线（同一 agentId 已有别的连接）：${v.reason ?? ''}\n` +
            '本机已停止连接。要让本机接管，请改 agent_id（或开 agent_id_per_session）后重启会话。',
          'error'
        )
        running = false
        resetBridgeState()
        ws?.close()
        ws = null
        updateStatus()
        break
      case 'denied':
        // ★ denied 原本只 notify 不写日志，文件里完全静默 —— 查掉线时差点漏掉这条路径
        logLine(`denied: ${String(v.reason ?? '')}（token 校验失败/协议错；本机停止重连）`)
        standDown = true
        syncLiveness()
        notify(`gateway 拒绝连接：${v.reason ?? ''}（检查 ${CONFIG_PATH} 或执行 /wisp-login）`, 'error')
        running = false
        resetBridgeState()
        ws?.close()
        ws = null
        updateStatus()
        break
      default:
        break
    }
  }

  // ---------- 注入与回复 ----------

  function drainQueue(): void {
    if (!running || !ws || !agentIdle || pendingInjection || activeTask) return
    const next = inbound.shift()
    if (!next) return
    pendingInjection = next
    pendingSince = Date.now()
    // 等空闲过来的注入（idle 注入）20s 没跑起来就是卡了；用 followUp 排队的给 5 分钟
    // （会话可能正在跑一个很长的轮次，那不算卡）
    pendingGraceMs = 20_000
    sendFrame({ type: 'ack', delivery_id: next.deliveryId })
    sendFrame({ type: 'typing', delivery_id: next.deliveryId, on: true })
    updateStatus()
    // 取媒体是异步的（要 HTTP 拉网关上的图片/文件），不能阻塞这里 —— 状态机靠
    // pendingInjection 占位，drainQueue 在它清空之前不会再投下一条。
    void injectTask(next)
  }

  /** 把 task 变成注入 pi 的内容块：文本 + （拉取成功的）图片 + 落盘的文件路径。
   *
   *  媒体拉取失败绝不丢消息 —— 正文照发，失败项只降级成一行提示。 */
  /** 消息标签里的人名：openid 前缀（联系人/备注概念已删除）。
   *  不直接用裸 openid：里面的 `@im.wechat` 会被 pi-web 当邮箱渲染成 mailto 链接。 */
  function peerLabel(task: GwTask): string {
    // 优先用账号名（一对一：账号就是对方）——`[微信:账号名]` 比 `[微信:openid 前缀]` 有用得多；
    // 老网关不带 account_name、或账号没填名字时，退回 openid 前缀。
    const name = (task.accountName ?? '').trim()
    return name || shortPeer(task.wxUser, task.account || '?')
  }

  /** 微信用户 id → 短名字（标签用）。
   *  不直接用裸 openid：里面的 `@im.wechat` 会被 pi-web 当邮箱渲染成 mailto 链接。 */
  function shortPeer(wxUser: string, fallback = '?'): string {
    const short = wxUser.split('@')[0] ?? ''
    return short ? short.slice(0, 12) : fallback
  }

  async function injectTask(task: GwTask): Promise<void> {
    const label = `[微信:${peerLabel(task)}]`
    lastPeer = { account: task.account, wxUser: task.wxUser }
    const cfg = loadConfig()
    const notes: string[] = []
    const images: ContentBlock[] = []
    const origin = cfg ? httpOrigin(cfg.url) : null

    for (const m of task.media) {
      if (!cfg || !origin) {
        notes.push(`⚠️ 无法解析 gateway 地址，${m.name} 未获取`)
        continue
      }
      try {
        const res = await fetch(`${origin}${m.url}?token=${encodeURIComponent(cfg.token)}`, {
          signal: AbortSignal.timeout(60_000)
        })
        if (!res.ok) {
          notes.push(`⚠️ ${m.name} 拉取失败（HTTP ${res.status}）`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (m.kind === 'image') {
          if (buf.byteLength > IMAGE_MAX_BYTES) {
            notes.push(`⚠️ 图片 ${m.name} 超过 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB，未注入模型`)
            continue
          }
          images.push({ type: 'image', data: buf.toString('base64'), mimeType: m.mime || 'image/jpeg' })
        } else {
          if (buf.byteLength > FILE_MAX_BYTES) {
            notes.push(`⚠️ 文件 ${m.name} 超过 ${Math.round(FILE_MAX_BYTES / 1024 / 1024)}MB，未落盘`)
            continue
          }
          const path = saveWechatFile(buf, m.name)
          notes.push(`[文件已保存到 ${path}]`)
        }
      } catch (e) {
        notes.push(`⚠️ ${m.name} 拉取失败：${(e as Error).message}`)
      }
    }

    // 期间被 /stop 取消了：状态机已由取消分支收尾，这里什么都别发
    if (pendingInjection?.deliveryId !== task.deliveryId) return

    const text = [label, task.text, ...notes].filter((s) => s && s.trim()).join('\n')
    const content: string | ContentBlock[] = images.length === 0 ? text : [{ type: 'text', text }, ...images]
    // 微信侧 /model 选了模型：投递前切好，本次运行就用它（切失败不阻塞，沿用当前）
    await applyTaskModel(task.model)
    // ★ 必须等会话**真正**空闲（v3.27）：agent_end 处理器执行期间 SDK 的 run 还没结束，
    //   这时 sendUserMessage 会被拒（错误还被 SDK 内部吞掉），pendingInjection 就此永久卡死。
    const idle = await waitIdle(10_000)
    if (pendingInjection?.deliveryId !== task.deliveryId) return // 等待期间被 /stop 收尾了
    if (!idle) {
      // 一直忙：改用 followUp 排队（宁可排在当前轮次后面，也别把任务丢了）
      pendingGraceMs = 5 * 60_000
      logLine(`inject ${task.deliveryId.slice(0, 8)}: 会话一直在跑，改用 followUp 排队`)
    }
    try {
      // 注意：pi.sendUserMessage 是 fire-and-forget（内部 catch 只上报给 pi 的错误监听，
      // 我们这里 try/catch 抓不到）—— 真正的兜底是下面的卡死看门狗。
      void pi.sendUserMessage(content, idle ? undefined : { deliverAs: 'followUp' })
      logLine(`inject ${task.deliveryId.slice(0, 8)}: 已交给 pi（idle=${idle}）`)
    } catch (e) {
      pendingInjection = null
      sendTerminal({ type: 'error', delivery_id: task.deliveryId, text: `注入失败：${(e as Error).message}` })
      sendFrame({ type: 'typing', delivery_id: task.deliveryId, on: false })
      notify(`注入任务失败：${(e as Error).message}`, 'error')
      drainQueue()
    }
  }

  /** 本机模型列表 → {provider, model(＝id), label}，供网关 /models 展示、/model 切换。
   *  只含非密钥字段；拿不到注册表就返回空（welcome 后仍会发一次空数组）。 */
  function produceModels(): Array<{ provider: string; model: string; label: string }> {
    const reg = latestContext?.modelRegistry
    if (!reg) return []
    let all: Array<{ provider?: unknown; id?: unknown; name?: unknown }> = []
    try {
      all = reg.getAll() as unknown as Array<{ provider?: unknown; id?: unknown; name?: unknown }>
    } catch {
      return []
    }
    return all
      .filter((m) => m && typeof m.provider === 'string' && typeof m.id === 'string')
      .map((m) => ({
        provider: m.provider as string,
        model: m.id as string,
        label: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : ''
      }))
      .slice(0, 200)
  }

  /** 微信侧 /model 选的模型 → 切换当前会话模型（在本次任务运行前调用）。
   *   model 为 {provider, model}；找不到模型 / 没配 key 都只提示、不阻塞任务。 */
  async function applyTaskModel(model: Record<string, unknown> | null): Promise<void> {
    if (!model || !running || !ws) return
    const ctx = latestContext
    const provider = typeof model.provider === 'string' ? model.provider : ''
    const id = typeof model.model === 'string' ? model.model : ''
    if (!provider || !id || !ctx?.modelRegistry) return
    try {
      const m = ctx.modelRegistry.find(provider, id)
      if (!m) {
        notify(`微信侧要的模型 ${provider}/${id} 不在本机注册表，沿用当前`, 'warning')
        return
      }
      const cur = ctx.model
      if (cur && cur.provider === provider && cur.id === id) return
      const ok = await pi.setModel(m)
      notify(
        ok
          ? `已按微信侧切换模型：${provider}/${id}`
          : `切到 ${provider}/${id} 失败（可能没配 API key），沿用当前`,
        ok ? 'info' : 'warning'
      )
    } catch (e) {
      notify(`切模型失败：${(e as Error).message}`, 'warning')
    }
  }

  /** 微信发来的文件落到当前工作区（沙箱子目录，不碰仓库其它地方） */
  function saveWechatFile(buf: Buffer, name: string): string {
    const cwd = latestContext?.cwd ?? process.cwd()
    const dir = join(cwd, WECHAT_FILES_SUBDIR)
    mkdirSync(dir, { recursive: true })
    const safe = (name || 'file.bin').replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(-80)
    const path = join(dir, `${Date.now().toString(36)}_${safe}`)
    writeFileSync(path, buf)
    return path
  }

  function buildSystemPrompt(basePrompt: string, task: GwTask): string {
    return [
      basePrompt,
      '',
      '你正在回复一条来自微信的桥接消息。',
      '要求：',
      '1. 像微信聊天一样直接给结论，语气自然。',
      '2. 少用重 markdown（对方在微信里看，** 和表格会显示成原始符号）。',
      '3. 只输出最终要发回微信的正文，不要解释桥接流程。',
      '4. 对方发来的图片已作为图片注入，直接看图回答；文件已落到工作区的 .pi-wechat-files/ 下，正文里给了绝对路径，需要时用 read/bash 处理。',
      // 4000 → 8000：v3.14 的表情包说明拼在网关侧 prompt 的**最后**，切太短会把它整段截掉
      // （模型不知道有这功能 = 白做）。网关侧本来就有自己的长度约束。
      task.systemPrompt ? `\n[本会话附加人设/指令]\n${String(task.systemPrompt).slice(0, 8000)}` : ''
    ].join('\n')
  }

  async function completeActiveTask(messages: Array<{ role?: string; content?: unknown }>): Promise<void> {
    const task = activeTask
    activeTask = null
    pendingInjection = null
    if (!task) {
      drainQueue()
      return
    }
    const reply = extractFinalAssistantText(messages)
    const usage = extractUsage(messages)
    const wasAborted = aborted.delete(task.deliveryId)
    if (cancelled.has(task.deliveryId)) {
      cancelled.delete(task.deliveryId)
      logLine(`task ${task.deliveryId.slice(0, 8)} 已取消，丢弃回复`)
      drainQueue()
      return
    }
    if (reply) {
      sendTerminal({ type: 'reply', delivery_id: task.deliveryId, text: reply, ...(usage ? { usage } : {}) })
    } else if (wasAborted) {
      sendTerminal({ type: 'error', delivery_id: task.deliveryId, text: '已中止（没有产出正文）' })
    } else {
      // 没抽出正文也要终结：否则 gateway 侧任务永远停在非终态（就是「还在处理」刷屏的成因）。
      // v3.44：把「为什么没正文」一起说清 —— 以前只丢一句英文，用户只能干猜。
      sendTerminal({
        type: 'error',
        delivery_id: task.deliveryId,
        text: `没产出正文（${diagnoseNoText(
          messages as MsgLike[],
          progress?.think ?? progress?.firstThink ?? ''
        )}）`
      })
    }
    sendFrame({ type: 'typing', delivery_id: task.deliveryId, on: false })
    drainQueue()
  }


  // ---------- 斜杠命令 ----------

  pi.registerCommand('wisp-login', {
    description: '配置并连接 gateway（/wisp-login <url> <agentId> <token> [session|dir|off]）',
    handler: async (args: string, ctx) => {
      rememberContext(ctx)
      const parts = args.trim().split(/\s+/).filter(Boolean)
      let cfg: GatewayConfig = loadConfig() ?? { agentId: '', token: '', url: '', agentIdMode: 'off' }
      if (parts.length >= 3) {
        cfg = {
          url: parts[0]!,
          agentId: parts[1]!,
          token: parts[2]!,
          agentIdMode: cfg.agentIdMode ?? 'off',
          autoConnect: cfg.autoConnect
        }
      }
      // 第 4 个参数：session = 每个 pi 会话一个 id（同目录多开互不顶替）；dir = 每个目录一个；
      // off/single = 共用同一个 id。老词 multi 等价 session 的语义，继续认。
      const flag = parts[3]?.toLowerCase()
      if (flag === 'session' || flag === 'multi' || flag === 'per-session') cfg.agentIdMode = 'session'
      else if (flag === 'dir') cfg.agentIdMode = 'dir'
      else if (flag === 'off' || flag === 'single') cfg.agentIdMode = 'off'
      else if (flag) {
        notify(`未知参数 ${parts[3]}（只认 session / dir / off，multi 与 single 是旧写法）`, 'error')
        return
      }
      if (!cfg.url || !cfg.agentId || !cfg.token) {
        notify(
          `用法：/wisp-login <url> <agentId> <token> [multi|single]\n当前配置：${CONFIG_PATH}`,
          'error'
        )
        return
      }
      saveConfig(cfg)
      // 先彻底停掉旧连接（否则 connect() 的守卫会直接拒绝新配置）
      running = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      resetBridgeState()
      ws?.close()
      ws = null
      connect(cfg)
      notify(`配置已保存：${CONFIG_PATH}（agent=${effectiveAgentId(cfg)}）`, 'info')
    }
  })

  pi.registerCommand('wisp-config', {
    description: '查看当前 gateway 连接配置（token 打码）',
    handler: async (_args: string, ctx) => {
      rememberContext(ctx)
      const cfg = loadConfig()
      if (!cfg) {
        const hasFile = existsSync(CONFIG_PATH)
        notify(
          `还没有可用配置：${CONFIG_PATH}${hasFile ? '（文件在，但缺 url / token / agent_id）' : ''}\n` +
            '先执行 /wisp-login <url> <agentId> <token> [session|dir|off]，或直接手写该文件',
          'warning'
        )
        return
      }
      notify(
        [
          `配置：${CONFIG_PATH}`,
          `url: ${cfg.url}`,
          `agent_id: ${cfg.agentId}`,
          `token: ${maskSecret(cfg.token)}`,
          `agent_id_per_session: ${cfg.agentIdMode}${cfg.agentIdMode === 'off' ? '（全机共用一个 id，多开互踢）' : `（实际用 ${effectiveAgentId(cfg)}）`}`,
          `auto_connect: ${cfg.autoConnect !== false}`,
          `keep_alive: ${cfg.keepAlive !== false}（pi-web 空闲不回收本会话；/wisp-offline 会释放）`,
          `连接：${ws ? WebSocketStateLabel(ws.readyState) : 'offline'}`
        ].join('\n'),
        'info'
      )
    }
  })

  pi.registerCommand('wisp-log', {
    description: '看本机 wisp-client 日志（收没收到任务 / 回复发没发出去 / 为什么掉线）',
    handler: async (args: string, ctx) => {
      rememberContext(ctx)
      const n = Math.min(Math.max(Number(args.trim() || '20') || 20, 1), 200)
      if (!existsSync(CLIENT_LOG_PATH)) {
        notify(`还没有日志：${CLIENT_LOG_PATH}`, 'info')
        return
      }
      let tail = ''
      try {
        const stat = statSync(CLIENT_LOG_PATH)
        const start = Math.max(0, stat.size - n * 200)
        const fd = openSync(CLIENT_LOG_PATH, 'r')
        const buf = Buffer.alloc(stat.size - start)
        readSync(fd, buf, 0, buf.byteLength, start)
        closeSync(fd)
        tail = buf.toString('utf8').split('\n').slice(-n).join('\n')
      } catch (e) {
        notify(`读日志失败：${(e as Error).message}`, 'error')
        return
      }
      notify(`日志：${CLIENT_LOG_PATH}（最后 ${n} 行）\n${tail}`, 'info')
    }
  })

  pi.registerCommand('wisp-reload', {
    description: '重新读取 ~/.wisp-gateway.toml 并重连',
    handler: async (_args: string, ctx) => {
      rememberContext(ctx)
      const cfg = loadConfig()
      if (!cfg) {
        notify(`读不到配置：${CONFIG_PATH}（先 /wisp-login 或手写该文件）`, 'error')
        return
      }
      // 与 /wisp-login 一样先彻底停掉旧连接，否则 connect() 的守卫会直接拒绝
      standDown = false
      keepAliveWanted = cfg.keepAlive !== false && cfg.autoConnect !== false
      syncLiveness()
      running = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      resetBridgeState()
      sendFrame({ type: 'bye' })
      ws?.close()
      ws = null
      connect(cfg)
      notify(`已重新读取并连接：${CONFIG_PATH}（agent=${effectiveAgentId(cfg)}）`, 'info')
    }
  })

  let lastPeer: { account: string; wxUser: string } | null = null

  /** 主动向微信用户发一条**文字**通知。
   *
   *  刻意**不带 delivery_id**：通知不是任务终态，带了会把正在跑的任务提前标成已回复
   *  （agent 崩掉后 resume 不再重投，真实回复就丢了）。不带 id 时网关退到该 agent
   *  最近一次会话（last_task_owner），任务状态不受影响，最终回复仍由 agent_end 发。
   *  与 sendMediaToWechat 的区别：媒体那条带 id 是因为「文件就是答案」。 */
  function sendTextToWechat(text: string): string {
    if (!ws || ws.readyState !== 1) return '⚠️ 未连接 gateway，文字没发出去'
    const trimmed = (text ?? '').trim()
    if (!trimmed) return '⚠️ 通知内容为空'
    const frame: Record<string, unknown> = {
      type: 'reply',
      text: trimmed,
      error: null
    }
    try {
      ws.send(JSON.stringify(frame))
    } catch (e) {
      return `⚠️ 发送失败：${(e as Error).message}`
    }
    return `✅ 已把通知发往微信：${preview(trimmed)}`
  }

  /** 把工作区内的文件发回微信。
   *
   *  有正在处理的任务就用它的 delivery_id（网关据此定位会话）；任务之外（TUI 里直接
   *  让 pi 发文件）不带 id，网关退到本 agent 最近一次会话。 */
  function sendMediaToWechat(kind: 'image' | 'file', filePath: string, displayName?: string): string {
    if (!ws || ws.readyState !== 1) return '⚠️ 未连接 gateway，文件没发出去'
    if (!activeTask && !lastPeer) return '⚠️ 还没有微信会话（等一条微信消息进来后再发）'
    const cwd = latestContext?.cwd ?? process.cwd()
    const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
    // 沙箱：只许发工作区内的文件（与 read/write 的边界保持一致）
    const rel = relative(cwd, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) return `⚠️ 只能发送工作区内的文件：${cwd}`
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      return `⚠️ 文件不存在：${abs}`
    }
    if (!st.isFile()) return `⚠️ 不是文件：${abs}`
    if (st.size > FILE_MAX_BYTES) {
      return `⚠️ 文件太大（${(st.size / 1024 / 1024).toFixed(1)}MB > ${FILE_MAX_BYTES / 1024 / 1024}MB）`
    }
    const name = displayName?.trim() || basename(abs)
    let data: Buffer
    try {
      data = readFileSync(abs)
    } catch (e) {
      return `⚠️ 读取失败：${(e as Error).message}`
    }
    const frame: Record<string, unknown> = {
      type: 'reply_media',
      kind,
      filename: name,
      data_base64: data.toString('base64')
    }
    if (activeTask) frame.delivery_id = activeTask.deliveryId
    try {
      ws.send(JSON.stringify(frame))
    } catch (e) {
      return `⚠️ 发送失败：${(e as Error).message}`
    }
    return `✅ 已把 ${name}（${(st.size / 1024).toFixed(1)} KB）发往微信`
  }

  pi.registerTool({
    name: 'send_file_to_wechat',
    label: '发送文件到微信',
    description: '把当前工作区内的文件作为微信文件消息发给正在对话的人。',
    promptSnippet: 'send_file_to_wechat(filePath, fileName?)：把工作区内的文件发到微信',
    promptGuidelines: [
      '微信用户要文件时，先把内容写进文件，再用 send_file_to_wechat 发送。',
      '只能发当前工作区内的文件（安全限制）。',
      '返回 ⚠️ 开头就是失败，不要反复重试。'
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: '文件路径（工作区内，绝对或相对路径）' }),
      fileName: Type.Optional(Type.String({ description: '微信里显示的文件名（默认用原文件名）' }))
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: sendMediaToWechat('file', params.filePath, params.fileName) }],
        details: {}
      }
    }
  })

  pi.registerTool({
    name: 'send_image_to_wechat',
    label: '发送图片到微信',
    description: '把当前工作区内的图片作为微信图片消息发给正在对话的人（对方可直接预览）。',
    promptSnippet: 'send_image_to_wechat(imagePath)：把工作区内的图片发到微信',
    promptGuidelines: [
      '微信用户要图表/截图时，先生成图片文件再用 send_image_to_wechat 发送。',
      '只能发当前工作区内的图片（安全限制）。',
      '返回 ⚠️ 开头就是失败，不要反复重试。'
    ],
    parameters: Type.Object({
      imagePath: Type.String({ description: '图片路径（工作区内，支持 png/jpg/gif/webp）' })
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: sendMediaToWechat('image', params.imagePath) }],
        details: {}
      }
    }
  })

  pi.registerTool({
    name: 'send_wechat_text',
    label: '发送文字到微信',
    description: '主动向微信用户发送一条文字消息（通知/提醒/汇报进度等）。与自动回复不同，\n它在任务上下文之外也可用：用户在 pi 里说“任务完成了通知下我微信”时就该调用它。',
    promptSnippet: 'send_wechat_text(text)：主动发一条文字到微信，用于通知/提醒/汇报',
    promptGuidelines: [
      '用户说“通知下微信/提醒我/完成后告诉我”等，就用 send_wechat_text 发一条文字。',
      '优先把要发的通知写成一个自然的短句，不裹 markdown。',
      '返回 ⚠️ 开头就是失败（未连接/无历史会话），不要反复重试。'
    ],
    parameters: Type.Object({
      text: Type.String({ description: '要发到微信的文字内容（用微信聊天的语气，简短直接）' })
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: sendTextToWechat(params.text) }],
        details: {}
      }
    }
  })

  pi.registerCommand('wisp-status', {
    description: '查看 gateway 连接状态',
    handler: async (_args: string, ctx) => {
      rememberContext(ctx)
      const cfg = loadConfig()
      const state = ws ? WebSocketStateLabel(ws.readyState) : '未连接'
      notify(
        [
          `运行状态: ${running ? 'running' : 'stopped'}`,
          `连接状态: ${state}`,
          `agentId: ${cfg ? effectiveAgentId(cfg) : '-'}${cfg?.agentIdMode && cfg.agentIdMode !== 'off' ? `（${cfg.agentIdMode === 'session' ? '会话级' : '目录级'}）` : ''}`,
          `gateway: ${maskUrl(cfg?.url)}`,
          `排队任务: ${inbound.length}`,
          `处理中: ${activeTask ? preview(activeTask.text) : progress ? preview(progress.prompt ?? '（本地任务）') : '-'}`,
          `进度: ${progress ? `第 ${progress.turn} 步${progress.tool ? ` · ${progress.tool}` : ''}${progress.waiting ? ' · 等你确认' : ''}` : '-'}`,
          `自报: 手上 ${heldIds().length} 条 · 上下文 ${contextPct() ?? '?'}%`,
          `配置文件: ${CONFIG_PATH}`
        ].join('\n'),
        'info'
      )
      updateStatus()
    }
  })

  pi.registerCommand('wisp-sessions', {
    description: '列出本机 pi 会话（按工作区分组；★ 是当前会话）',
    handler: async (_args: string, ctx) => {
      rememberContext(ctx)
      notify(formatSessions(ctx.sessionManager.getSessionFile()), 'info')
    }
  })

  pi.registerCommand('wisp-new', {
    description: '在当前工作区新建会话（微信桥接会跟着切过去）',
    handler: async (_args: string, ctx) => {
      rememberContext(ctx)
      try {
        const r = await ctx.newSession()
        if (r.cancelled) {
          // pi-web 把扩展的 newSession 明确挡成 cancelled —— 如实告知，别假装成功
          notify('当前环境不支持扩展新建会话（pi-web 托管时会拒绝）；在终端里跑 pi 用 /new', 'warning')
        } else {
          notify('已新建会话（新会话会重新连上 gateway）', 'info')
        }
      } catch (e) {
        notify(`新建会话失败：${(e as Error).message}`, 'error')
      }
    }
  })

  pi.registerCommand('wisp-offline', {
    description: '断开 gateway 连接',
    handler: async (_args: string, ctx) => {
      rememberContext(ctx)
      // 用户明确要求断开：看门狗也不许连回来（要恢复用 /wisp-login 或 /wisp-reload）
      standDown = true
      syncLiveness() // 真的不用了，释放存活钉让 pi-web 能回收
      running = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      sendFrame({ type: 'bye' })
      resetBridgeState()
      ws?.close()
      ws = null
      updateStatus()
      notify('已断开 gateway', 'info')
    }
  })

  // ---------- 生命周期事件 ----------

  pi.on('session_start', async (_event, ctx) => {
    rememberContext(ctx)
    if (migratedFrom) {
      notify(`已把旧配置迁移到 ${CONFIG_PATH}（原文件保留为 ${migratedFrom}.bak）`, 'info')
      migratedFrom = null
    }
    syncLiveness() // 新会话 id 已就绪：重新钉住
    maybeAutoConnect()
  })

  pi.on('before_agent_start', async (event, ctx) => {
    rememberContext(ctx)
    // v3.22：本地任务（在 pi 里直接输入的）也要能被网关看见 —— 记下这句话，
    // agent_start 时用它当自报里的「在问什么」（微信任务用注入文本更准，带来源标签）
    lastPrompt = typeof event?.prompt === 'string' ? event.prompt.trim() : ''
    const task = pendingInjection ?? activeTask
    if (!task) return
    return { systemPrompt: buildSystemPrompt(event.systemPrompt, task) }
  })

  pi.on('agent_start', async (_event, ctx) => {
    rememberContext(ctx)
    agentIdle = false
    pendingSince = 0 // 跑起来了，卡死看门狗不用管了
    if (pendingInjection) {
      activeTask = pendingInjection
      pendingInjection = null
      progress = newProgress(activeTask.text, false)
    } else {
      // 本地任务：没有 delivery_id，但「在问什么/正在写什么」同样该让网关看到
      progress = newProgress(lastPrompt || null, true)
    }
    sendProgress(true)
    startProgressHeartbeat()
    sendReport(true)
    updateStatus()
  })

  pi.on('turn_start', async (event, ctx) => {
    rememberContext(ctx)
    if (!progress) return
    // 带 turnIndex 就用它；没带就 +1（turn_start 每轮只触发一次，自增是对的）
    const idx = (event as { turnIndex?: unknown })?.turnIndex
    progress.turn =
      typeof idx === 'number' && Number.isFinite(idx) ? idx + 1 : progress.turn + 1
    sendProgress()
    sendReport()
  })

  pi.on('tool_call', async (event, ctx) => {
    rememberContext(ctx)
    if (!progress) return
    const e = event as { toolName?: unknown; input?: unknown }
    progress.tool = typeof e?.toolName === 'string' ? e.toolName : 'tool'
    progress.detail = summarizeToolInput(progress.tool, e?.input)
    progress.toolState = 'executing'
    sendProgress()
    sendReport()
  })

  // 工具跑完了没、成没成（tool_call 只知道「要跑」）
  pi.on('tool_execution_end', async (event, ctx) => {
    rememberContext(ctx)
    if (!progress) return
    const e = event as { toolName?: unknown; isError?: unknown }
    progress.toolState = e?.isError ? 'error' : 'done'
    if (typeof e?.toolName === 'string') progress.tool = e.toolName
    sendReport()
  })

  // 「AI 正在写的字」：流式增量，只留尾部（进内存 + 自报，不落日志/库）
  pi.on('message_update', async (event, ctx) => {
    rememberContext(ctx)
    if (!progress) return
    const a = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
      ?.assistantMessageEvent
    if (a?.type === 'text_delta' && typeof a.delta === 'string') {
      progress.draft = (progress.draft + a.delta).slice(-400)
      sendReport()
      return
    }
    // thinking 增量（v3.36）：截尾保存 —— 「它在想什么」比「它在写什么」有用得多
    if (a?.type === 'thinking_delta' && typeof a.delta === 'string') {
      progress.think = (progress.think + a.delta).slice(-800)
      // 第一次思考单独留一份（v3.43）：一轮里第一个 thinking 块 = 它的打算
      if (!progress.firstThinkDone) {
        progress.firstThink = (progress.firstThink + a.delta).slice(-400)
      }
      sendReport()
      return
    }
    // 第一个 thinking 块结束：之后不再往 firstThink 里堆
    if (a?.type === 'thinking_end') {
      progress.firstThinkDone = true
      sendReport()
    }
  })

  // 本轮 token 用量（自报里给个「跑到多少了」）
  pi.on('turn_end', async (event, ctx) => {
    rememberContext(ctx)
    if (!progress) return
    const u = (event as { message?: { usage?: { input?: unknown; output?: unknown } } })?.message
      ?.usage
    if (typeof u?.input === 'number') progress.tokensIn += u.input
    if (typeof u?.output === 'number') progress.tokensOut += u.output
    sendReport()
  })

  // 卡在等人交互（等审批/等选择）—— 卡住时唯一会触发的事件：网关靠它说清「它在等你」。
  // `ui_prompt_*` 是 0.73 之后才加的事件：pi-web 用的运行时已经实现，而本地 devDependency
  // 的类型还停在旧版 —— 过一层薄封装即可（旧运行时不触发，`on()` 收未知事件名也不报错）。
  const onAnyEvent = pi.on as unknown as (
    event: string,
    handler: (event: any, ctx: ExtensionContext) => void | Promise<void>
  ) => void
  onAnyEvent('ui_prompt_start', async (event, ctx) => {
    rememberContext(ctx)
    if (!progress) return
    const e = event as { kind?: unknown; title?: unknown }
    progress.waiting = {
      kind: typeof e?.kind === 'string' ? e.kind : 'ui',
      title: typeof e?.title === 'string' ? e.title : ''
    }
    sendReport(true)
  })

  onAnyEvent('ui_prompt_end', async (_event, ctx) => {
    rememberContext(ctx)
    if (!progress) return
    progress.waiting = null
    sendReport(true)
  })

  pi.on('agent_end', async (event, ctx) => {
    rememberContext(ctx)
    agentIdle = true
    clearProgress()
    updateStatus()
    // completeActiveTask 内部会 sendFrame（可能抛），用 finally 保证队列一定推进，
    // 否则一次异常就让整个状态机停摆
    try {
      await completeActiveTask(event.messages as Array<{ role?: string; content?: unknown }>)
    } finally {
      drainQueue()
      sendReport(true)
    }
  })

  pi.on('session_shutdown', async (event, ctx) => {
    rememberContext(ctx)
    // reload / 退出会话时宿主会先发 shutdown：不记一笔的话「为什么突然下线」完全不可见
    // （2026-10-09 排查时就是这里静默的）。看门狗会在事件顺序不齐时把它兜回来。
    logLine(`shutdown（reason=${String((event as { reason?: unknown })?.reason ?? '-')}）→ 断开并作废本实例（新实例会接管）`)
    // ★ 作废 + 清干净所有定时器：漏一个旧看门狗就会和新实例抢 agent_id（实测的踢来踢去）
    disposed = true
    running = false
    syncLiveness() // disposed → 释放存活钉
    disposeTimers()
    clearProgress()
    sendFrame({ type: 'bye' })
    ws?.close()
    ws = null
  })

  function rememberContext(ctx: ExtensionContext | ExtensionCommandContext): void {
    latestContext = ctx
  }

  // 扩展加载即尝试一次：不要等 session_start（pi-web 里进工作区就会加载扩展，
  // 早点连上就不用等第一条消息才发现没连接）。session_start 还会再兜一次，
  // connect 的重复守卫吃了它（quiet=true，不刷提示）。
  maybeAutoConnect()
  startSelfHeal()
}

// ---------- 工具 ----------

/** 从最后一条 assistant 消息里取 token 用量（不同 harness 字段名不一，宽松匹配） */
function extractUsage(messages: Array<Record<string, unknown>>): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, any>
    if (!m || m.role !== 'assistant') continue
    const u = m.usage ?? m.tokenUsage ?? m.tokens
    if (!u || typeof u !== 'object') continue
    const input = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? u.input
    const output = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? u.output
    if (typeof input !== 'number' && typeof output !== 'number') continue
    return {
      input_tokens: typeof input === 'number' ? input : 0,
      output_tokens: typeof output === 'number' ? output : 0,
      ...(typeof m.model === 'string' ? { model: m.model } : {})
    }
  }
  return null
}

function extractFinalAssistantText(
  messages: Array<{ role?: string; content?: unknown }>
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    const text = m.content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text'
      )
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) return text
  }
  return null
}

type MsgLike = { role?: string; content?: unknown; error?: unknown }

/**
 * 「为什么没有正文」（v3.44）：给用户一句能看懂的原因 + 最后的思考线索。
 * 判据只看消息结构，不猜模型状态：没有助手消息 / 最后一条只有工具调用 / 只有思考。
 */
function diagnoseNoText(messages: MsgLike[], think = ''): string {
  const asst = messages.filter((m) => m?.role === 'assistant')
  const last = asst[asst.length - 1]
  const parts = Array.isArray(last?.content) ? (last?.content as Array<{ type?: string }>) : []
  const kinds = parts.map((p) => (typeof p === 'object' && p ? String(p.type ?? '') : '')).filter(Boolean)
  const bits: string[] = []
  if (!asst.length) {
    bits.push('整轮没有助手消息，多半是模型/接口直接报错')
  } else if (kinds.some((k) => k === 'tool_call' || k === 'toolCall' || k === 'tool_use')) {
    bits.push('它最后停在一个工具调用上（可能步数/上下文用满，或被中断）')
  } else if (kinds.includes('thinking')) {
    bits.push('只有思考没有正文（它想完了但没写出来）')
  } else {
    bits.push(`最后一条助手消息没有文本（${kinds.join('+') || '空内容'}）`)
  }
  // 最后一条消息里若带错误字段，原样带给用户（最常见的就是 provider 报错）
  const err = messages
    .map((m) => (typeof m?.error === 'string' ? m.error : ''))
    .filter(Boolean)
    .pop()
  if (err) bits.push(`报错：${preview(err)}`)
  const th = think.trim()
  if (th) bits.push(`它最后在想：${preview(th.slice(-120))}`)
  return preview(bits.join('；'))
}

function preview(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= PREVIEW_LIMIT ? t : `${t.slice(0, PREVIEW_LIMIT - 1)}…`
}

/** 只认网关给的媒体形态（kind + 网关相对路径），其余字段一律忽略 */
function parseMedia(v: unknown): GwMedia[] {
  if (!Array.isArray(v)) return []
  const out: GwMedia[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const kind = o.kind === 'image' || o.kind === 'file' ? o.kind : null
    // 只接受相对路径：任务帧里的 url 是网关自己生成的，不接受绝对地址（避免变成 SSRF 跳板）
    const url = typeof o.url === 'string' && o.url.startsWith('/') ? o.url : null
    if (!kind || !url) continue
    out.push({
      kind,
      id: String(o.id ?? ''),
      name: String(o.name ?? (kind === 'image' ? 'image.jpg' : 'file.bin')),
      mime: String(o.mime ?? 'application/octet-stream'),
      size: typeof o.size === 'number' ? o.size : 0,
      url
    })
  }
  return out
}

/** ws(s)://host:port/agent → http(s)://host:port（媒体走同一台网关的 HTTP） */
function httpOrigin(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
  } catch {
    return null
  }
}

// ---------- 会话列表（/wisp-sessions） ----------

interface SessionLite {
  path: string
  id: string
  cwd: string
  name: string | null
  firstMessage: string | null
  mtimeMs: number
}

/** 只读头部这么多字节：会话文件动辄几 MB，列表不该把它们整个读进来 */
const SESSION_HEAD_BYTES = 64 * 1024

function readHead(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    closeSync(fd)
  }
}

/** 从 message 条目里抽第一段文本（content 可能是字符串或内容块数组） */
function firstUserText(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as { role?: string; content?: unknown }
  if (m.role !== 'user') return null
  if (typeof m.content === 'string') return m.content.trim() || null
  if (!Array.isArray(m.content)) return null
  for (const p of m.content) {
    if (p && typeof p === 'object' && (p as { type?: string }).type === 'text') {
      const t = String((p as { text?: string }).text ?? '').trim()
      if (t) return t
    }
  }
  return null
}

function scanSessions(): SessionLite[] {
  const out: SessionLite[] = []
  let dirs: string[] = []
  try {
    dirs = readdirSync(SESSIONS_DIR)
  } catch {
    return out
  }
  for (const d of dirs) {
    const dir = join(SESSIONS_DIR, d)
    let files: string[] = []
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const path = join(dir, f)
      try {
        const st = statSync(path)
        const lines = readHead(path, SESSION_HEAD_BYTES).split('\n')
        const header = JSON.parse(lines[0] ?? '') as { type?: string; id?: string; cwd?: string }
        if (header.type !== 'session' || !header.id) continue
        let name: string | null = null
        let firstMessage: string | null = null
        for (const line of lines) {
          if (!line.trim()) continue
          let entry: Record<string, unknown>
          try {
            entry = JSON.parse(line) as Record<string, unknown>
          } catch {
            // 头部截断处的半行：跳过
            continue
          }
          if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name
          if (!firstMessage && entry.type === 'message') firstMessage = firstUserText(entry.message)
        }
        out.push({
          path,
          id: header.id,
          cwd: header.cwd ?? '',
          name,
          firstMessage,
          mtimeMs: st.mtimeMs
        })
      } catch {
        continue
      }
    }
  }
  return out
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 按工作区分组，每组最多 8 条、总共最多 40 条（多了在微信/终端里没法看） */
function formatSessions(currentFile: string | undefined): string {
  const all = scanSessions()
  if (all.length === 0) return `没扫到会话（目录：${SESSIONS_DIR}）`
  const byCwd = new Map<string, SessionLite[]>()
  for (const s of all) {
    const list = byCwd.get(s.cwd) ?? []
    list.push(s)
    byCwd.set(s.cwd, list)
  }
  const groups = [...byCwd.entries()]
    .map(([cwd, list]) => ({ cwd, list: list.sort((a, b) => b.mtimeMs - a.mtimeMs) }))
    .sort((a, b) => (b.list[0]?.mtimeMs ?? 0) - (a.list[0]?.mtimeMs ?? 0))
  const out: string[] = []
  let total = 0
  for (const g of groups) {
    if (total >= 40) break
    out.push(`${g.cwd || '(无 cwd)'}（${g.list.length}）`)
    for (const s of g.list.slice(0, 8)) {
      if (total >= 40) break
      total += 1
      const cur = currentFile && s.path === currentFile ? '★' : ' '
      const title = (s.name ?? s.firstMessage ?? '未命名').replace(/\s+/g, ' ').slice(0, 24)
      out.push(`  ${cur} ${fmtTime(s.mtimeMs)}  ${title}  ${s.id.slice(0, 8)}`)
    }
  }
  return out.join('\n')
}

function WebSocketStateLabel(state: number): string {
  switch (state) {
    case WebSocket.CONNECTING:
      return 'connecting'
    case WebSocket.OPEN:
      return 'open'
    case WebSocket.CLOSING:
      return 'closing'
    default:
      return 'closed'
  }
}

function hostnameSafe(): string {
  try {
    return hostname()
  } catch {
    return 'unknown'
  }
}
