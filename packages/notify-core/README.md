# @mbda9091/notify-core

`notify-web` 的共享内容层：通知标题/正文格式化（提问、审批与回合结束）、中英文文案、`turn/end` 原因到通知内容的映射。它不是 DSH 插件，没有 bundle、targets 或运行期安装；构建时用 esbuild 内联进插件产物。原消费者 desktop-notify 已归档停更。

只放纯函数和类型，不依赖 Node、浏览器或 Cordis，方便 Host 与 Client 共用。

Web 调用 `turnEndContent(reason, t, 'stopped')`，为 `max-tokens` 使用独立的输出上限提醒，不表示任务成功完成；默认调用保留原有文案。两个语言字典由 Client locale 注册，不需要在插件 meta locale 重复定义。
