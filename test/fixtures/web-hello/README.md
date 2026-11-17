# Web L5 fixture

仅供 `node scripts/dev.mjs l4` / `l5` 安装到一次性 profile，不是正式插件，不进入 CATALOG。

- Client 使用宿主 React、locale 和 `conversation.composer.dock`，包含输入/Host 回声与中英切换。
- 测试初始化通过真实 workspace controller 创建临时会话，并写入受支持的会话事件；不调用模型。
- Host 的 `/api/web-hello/seed`、`echo`、`notify` 都经过 DSH Connection 认证。`notify` 仅操作本 fixture 已初始化的会话，用真实审批/回合事件驱动 `notify-web` 的 SSE。
- 提问用例通过真实 Agent 的 tools.execute 执行已注册的 ask_user_question，由执行器提交调用与结果；在 Host 转发边界设置可释放的测试闸门，再放行到真实 Client 卡片，由 Playwright 点击选项并提交答案，不调用模型，不直接注入通知意图。PTC 用例使用原版 PtcExecutor 执行 run_code 内的 ask_user_question，验证子调用开始时不通知、浏览器收到请求后才通知。多标签页用例使用原版 timed 工具，验证收讫页与通知持锁页不同的情况、Web Lock 接管、pending 恢复与回答撤回。
- Playwright 只替换操作系统 `Notification` API；HTTP、会话存储、SSE 与 Client 模块均使用真实实现。
- 空白会话的欢迎页不会渲染 composer dock，因此初始化包含一条有 id/source 的用户消息及完整回合边界。

不要安装到日常 profile；测试端点可以写入会话事件。
