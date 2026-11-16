# pi-wisp-client

把当前 pi 会话当作一个 agent 挂到 **wisp-gateway** 上：
微信 / QQ 的消息投递进来 → 注入当前 pi 会话 → 会话跑完把回复发回去，并带进度、缩略、审批、媒体。

## 安装

```bash
# 装（第一次）
pi install git:github.com/dorea/pi-wisp-client@main

# 更新（pi 自己的包更新命令；pi 不会每次启动自动升级已声明的包）
pi update --extensions

# 钉某个版本
pi install git:github.com/dorea/pi-wisp-client@v0.3.0
```

装完 **重启会话**（或在会话里 `/reload`）才会加载新代码。

## 配置

唯一一份配置：`~/.wisp-gateway.toml`（0600，含 token，**不要提交到 git**）。

```toml
url = "wss://你的网关/agent"
token = "网关发的 agent token"
agent_id = "本机名"

# 身份粒度：off 全机一个 id；dir 每个目录一个；session 每个会话一个
agent_id_per_session = "session"

# 加载即连（false 时只能手动 /wisp-login）
auto_connect = true

# 让 pi-web 别按空闲回收这个会话（默认 true）
keep_alive = true
```

也可以不手写文件，直接在 pi 里：`/wisp-login <url> <agentId> <token> [session|dir|off]`。
改完配置用 `/wisp-reload` 重新连接。旧的 `~/.wisp-gateway.json` 首次读取时会自动迁移成 TOML。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/wisp-login <url> <agentId> <token> [模式]` | 写入配置并连接 |
| `/wisp-config` | 看生效配置（token 打码）+ 实际 agent id |
| `/wisp-status` | 连接状态、队列、当前任务 |
| `/wisp-sessions` | 列出本机 pi 会话（换绑/排查用） |
| `/wisp-log [n]` | 本机客户端日志（为什么掉线、任务收没收到） |
| `/wisp-reload` | 重新读配置并重连 |
| `/wisp-offline` | 主动断开（同时释放 pi-web 存活钉） |
| `/wisp-new` | 在当前工作区新建会话 |

工具（给模型用的）：`send_wechat_text`、`send_file_to_wechat`、`send_image_to_wechat`。

## 身份粒度怎么选

网关对同一个 `agent_id` **只保留一条连接**（后连的顶替前一条，给旧的发 kick），所以：

- `off`：全机共用一个 id，多开必互踢；
- `dir`：`<agentId>-<目录名>`，同目录多开仍互踢；
- `session`：`<agentId>-<目录名>-<会话短id>`，同目录多开各自独立 —— **推荐的默认**。

## 关于「过一阵就掉线」

pi-web 默认 10 分钟空闲就把会话整个关掉（`PI_WEB_IDLE_TIMEOUT_MS`，默认 `600000`），
会话进程一死，扩展和它的 WebSocket 一起消失，网关看到的就是掉线。本扩展默认注册一个
liveness provider（`keep_alive = true`）钉住会话，只有你 `/wisp-offline` 或关掉自动连时才释放。

## 日志

`~/.wisp-client.log`（全机共享，行首带 agent id；超过 512KB 自动截掉前一半）。

## License

MIT
