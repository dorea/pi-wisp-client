# AGENTS.md — pi-wisp-client

> wisp-gateway 的 **pi 客户端扩展**（独立公开仓库）。网关本体（Rust + WebUI）不在这个仓库里。

## ★ 铁律：这个仓库是公开的

提交前确认源码 / 文档 / 注释 / 示例里**没有**下列任何东西：

- 真实服务器地址、IP、端口、域名 —— 一律用 `gateway.example.com`、`wss://gateway.example.com/agent` 这类占位
- 真实机器名 / 主机名 / agent id / 工作区路径 / Windows 用户名（不要写 `C:\Users\<某人>`、`C:\ws\<项目>` 这类真实路径）
- 微信 / QQ 的 openid、账号名、昵称、群名
- 任何 token、密码、key、cookie（配置文件 `~/.wisp-gateway.toml` 永不入库，日志 `~/.wisp-client.log` 也是）

一条命令自查（有命中就逐个改成占位）：

```bash
grep -rnIE "([0-9]{1,3}\.){3}[0-9]{1,3}|C:\\\\|/Users/|Users\\\\" src README.md CHANGELOG.md
grep -rnIiE "token *=|password *=|secret *=|o[0-9a-z]{8,}@im\.wechat" src README.md CHANGELOG.md
```

历史里一旦写进去就删不掉了（要改写全部历史）。**宁可多写一句泛化描述，不要贴真实值。**

## 发布

```bash
npm run check                      # tsc --noEmit，必须先过
git commit -am "fix: ..." && git push
git tag v0.3.1 && git push --tags  # 可选，供 @v0.3.1 钉版本
```

- 用户端更新：`pi update --extensions`（pi **不会**在启动时自动升级已声明的包，只有 `-e` 临时包会刷新）
- **发版必须同时提 `package.json` 的 `version` 与 `CHANGELOG.md`**：pi 按版本号判断是否显示更新说明，
  CHANGELOG 的标题格式用 `## [0.3.1]` 或 `## 0.3.1 - YYYY-MM-DD`

## 别踩回去的约定

- `@sinclair/typebox` 只能写在 `peerDependencies`（宿主 pi 已提供该模块，装一份副本会绕过扩展模块映射）。
- **agent_id 粒度**：`agent_id_per_session = "off" | "dir" | "session"`；
  `session` 模式用会话 uuid **尾部** 4 位（开头是时间前缀容易撞），且必须**跨重启稳定** ——
  重启后 id 变了，微信侧绑定就失联了。
- **目录 sticky**：`ctx.cwd` 与 `PI_SESSION_FILE` 都可能中途给不出值；拿不到时复用最后一次确认过的目录，
  别把重连闸门锁死（历史上 `wait-cwd` 曾导致客户端永久离线并刷出上千行日志）。
- **keep_alive**：pi-web 默认 `PI_WEB_IDLE_TIMEOUT_MS = 600000`（10 分钟）会把空闲会话整个关掉，
  扩展随之消失 = 网关看到「掉线」。默认开 `keep_alive` 注册存活钉，`/wisp-offline` 时释放。
- **日志**：`~/.wisp-client.log` 是全机共享的一份，所以每行都带 agent id 前缀；超过 512KB 截掉前一半。
- 注入微信消息必须带来源标签 `[微信:账号名]`；扩展**不得**假设自己是唯一会话使用者。

## 配置 / 命令速查

- 配置：`~/.wisp-gateway.toml`（0600，字段 snake_case，camelCase 也认）
- 命令：`/wisp-login` `/wisp-config` `/wisp-status` `/wisp-sessions` `/wisp-log` `/wisp-reload` `/wisp-offline` `/wisp-new`
- 工具：`send_wechat_text` `send_file_to_wechat` `send_image_to_wechat`
