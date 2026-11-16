# Changelog

## [0.3.0] - 2026-11-16

### Fixed

- **不再被 pi-web 的空闲回收踢下线**：pi-web 默认 `PI_WEB_IDLE_TIMEOUT_MS = 600000`（10 分钟）会把空闲会话整个关掉，
  扩展和它的 WebSocket 一起消失 —— 这就是「过一段时间 client 就掉线」的根因（不是网络，也不是 pi 本体）。
  新增 `keep_alive`（默认开）：向 pi-web 的 session-liveness 注册表登记存活钉，只要连着网关就不回收。
  `/wisp-offline`、`auto_connect = false`、`keep_alive = false` 会释放，纯 CLI 跑 pi 时自动降级。
- **重连不会再被 `wait-cwd` 永久锁死**：`ctx.cwd` 与 `PI_SESSION_FILE` 都可能中途给不出值，
  现在会记住最后一次确认过的目录（sticky），self-heal 还会丢弃 `readyState` 非 OPEN/CONNECTING 的僵尸连接。
- `wait-cwd` 日志限流到 5 分钟一条（以前 14 分钟能刷 1000+ 行，把真正有用的 `closed` / `kick` 全冲掉）。
- `@sinclair/typebox` 改声明为 `peerDependencies`（宿主 pi 已提供该模块，装副本会绕过扩展模块映射）。

## [0.2.0] - 2026-11-05

### Added

- `agent_id_per_session = "session"`：`<agentId>-<目录>-<会话短id>`，同目录多开会话各有独立身份，互不顶替。
  短 id 取会话 uuid **尾部** 4 位并保证跨重启稳定（重启后 id 变了 = 微信绑定失联）。
  老值 `true` 仍等价于 `dir`。
- hello 的 `meta` 带 `dir` / `session_id` / `session_title`，网关侧 `/agents` 据此分组显示。

## [0.1.0] - 2026-10-20

### Added

- 首个版本：任务注入（带来源标签）、`agent_end` 回发最终回复、进度/缩略上报、
  typing 状态、媒体收发、审批消息、指数退避重连 + `resume` 补领未完结任务。
