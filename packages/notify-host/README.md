# @mbda9091/notify-host

`notify-web` 使用的 Host 通知触发逻辑，原消费者 desktop-notify 已归档停更：

- 全局监听已提交的 `session/event`；
- 按真实 Agent registry 与 `subagents.rootOf()` 过滤根会话（无法确认归属时不通知）；没有 subagents 服务的组合按 Session origin 排除委派会话，保留普通 fork；
- 审批延迟、自动决定取消、已显示审批的撤回；
- `turn/end` 的完成/错误/静默判断；
- `agent/disposed` 时清理待审批与已显示审批。

它只发出可序列化的 `NotificationUpdate`，不知道 Windows Toast、SSE、浏览器权限或当前选中的会话。构建时由 esbuild 内联进两个插件，profile 不需要安装。

## Web 完成判定

`createNotificationSource(ctx, options, 'settled')` 由 notify-web 启用：

| 条件 | 结果 |
|---|---|
| goal active / paused / blocked | 不发成功通知 |
| goal complete / 无 goal，根 agent 收尾、无子工作与待处理输入 | 一次完成通知 |
| 等待过子工作 / 新回合 / 新输入 / goal 变更 | 作废旧回合，等主 agent 汇总后的新回合 |
| 检查失败 / Agent 替换 / 卸载 | 作废检查 |

复用宿主 goals 与 subagents 的 `waitForTreeWork()`；每个服务提供者与 Agent 组合复用一组实际子工作等待。根收尾与子工作均使用可移除观察者，失效后释放旧回合回调，不取消任务。默认 `turn` 模式保留现有消费者契约，不新增用户配置。
