# Web L5 fixture

仅供 `node scripts/bootstrap.mjs l4` / `l5` 安装到一次性 profile，不是正式插件，不进入 CATALOG。

- Client 使用宿主 React、locale 和 `conversation.composer.dock`，包含输入/Host 回声与中英切换。
- 测试初始化通过真实 workspace controller 创建临时会话，并写入受支持的会话事件；不调用模型。
- Host 的 `/api/web-hello/seed`、`echo`、`notify` 都经过 DSH Connection 认证。`notify` 仅操作本 fixture 已初始化的会话，用真实审批/回合事件驱动 `notify-web` 的 SSE。
- Playwright 只替换操作系统 `Notification` API；HTTP、会话存储、SSE 与 Client 模块均使用真实实现。
- 空白会话的欢迎页不会渲染 composer dock，因此初始化包含一条有 id/source 的用户消息及完整回合边界。

不要安装到日常 profile；测试端点可以写入会话事件。
