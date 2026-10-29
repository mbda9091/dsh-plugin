# @local/notify-host

`desktop-notify` 与 `notify-web` 共用的 Host 通知触发逻辑：

- 全局监听已提交的 `session/event`；
- 按真实 Agent registry 过滤根会话（无法确认根身份时不通知）；
- 审批延迟、自动决定取消、已显示审批的撤回；
- `turn/end` 的完成/错误/静默判断；
- `agent/disposed` 时清理待审批与已显示审批。

它只发出可序列化的 `NotificationUpdate`，不知道 Windows Toast、SSE、浏览器权限或当前选中的会话。构建时由 esbuild 内联进两个插件，profile 不需要安装。
