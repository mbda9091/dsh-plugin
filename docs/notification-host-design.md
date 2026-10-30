# Desktop 与 Web 通知统一方案

状态：已实现（2026-10-25），已修复重连与缓存边界问题（2026-10-27，见 §11.9）。完整本地 CI 通过，随后调整为加载时立即申请通知权限（见 §11.12、§11.14）。Windows/macOS 远端类型检查与 L1–L5 已通过（2026-10-30，见 §11.15）。Windows 上 Codex 内嵌浏览器的原生通知显示、人工点击聚焦及双标签页去重/接管验收通过（见 §11.11）；独立 Chrome/Edge 与 macOS 的原生系统通知仍未实测。

两端统一由 Host 全局监听已提交的 `session/event`，共用根会话过滤、审批延迟与取消、回合结束判断。Desktop 把通知交给 Windows 适配器；Web 通过经过 DSH Connection 认证的 SSE 通道，把通知交给浏览器适配器。切换当前会话不再影响通知覆盖范围。

## 1. 要解决的问题

现有 `desktop-notify` 在 Host 上全局监听事件，过滤 subagent 后通知所有根会话。`notify-web` 则在浏览器读取审批状态，只订阅 `retainedBy.mainView` 指向的会话事件流。

因此，在 A 中启动任务、切到 B 后，A 的完成或错误不会触发 Web 通知；返回 A 时，已有事件又被当作历史跳过。`mainView` 表达的是当前界面选择，并不表达 Agent 的根子关系。

目前的 `notify-core` 只共享文案与结束原因映射。两端各自决定何时通知，后续修改审批抑制、过滤条件或配置时仍可能产生差异。现有 Web 测试使用固定的单会话模拟，无法覆盖这一差异。

本次目标是统一业务触发条件，保留平台各自的投递方式。浏览器权限、页面生命周期和操作系统通知行为仍由 Web 适配器负责，不能承诺与原生桌面完全相同。

## 2. 行为约定

相同配置和相同根会话事件，应在两端产生相同的通知意图。

| 输入或场景 | 统一行为 |
|---|---|
| 根会话 `approval/asked` | 等待 `approvalDelayMs`，默认 300 ms；仍未决定才通知 |
| 延迟内收到对应 `approval/decided` | 取消计时，不通知 |
| 已通知的审批被决定 | 清除派生的待审批状态，发出撤回信号 |
| 根会话 `turn/end` 为 `completed` 或 `max-tokens` | 按 `notifyOnTurnEnd` 通知完成 |
| 根会话 `turn/end` 为 `error` | 按 `notifyOnTurnError` 通知错误 |
| `aborted`、`blocked`、`interrupted`、`forked` 及未支持的结束原因 | 不通知 |
| subagent 的审批与回合结束 | 不通知，即使当前界面正在查看该 subagent |
| 切换会话、打开设置、页面进入后台 | 不改变 Host 的监听范围 |
| 无浏览器连接或通知权限被拒绝 | Host 继续处理事件；不阻塞 Agent 或审批 |

两端共用四个配置项：`notifyOnApproval`、`approvalDelayMs`、`notifyOnTurnEnd`、`notifyOnTurnError`，默认值沿用 Desktop。两个插件仍分别从自己的 loader 行读取配置；共用实现不意味着自动同步两个 profile 的配置。

Desktop 的声音、PowerShell、AppUserModelID 等配置不迁入共享触发逻辑。Web 保留当前语言翻译、通知点击聚焦并打开对应会话的行为。本次不处理此前讨论的触屏授权问题，也不引入 Service Worker 或关闭页面后的推送。

## 3. 模块划分

```text
已提交的 session/event
          │
          ▼
@local/notify-host
全局监听、根会话过滤、延迟、去重、结束原因判断
          │
          └── NotificationUpdate
                   ├── desktop-notify → Windows 通知
                   └── notify-web Host → 认证 SSE → 浏览器通知

@local/notify-core
两端共用的通知词汇、文案、locale 与纯格式化函数
```

`notify-host` 与 `notify-core` 是 `packages/` 下的私有构建期库，不是新的可安装插件。两种适配器分别在自己的 profile 中实例化同一份 Host 实现；不是让 desktop 与 web 两个 Host 进程共享一个运行中的对象。

| Module | 职责与对外 Interface |
|---|---|
| `packages/notify-core` | 浏览器安全的通知类型、纯格式化与 locale；不导入 Cordis、Node 或浏览器全局对象 |
| `packages/notify-host` | 提供创建通知源的 Interface；内部拥有全局监听、计时器、待审批状态及清理 |
| `desktop-notify` | Windows Adapter；把通知意图格式化为现有中文文案并调用现有投递实现 |
| `notify-web` Host | Web Adapter；持有通知源、短期投递缓存、SSE 路由和连接生命周期 |
| `notify-web` Client | 连接通道、处理去重、按 locale 格式化、显示或关闭通知、处理点击 |

变化点放在“通知意图交给投递 Adapter”这一 seam。共享 Module 不知道 PowerShell、HTTP、Notification API 或当前选中的会话；适配器不再重复判断根会话或 `turn/end.reason`。

## 4. 共享 Host 触发逻辑

### 4.1 通知源的 Interface

建议以一个通知源封装行为，概念 Interface 为：

```text
createNotificationSource(ctx, options)
  subscribe(listener) → unsubscribe
  snapshotPendingApprovals() → 当前已到通知时间且仍待处理的审批
  dispose() → 注销监听并清空计时器和派生状态
```

名字是拟议的插件内部 Interface，不是 DSH 已有接口。`ctx`、Session 事件和 Agent 类型必须使用版本匹配的 DSH 类型包，不另造事件结构来绕过类型检查。

通知源在插件激活时建立一次全局 `session/event` 监听。新增浏览器连接只订阅这个源，不能为每个连接重新执行全局注册。

### 4.2 统一输出

输出为浏览器安全的可序列化联合类型，概念上包含：

| 更新 | 必需信息 |
|---|---|
| `show` | `id`、`sessionId`、源事件 `seq`、发生时间、通知种类及必要参数 |
| `withdraw` | 对应通知 `id`、`sessionId`、撤回所依据的源事件 `seq` |

通知种类为审批、完成或错误。参数只包含必要的工具名、经裁剪的理由或错误摘要，不传输完整 Session、工具参数、工具结果或异常堆栈。Host 传递语义数据，Browser 按自己的 locale 生成文案；Desktop 继续使用中文翻译。

`id` 从会话与触发事件身份派生，例如 `sessionId + askedSeq` 或 `sessionId + turnEndSeq`。审批状态另用 `sessionId + approvalId` 关联 `asked` 与 `decided`，避免不同会话的审批 id 冲突。重连不能重新生成通知 id。

### 4.3 事件处理与生命周期

1. 激活时依赖 `agents`，通过真实 Agent registry 判断根会话，不读取 `mainView`。无法确认根身份时不把未知 Agent 当成根会话。
2. `approval/asked` 建立可取消计时器；同一审批的重复事件不产生第二个通知。已有审批的决定与清理应先处理，避免 Agent 刚被释放时因根身份检查失败而留下旧计时器。
3. 延迟到期时再次检查审批仍有效且插件未卸载，再发布 `show`。Root 身份已经失效的待发审批取消。
4. `approval/decided` 撤销计时器或已经发布的审批。会话或 Agent 释放时清理其待处理状态；具体生命周期事件使用 DSH 的真实声明，不自造 Session 事件。
5. `turn/end` 立即按共用规则发布完成或错误；投递异常隔离在 Adapter 内，不能向会话事件处理传播，也不等待浏览器确认。
6. 插件 effect 释放时注销全部监听、清除计时器并禁止迟到回调继续投递。重复 `dispose` 安全。

这些状态都是已提交 Session 事件的派生缓存，不写入新的 Session event，也不成为模型的事实来源。通知源从本次激活开始观察；首次激活和 Host 重启不扫描历史并重弹旧通知。跨 Host 重启恢复仍待审批的通知不属于本次范围。

## 5. Web 通知通道

### 5.1 使用 Connection 精确路由提供 SSE

拟议路由为 `GET /api/notify-web/events`，通过已核实存在的 `ctx.connection.fetch.register(...)` 注册，返回 `text/event-stream` 的流式 `Response`。

这一选择基于当前 DSH `0.2.1-rc.2` 的实现：

- Connection 持有 `/api` bridge，在分派前完成 Host/Origin 校验和 Peer 认证；精确 Fetch 路由仅允许 owner Peer。
- `ctx.remote.$on` 只能订阅 DSH 明确转发的事件，名单没有 `session/event`。
- `registerRemoteEvents()` 注册的是唯一应用事件 source，已由 DSH 的 API Remotes 使用；插件不能注册第二份去覆盖它。
- 普通 `webServer.register()` 路由没有自动认证，不能直接把通知内容挂到该层并假定安全。

SSE 是单向通道，适合 Host 主动发送通知；不需要额外监听端口、添加第二套登录机制或修改 DSH 本体。若以后使用 Typert Remote stream，需要增加生成产物和 Client contribution 的构建装配；本次无需为通知引入这套构建链。

浏览器通过同源 `fetch` 读取 SSE，携带现有 Cookie，以便明确处理 401、403、404 与断流。URL 按 DSH 的页面 base URI 规则解析相对的 `api/notify-web/events`，支持反向代理挂载前缀；不硬编码地址、端口、profile 或认证 token。恢复游标作为查询参数传入，只允许长度受限、格式有效的 epoch 与非负安全整数序号；非法格式返回 400，有效但过旧的游标走重置流程。

请求的 `AbortSignal`、响应流取消、插件卸载与连接断开都必须释放订阅。响应使用 `Cache-Control: no-store, no-transform`；按配置发送 SSE 注释心跳并及时输出，验证代理不会把通知缓冲到连接结束。心跳只是维持通道，不轮询 Agent 状态。[SSE 格式说明](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)

### 5.2 通道协议与断线处理

Session 的 `seq` 是每个会话独立的序号，不能直接充当跨会话 SSE 游标。Web Host 为每次插件激活生成 `epoch`，再为投递更新分配单调递增的 `deliverySeq`；游标由二者组成。通知 `id` 仍保留源事件身份。

协议带版本号，包含两类消息：

| 消息 | 内容及处理 |
|---|---|
| `sync` | 当前 `epoch`、水位、待审批通知快照、带游标的近期更新 `replay`，以及是否发生游标重置 |
| `update` | 水位之后的一条 `show` 或 `withdraw`，携带投递序号 |

Host 在激活时只建立一个共享源订阅，不按连接重复注册。打开连接时先把该连接加入广播集，再同步读取待审批快照和水位 N，并生成带 `pending` 与 `replay` 的 `sync`；这期间到达的广播进入该连接的缓冲。`sync` 发出后再发送序号大于 N 的 live `update`，因此建立快照与订阅之间不会漏事件。

拟议恢复策略：

- **第一次连接，没有游标**：同步仍待处理的审批，只接收之后的完成/错误，不弹打开页面之前的历史完成提示。
- **同一 epoch 的短暂断线**：根据最后处理的游标补发缓存内的完成/错误，并用当前审批快照对账。断线期间已决定的审批不先补弹再撤回。
- **缓存过期、游标越界或 epoch 改变**：发 `sync` 重置，只同步当前待审批状态，不假装完整补齐丢失区间。Browser 清除旧审批显示状态。
- **401/403**：停止紧密重试，等待 DSH 连接恢复或重新认证；不重新交换启动 token。
- **网络故障、暂时 404 或 SSE 正常 EOF**：统一等待后重连，退避从 500ms 指数增长，带最多 25% 抖动且最终等待不超过 30s。连接持续至少 30s 后，下一次重试恢复基础等待；短暂的 200/EOF 不重置退避。401/403 保持 30s 认证重试间隔；卸载 Client 时取消等待。

缓存只在当前 Host 内存中保留，初始建议 `replayWindowMs=120000`、`maxReplayEntries=256`；同时按时间和条目数裁剪。广播时和每次打开 SSE、计算补发前都执行裁剪，确保长时间无新事件时也不会补发过期通知。缓存过期不删除通知源中的当前待审批快照。每个连接设置有限输出缓冲，慢消费者溢出时关闭该连接并让其重连对账，不阻塞所有消费者或无限累积内存。心跳、重试和容量属于 Web 通道配置，不迁入共享业务规则。

这是有限窗口内的恢复机制，不是持久消息队列。浏览器处理游标、持久化去重记录和操作系统显示之间没有原子事务，不承诺严格 exactly-once，也不把 `new Notification()` 成功等同于用户已看到通知。

## 6. 浏览器适配器

删除 Client 对 `uiSession.sessionStatus`、`sessions.list`、`mainView` 和逐会话 `eventSource` 的通知订阅。Client 不再决定何种 Session 事件值得通知。

保留 `locale`、`uiWorkspace.openSession()` 和现有浏览器通知权限流程。收到 `show` 后按当前语言格式化，使用稳定的通知 id/tag 去重；收到 `withdraw` 或 `sync` 中缺席的旧审批时关闭对应浏览器通知。每个会话的完成通知仍只保留最新一条。

点击通知关闭该提示，尽力 `window.focus()`，随后打开消息中的 `sessionId`。会话已删除或不可访问时记录受控诊断；点击行为不能重新触发审批或执行工具。

### 多标签页

同源、同一应用 base 路径的标签页使用 Web Locks 竞争一个通知投递锁；只允许持锁页面建立 SSE 并显示通知。只有支持 Notification 且已获授权的页面参加竞争，避免无投递能力的页面占住锁。锁名包含插件与应用 base 路径，避免同一 origin 下不同挂载相互干扰。持锁页面卸载或正常离开时关闭流并释放锁，其他页面接管。[Web Locks 的同源互斥语义](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)

游标与有上限、带过期时间的已处理通知 id 集合存于该应用命名空间的浏览器存储中，供接管页面继续处理；不保存通知正文。接管时只使用同一 epoch 且仍在恢复窗口内的游标，较旧记录按首次连接处理。

没有 Web Locks 或共享存储不可用时，降级为每页独立消费，依靠稳定 tag 和页内去重减少重复，并明确不能保证跨标签页只提示一次。不同浏览器、浏览器配置目录或设备互不选举，各自可以收到通知。浏览器冻结持锁页面时仍可能延迟通知；本方案不增加依赖后台计时器的抢锁协议。

## 7. Desktop 兼容性与构建

`desktop-notify` 删除私有的触发判断，订阅 `notify-host` 的输出；Windows 投递脚本、声音、聚焦协议与现有配置保持兼容。`withdraw` 至少在共享状态中清理；现有 Windows 适配器没有可靠撤回接口，本次不承诺撤回已经显示的原生 toast。两端对齐的是是否产生通知及其内容语义。

两个插件继续保留各自的 `dsh.targets` 和最先执行的 `assertTarget`。Web Host 增加实际使用的 `agents`、`connection` 等依赖声明；Client 删除已不需要的直接注入项，但保留 workspace 导航自身需要的依赖装配。

`notify-host`、`notify-core` 均由 esbuild 内联进插件。构建顺序明确为共享库依赖先于消费方，不能只依赖目录名字的排序。新增 DSH 类型依赖固定到运行时版本，Node 实现不得被 Client bundle 引入。tarball 中不得残留运行时 `@local/notify-host` 或 `@local/notify-core` 裸导入。

## 8. 实施顺序

1. **验证通道最小闭环**：在一次性 web profile 中验证 Connection 精确路由、认证拒绝、SSE 增量到达和取消清理，以及反向代理 base 路径解析。只发送合成通知，不读写用户会话。
2. **提取共享 Host Module**：建立 `notify-host` 的 Interface、类型与行为测试，迁移 Desktop。用现有 Desktop 测试确认默认触发语义保持兼容。
3. **实现 Web Host Adapter**：连接共用通知源，加入 SSE 协议、审批快照、有限缓存与有界输出队列；增加 Web 侧共同配置。
4. **替换 Web Client 触发链**：删除基于当前视图的监听，实现通道消费、locale、撤回、点击、多标签页接管和去重。
5. **验证安装与真实能力**：运行构建、打包契约、一次性 profile 的 L4 和浏览器端验收；最后更新两个 README 的行为、配置与限制。

第一步验证的是现有 Connection route 能否可靠承载这条流，不是为插件增加匿名 HTTP 后门。若流式 bridge 或类型包暴露不足，应先解决该具体限制并更新方案，不能悄悄改成未认证的 WebServer 路由。

预计改动集中在 `packages/notify-host/`、`packages/notify-core/`、两个插件的 Host/Client、相关清单与构建脚本，以及 `test/`。不改 dsh 本体，也不修改用户现有 profile 来完成测试。

## 9. 验证与验收

| 验证层 | 必须覆盖的行为 |
|---|---|
| 共享触发逻辑 | 根会话与子会话；所有结束原因；四个开关与延迟；同 id 跨会话审批；自动决定抑制；重复事件；Agent 释放；卸载后计时器不再触发 |
| 两端一致性 | 对同一组真实类型 Session 事件，两个 Adapter 接收到相同的通知意图序列；平台投递差异单独断言 |
| 通道 | 无认证 401、来源拒绝及非 owner 拒绝；同步快照与增量无缺口；断线补发；已解决审批不补弹；epoch 重置；慢消费者与资源清理 |
| Client | 去重、审批撤回、中文/英文、权限拒绝、点击会话、重连、锁接管、存储不可用降级、卸载无残留订阅 |
| 构建与打包 | 类型检查；Host/Client bundle 分离；无共享库运行时依赖；link 和独立 tarball 的入口都能加载 |
| 真实 Web 验收 | A 运行时切 B，A 完成/出错仍通知；后台根会话审批仍通知；查看 subagent 不产生其通知；两个标签页不重复提示；断开再恢复能按约定对账 |

运行仓库的 `build -Check`、`build`、L1–L3 与 L4。浏览器测试不能只检查启动 HTML 包含模块名；需要真正驱动通知消息，验证构造通知与点击导航。操作系统是否展示提示还要单独实测，模拟 Notification 不能代替这一项。

## 10. 实现依据

仓库现状参考 [Desktop 通知入口](../desktop-notify/src/index.ts)、[Web 通知入口](../notify-web/src/client/index.ts)、[共享文案](../packages/notify-core/src/index.ts)、[测试计划](testing-plan.md) 与 [仓库约定](../AGENTS.md)。

通道选择依据本机 DSH `0.2.1-rc.2` 打包的以下实现与说明，升级运行时后需要重新核对：

- `@deepseek-ai/dsh-client-connection`：`HostConnectionService.fetch.register`、`createSharedFetchHandler`、`admit`；精确路由的 owner 限制及 `/api` bridge 的认证流程。
- `@deepseek-ai/dsh-api-session-controller`：已有 `/api/file` 精确 Fetch 路由；Client 的逐 Session `eventSource` 和 retain 生命周期。
- `@deepseek-ai/dsh-api-remotes`：`API_REMOTE_FORWARDED_EVENTS` 的显式转发名单。
- `@deepseek-ai/dsh-api-gateway`：`registerRemoteEvents` 的唯一 source 约束和生成 Remote contribution 的装配要求。
- `@deepseek-ai/dsh-host-webserver`：普通 route 不提供服务器级认证。

以上依据确认了扩展点和责任归属；SSE 的真实安装、流式到达与浏览器验收安排在实施第一步和最终验收中。
## 11. 落地步骤与实现记录

本节把上面的方案拆成可执行步骤，并记录实现时确认的 DSH 事实与必要修正。代码已经按本节落地；真实浏览器的操作系统提示与点击验收仍列为待办。

### 11.1 文件与职责

| 路径 | 内容 |
|---|---|
| `packages/notify-host/src/index.ts` | `createNotificationSource`、根会话过滤、审批延迟/撤回、`agent/disposed` 清理、可序列化 `NotificationUpdate` |
| `packages/notify-host/package.json` | 私有构建期 workspace 包；只做类型和声明，无运行时入口 |
| `packages/notify-core/src/index.ts` | 两端共用文案、locale、`approvalContent`、`turnEndContent`、`clip` |
| `desktop-notify/src/index.ts` | 只保留 Windows Adapter：订阅共享源，把 `show` 格式化后交给 PowerShell |
| `notify-web/src/index.ts` | Web Host：共享源、`GET /api/notify-web/events`、SSE 缓存/恢复/心跳/有界队列 |
| `notify-web/src/client/index.ts` | 浏览器 Adapter：SSE 消费、locale、权限、去重、撤回、点击、Web Locks 多标签页 |
| `notify-web/package.json` | Host 声明 `agents`、`connection`；Client 只注入 `locale`、`uiWorkspace` |
| `scripts/src/commands/build.ts` | 先构建 `packages/*`，再用 esbuild 内联 Host/Client |
| `test/src/l3/notify-host.test.ts` | 共享触发行为 |
| `test/src/l3/notify-web-host.test.ts` | 真实 Fetch route 的 SSE 协议 |
| `test/src/l3/notify-web-client.test.ts` | 用 VM 驱动 SSE 帧、Notification 和点击 |
| `scripts/src/commands/l4.ts` | 真实 web profile 的认证 SSE 冒烟检查 |

### 11.2 Host 通知源 Interface

```text
createNotificationSource(ctx, TriggerOptions)
  subscribe(listener) -> unsubscribe
  snapshotPendingApprovals() -> ApprovalShowUpdate[]
  dispose()
```

`TriggerOptions` 只含四个共用字段：`notifyOnApproval`、`approvalDelayMs`、`notifyOnTurnEnd`、`notifyOnTurnError`。

实现约定：

- 激活时建立一次全局 `session/event` 与 `agent/disposed` 监听；每个 Adapter 只实例化一次，Browser 连接不重新注册全局监听。
- 根身份通过 `ctx.get('agents')` 的真实 registry 判断；registry 缺失或抛错时返回 `false`，不再保留旧 Desktop 的“registry 缺失就当作根”的 fallback。
- `approval/asked` 先记待发状态并启动计时器；同一 `sessionId + approvalId` 的重复事件不创建第二条。
- `approval/decided` 先于根身份检查处理，确保 Agent 已释放时仍能清计时器并撤回已显示的审批。
- `turn/end` 只映射 `completed`、`max-tokens`、`error`；其余结束原因静默。
- `agent/disposed` 清理该 Session 的待发计时器，并对已显示的审批发出 `withdraw`。
- `dispose` 注销两个监听、清计时器、清派生状态；迟到回调不再投递。
- `approvalDelayMs` 到期时再次检查根身份；身份失效则不显示。

### 11.3 SSE 路由与协议

路由固定为：

```text
GET /api/notify-web/events
```

通过 `ctx.connection.fetch.register({ path: '/api/notify-web/events', methods: ['GET'], requestBody: 'buffered', fetch })` 注册。Connection 在分派前完成 Host/Origin 校验和 Cookie/Peer 认证；精确 Fetch 路由只允许 owner Peer，未认证请求由 `/api` bridge 返回 401/403。响应为流式 `Response`：

```http
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-store, no-transform
x-accel-buffering: no
```

Host 为每次插件激活生成随机 `epoch`，为每个投递更新分配单调递增的 `deliverySeq`。`sync` 的 `seq` 是当前水位；`replay` 只含 `seq` 不大于该水位的缓存更新；之后的 `update` 一定带更大的 `seq`。

```jsonc
// event: sync
{
  "version": 1,
  "epoch": "uuid",
  "seq": 12,
  "reset": false,
  "pending": [
    {
      "type": "show",
      "kind": "approval",
      "id": "sessionId:approval:approvalId",
      "sessionId": "sessionId",
      "seq": 7,
      "at": 1770000000000,
      "toolName": "pwsh",
      "reason": "bounded reason"
    }
  ],
  "replay": [
    { "type": "show", "kind": "turn-end", "id": "sessionId:turn-end:11", "sessionId": "sessionId", "seq": 11, "at": 1770000000000, "reasonKind": "completed" },
    { "type": "withdraw", "kind": "approval", "id": "sessionId:approval:approvalId", "sessionId": "sessionId", "seq": 12, "at": 1770000000000 }
  ]
}

// event: update
{
  "type": "update",
  "seq": 13,
  "update": {
    "type": "show",
    "kind": "approval",
    "id": "sessionId:approval:approvalId",
    "sessionId": "sessionId",
    "seq": 8,
    "at": 1770000000000,
    "toolName": "pwsh",
    "reason": "bounded reason"
  }
}
```

恢复规则：

- **首次连接（无游标）**：`replay` 为空，只同步当前待审批；不回放打开页面前的历史完成/错误。
- **同一 epoch 的短断线**：根据 `epoch + seq` 补发缓存内更新，并用 `pending` 对账；缓存中同一审批的 `show` 若后面还有 `withdraw`，补发时丢弃该 `show`，避免先弹再撤。
- **epoch 改变、游标越界或缓存过期**：`reset: true`，只同步当前待审批；Browser 关闭旧审批通知并清失去意义的去重记录。
- **非法游标**：400；格式有效但过旧：重置。
- **401/403**：Client 停止紧密重试，按认证恢复节奏慢轮询；不重新交换启动 token。
- **网络/404/正常 EOF**：统一执行 §5.2 的等待与退避；插件重新启用后可恢复。

缓存只存在于 Host 内存；默认 `replayWindowMs=120000`、`maxReplayEntries=256`，在广播和新连接计算补发前按时间与条目数裁剪。每个连接有 `maxQueuedUpdates` 有界缓冲；慢消费者被关闭后重连对账，不影响其他连接。

### 11.4 Web Host 配置

| 字段 | 默认 | 作用 |
|---|---:|---|
| `notifyOnApproval` | `true` | 审批通知开关 |
| `approvalDelayMs` | `300` | 审批延迟；期间决定则取消 |
| `notifyOnTurnEnd` | `true` | 完成 / max-tokens 通知开关 |
| `notifyOnTurnError` | `true` | 错误通知开关 |
| `heartbeatMs` | `15000` | SSE 注释心跳间隔，开启计时器后最低 1000ms |
| `replayWindowMs` | `120000` | 断线补发时间窗口 |
| `maxReplayEntries` | `256` | 补发缓存条数上限 |
| `maxQueuedUpdates` | `256` | 单连接输出队列上限 |

Desktop 仍从自己的 loader 行读取四个共用字段和 Windows 专属字段（`sound`、`appId`、`soundFile`、`powershell`）；两个 profile 的配置不会自动同步。

### 11.5 Browser Adapter 细则

- Client 不再注入 `api-session-controller`、`ui-session`，也不订阅 `uiSession.sessionStatus`、`sessions.list`、`mainView` 或 `session.eventSource`；只保留 `locale` 与 `uiWorkspace`。
- 使用相对 `document.baseURI` 的 `api/notify-web/events`，支持反向代理 base 路径；不硬编码 host/port/token。
- `show` 用稳定 tag 去重，审批通知按 `id` 保存；同一 Session 的完成/错误只保留最新一条。
- `withdraw` 或 `sync.pending` 中缺席的审批会关闭对应通知。
- 点击通知关闭提示、尽力 `window.focus()`，再 `uiWorkspace.openSession(sessionId)`；点击不会重新触发审批或工具。
- 插件加载时立即请求尚未决定的通知权限；自动请求结束后仍为 `default` 时，首次用户手势补充请求一次。已拒绝时不重复申请；只有支持 Notification 且权限已授予的页面参与 Web Locks 竞争。此行为于 §11.14 更新，早期验收记录保留当时的请求方式。
- Web Locks 锁名包含应用 base 路径；持锁页卸载/离开时关闭流并释放锁，其他页接管。
- 游标与带过期时间、上限的已处理 id 集合写入该应用命名空间的 `localStorage`。游标只在取得投递锁、开始一次接管时读取；同一持锁期间的网络重连一直使用最新内存游标，读写失败或存储中的旧值不会覆盖它。接管时，同 epoch 的存储游标也不能倒退内存进度；存储不可用时保留本页内存游标和去重状态，但无法保证跨页面恢复。
- 页面首次加载或重新取得投递权后的首个 `sync` 恢复当前待审批提示；同一持锁期间的普通重连遵守已处理 id 去重，不重新弹出用户已关闭的提示。服务端 `reset` 或 epoch 改变仍清空旧状态并重新对账。
- `pagehide` 停止流、关闭通知；`pageshow`/`bfcache` 恢复时重新竞争锁。
- 没有 Web Locks 时每页独立消费，靠稳定 tag 与页内去重降低重复，不承诺跨标签页只提示一次。

### 11.6 实施步骤（已完成）

1. 新建 `packages/notify-host`，把根会话过滤、审批延迟、`turn/end` 判断从 `desktop-notify` 抽出；用 `agent/disposed` 清理。
2. 重构 `desktop-notify`：`inject = ['agents']`，订阅共享源，只保留 PowerShell/声音/焦点协议；更新测试的监听数量、重复审批、未知根身份语义。
3. 实现 `notify-web` Host：新增 `Config`、`agents`/`connection` 注入、SSE route、epoch/deliverySeq、缓存、恢复、心跳、有界队列。
4. 重写 `notify-web` Client：删除视图/事件流触发，改为 SSE 消费；保留 locale、权限、点击；加入 Web Locks、cursor/seen 存储、`pagehide`/`pageshow`。
5. 更新构建：`notify-host` 加入 `packages/*`，根 `devDependencies` 与 lockfile；构建顺序由依赖驱动而不是仅目录排序；确认两个 bundle 内联共享库。
6. 更新测试：`notify-host`、Web Host route、Client SSE、Desktop 兼容性；L4 增加认证 SSE 首帧检查。
7. 更新 `notify-web` README、Desktop README、`AGENTS.md`、`docs/testing-plan.md`、`CATALOG.md`。

### 11.7 初次实现验证（2026-10-25）

- `node scripts/bootstrap.mjs build --check`：通过。
- `node scripts/bootstrap.mjs build`：通过；`notify-web/lib/index.js` 与 `client.js`、`desktop-notify/lib/index.js` 均无运行时 `@local/notify-*` 裸导入。
- `node scripts/bootstrap.mjs test`：189 个测试通过。
- `node scripts/bootstrap.mjs l4`（含 tarball 阶段）与 `l4 --skip-tarball`：均通过；真实 web profile 的 L4 额外验证了未认证 SSE 返回 401/403、认证请求返回 200、`content-type: text/event-stream` 且首帧为 `event: sync`。
- 当时尚未完成：真实浏览器中由用户手势授权、操作系统通知真正弹出、点击聚焦标签页的视觉验收。模拟 Notification 不能替代这一项；后续原生验收结果见 §11.11。

### 11.8 实现中确认/修正的点

- DSH `HostConnectionService.fetch.register` 的精确路由路径是包含 `/api` 的绝对路径（已有 `/api/file` 为证）；`requestBody` 必须显式声明，SSE 使用 `buffered`。
- `createSharedFetchHandler` 以 `for await (const chunk of response.body)` 写出响应，并处理 `drain`；`bridge` 为每个请求创建与 `res.close` 绑定的 `AbortController`，因此流式 SSE 和取消清理可用。
- 浏览器 `/api` 请求通过 `dsh-auth-*` HttpOnly Cookie 认证；精确 route 只接受 owner Peer。Client 不需要也不应该自行读取 token。
- 旧 Desktop 在 agents 不可用时默认“视为根”；本方案改为“无法确认根身份就不通知”，并同步修改了对应测试。
- 同一审批的重复 `approval/asked` 不产生第二条通知；旧测试“覆盖为最新一条”同步改为“只发第一条”。
- SSE `sync` 用 `replay` 数组携带游标之后的缓存更新，而不是在 `sync` 后另发一批小于水位的 `update`；这样 `sync.seq` 与后续 live `update.seq` 的单调关系明确。
- Client 的首次 `sync` 不因 `currentEpoch` 为空而清空持久化的 seen 集合；只有服务端 `reset` 或 epoch 改变才重置。待审批仅在页面加载或重新接管后的首个 `sync` 强制恢复；普通重连不绕过去重，避免反复弹出已关闭的提示。
- `l4` 先交换一次启动 token 并保留 Cookie，再访问 SSE；避免一次性 token 被 `fetchHtml` 消耗后误判。

### 11.9 重连边界修复与回归测试（2026-10-27）

本次修复四个审查发现，触发规则和 Desktop 适配器保持原有行为：

| 问题 | 修复 | 回归覆盖 |
|---|---|---|
| 存储不可用或写入失败时，重连丢失/倒退游标 | 仅在接管时读取共享游标，网络重连使用内存进度 | 存储读写全失败、仅写失败且残留旧游标；重连携带最新游标并处理补发完成通知；等待锁期间由前任更新游标 |
| 没有新事件时仍补发过期通知 | 新连接计算 `replay` 前裁剪缓存 | 控制时钟，验证窗口内正常补发、超过窗口且无新事件时 reset，同时保留当前待审批 |
| 普通重连重新弹出用户已关闭的审批 | 首次接管恢复与普通重连去重分开 | 关闭提示后重连不再弹出；页面重载、pagehide/pageshow、epoch 重置仍恢复待审批 |
| SSE 正常结束后立即密集重连 | EOF 与异常统一等待，短连接指数退避，稳定连接重置退避 | 连续 EOF 必须等计时器触发才发请求；延迟递增及 30s 上限；稳定 30s 后回到基础等待；卸载取消等待 |

回归位于 `test/src/l3/notify-web-client.test.ts` 与 `test/src/l3/notify-web-host.test.ts`，新增 7 项。Client 使用可控重试计时器，Host 使用可控时钟，不依赖真实等待两分钟来验证过期。

重连修复完成时的验证（后续 L4 排障结果见 §11.10）：

- `node scripts/bootstrap.mjs test` 通过，共 196 项（包含构建及 L1–L3）。
- `node scripts/bootstrap.mjs build --check` 通过。
- `node scripts/bootstrap.mjs l4 --timeout 30000` 已运行，在 `install-link` 阶段因 pnpm 报 `ERR_SQLITE_ERROR: unable to open database file` 中止，尚未进入真实 SSE 检查。

§11.7 的 189 项与 L4 通过记录属于初次实现；此阶段 L4 被安装环境阻塞，之后已完成排障和复验。模拟通知不代表浏览器视觉验收完成。

### 11.10 pnpm 数据库排障与完整 L4 复验（2026-10-27）

数据库错误发生在 pnpm 11.28.5 的 store 初始化阶段：`index.db` 打开后执行 `PRAGMA journal_mode=WAL` 失败。运行时继承的 `PNPM_HOME` 使默认 store 落在 `%LOCALAPPDATA%\pnpm\store\v11`，处于本次沙箱的写权限之外。

修复与运行条件：

1. L4 的 DSH 子进程和打包进程统一使用本次运行目录下的 `pnpm-store`，不再依赖用户全局 store。环境同时设置 `pnpm_config_store_dir`（pnpm 11）和 `npm_config_store_dir`（兼容旧版）。本机已验证 pnpm 11 不采用后一个变量来覆盖 store，不能只设置它。
2. 当前 PATH 选中的是 Desktop 自带的 Electron CLI，因此通过 `DSH_CLI` 显式选择已安装的普通 Node 版 DSH 0.2.1-rc.2。CLI 解析器增加 pnpm 生成的 `%~dp0\node.exe` shim 支持，直接以 Node 运行其 JS 入口，保持 Web Host 身份和服务子进程生命周期正确。
3. 独立 store 解决数据库问题后，沙箱内仍因 pnpm 建立项目目录链接而报 `EPERM`。完整复验在允许创建这些链接的沙箱外执行；profile、store、tarball 与日志仍全部位于仓库 `.tmp/l4/<runId>/`，未修改用户已有的 DSH profile。

实际执行：设置 `DSH_CLI` 指向上述 Node 版 `dsh.cmd` 后，运行 `node scripts/bootstrap.mjs l4 --keep --timeout 30000`。本次选用的 shim 为 `<Node 版 dsh.cmd 的绝对路径>`，该安装路径仅为本次环境记录，重新安装后需重新定位。

结果：**8 个 L4 阶段全部通过**。

| 阶段 | 已确认内容 |
|---|---|
| prerequisites / profile-init | 构建产物可用，临时 Web profile 装配成功 |
| install-link / web-link | 三个插件链接安装、行启用；Web 返回 200，boot HTML 含 Client 模块，无激活警告；通知 SSE 未认证请求被拒绝，认证请求返回事件流及 `sync` 首帧 |
| install-mismatch / web-mismatch | 不匹配场景的 fixture 明确报告 failed，Web 服务仍可用 |
| install-tarball / web-tarball | `approval-allowlist` tarball 安装为真实副本并成功启动；此阶段不是 notify-web 的 tarball SSE 验证 |

每次 Web 检查完成后均停止测试服务并确认端口关闭。报告保留于 `.tmp/l4/20261027154908-61w12B/report.json`，其 `ok` 为 `true`；同目录 `logs/` 保存过程记录，独立 store 已成功生成 `v11/index.db`。临时目录与报告不入库。

最终校验：

- `node scripts/bootstrap.mjs test`：**198 项通过**，包括新增的 npm/pnpm Windows shim 解析回归测试。
- `node scripts/bootstrap.mjs build --check`：通过。
- 完整 L4（包含 tarball 阶段）：通过。
- 本阶段未验收：真实浏览器授权、操作系统通知显示、点击聚焦及真实多标签页操作；L4 是 HTTP/加载/SSE 验证，不包含这些 UI 行为。后续结果见 §11.11。

### 11.11 原生浏览器通知验收（2026-10-28，Asia/Shanghai）

**本机 Windows + Codex 内嵌浏览器验收通过。** 两个同源真实标签页运行实际 DSH Web UI、`notify-web` Client、认证 SSE 和 Web Locks。通知权限由用户实际允许，系统通知由用户实际点击；本次没有用模拟 Notification 或合成 click 事件代替。

测试环境与证据方法：

- 新建 `.tmp/native-notify/run-22t4mE/`，使用独立 DSH profile、pnpm store 和测试工作区。由 `web-hello` fixture 在测试根会话中追加真实的 `turn/end`、`approval/asked`、`approval/decided` 事件，不调用模型，也不触及用户既有会话。
- 临时观察插件位于 `.tmp/native-notify-fixture/`，通过透明 Proxy 将构造调用转发给浏览器原生 Notification，并记录原生 `show`、`click`、`close`、`error` 事件。它不替代权限结果、不拦截 SSE、不修改 Web Locks 或产品的通知判断。
- 观察面板展示通知 id/tag、`event.isTrusted`、点击后的 `document.hasFocus()` / `document.visibilityState` 以及 `navigator.locks.query()` 结果；实际会话切换同时用 DSH UI 的选中行和回合内容核对。
- 最初通知权限为 `default`，请求等待人工处理；用户允许后为 `granted`。这段等待没有被误记为功能失败或通知验收通过。

| 检查 | 实际观察 | 结果 |
|---|---|---|
| 原生完成通知弹出 | 标签页 2 的测试会话完成后，标签页 1 收到一次 `construct: Turn completed` 和 `show: trusted=true`；用户确认看到了系统通知 | 通过 |
| 真实点击与聚焦 | 用户确认“只看到一条，已点击并切回 DSH”；接收页记录 `click: trusted=true`、`close: trusted=true`，300ms 后 `focus=true; visibility=visible` | 通过 |
| 点击打开通知对应会话 | 标签页 1 从原选中会话切到标签页 2 触发完成事件的会话；UI 选中行变化，并显示目标会话的两个已完成回合 | 通过 |
| 完成通知跨标签页去重 | 两页构造次数分别为 1 和 0；用户也确认只看到一条。锁快照为 `notify-web:/` 的一个 exclusive 持有者、一个等待者 | 通过 |
| 审批通知跨标签页去重 | 同一审批在两页的构造次数分别为 1 和 0，持锁页收到原生 `show: trusted=true` | 通过 |
| 审批撤回 | Host 的 withdraw 请求返回 200，持锁页对应审批随后收到原生 `close: trusted=true` | 通过 |
| 持锁页关闭后的接管 | 关闭标签页 1 后，原等待页成为唯一持锁者，等待队列为空；接管时未创建历史通知。再次触发完成后，该页创建一次新通知并收到原生 `show: trusted=true` | 通过 |

证据保存在 `.tmp/native-notify/run-22t4mE/`（不入库）：

- `report.json`：本次结果、范围与清理记录。
- `completion-click-tab1.txt`、`completion-tab2.txt`、`completion-click.jpg`：完成通知、真实点击、焦点与双页计数。
- `approval-tab1.txt`、`approval-tab2.txt`、`withdraw-tab1.txt`：审批去重与撤回。
- `handover-before.txt`、`handover-after.txt`、`handover-after.jpg`：接管前后记录。

截图展示的是浏览器页面及观察记录，未包含 Windows 系统通知面板；弹窗肉眼可见和实际点击由用户确认，原生事件记录提供补充证据。验收后已关闭两个测试标签页及其通知，停止临时 Web 服务并确认端口关闭。产品源码未因本次验收改动。

范围限制：本次结论针对 Windows 的 Codex 内嵌浏览器，不能推广为独立 Chrome/Edge、macOS 或后台冻结/操作系统勿扰模式的全覆盖。现有 L5 中替换 Notification 的自动测试仍只用于逻辑验证，不能单独代表本节的原生验收。

### 11.12 最终完整本地 CI（2026-10-28，Asia/Shanghai）

**统一入口的四个阶段全部通过，进程退出码为 0。** 本次在 Windows、Node 24.21.0、pnpm 11.28.5、普通 Node 版 DSH 0.2.1-rc.2 下运行，时间为 01:24:44–01:26:03，总耗时约 78.3 秒。L5 使用本机 Google Chrome 的 headless 模式。

实际命令（运行时与 CLI 路径仅记录本机环境，不作为固定配置）：

```powershell
$node = "$env:USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
$env:DSH_CLI = '<Node 版 dsh.cmd 的绝对路径>'
& $node scripts/bootstrap.mjs ci --keep --timeout 120000
```

| 阶段 | 结果 | 验证内容 |
|---|---|---|
| type-check | 通过，0.7 秒 | targets、CATALOG 门禁及共享库、插件 Host/Client 的 TypeScript 检查 |
| L1–L3 | 210 项通过，0 失败、0 跳过，7.9 秒 | 重新构建，契约、通知触发/重连回归、CLI shim、harness 生命周期、CI/L5 报告与失败处理 |
| L4 | 8 个阶段全部通过，42.5 秒 | 独立 profile 初始化、link 安装与认证 SSE、场景不匹配、tarball 安装及启动；tarball 范围仍为 `approval-allowlist` |
| L5 | baseline 与 fixture 均通过，合计 5 项，27.2 秒 | 无自定义插件基线；真实 slot 交互、Host 往返、浅色/深色、中英文及刷新；中英文审批/完成通知与撤回；拒绝权限后不订阅也不通知 |

L5 的五项结果分别为 `no-custom-plugins`、`slot-interaction-theme-locale-reload`、`notification-en`、`notification-zh`、`notification-denied`，全部 `ok: true`。控制台/页面异常门禁通过；Windows 宿主已知的 `/open-in-app/icon/explorer` 404 单独记录，只有该精确路径的已知错误被排除，其他错误和 slot 崩溃仍使测试失败。

本次自动化使用真实 Chrome、DSH Web UI、Host 与 SSE，但替换 Notification 以断言内容、权限和关闭行为；系统通知实际弹出、人工点击聚焦及跨标签页原生验收仍以 §11.11 的独立证据为准。未运行远程 GitHub Actions 或 macOS 测试。

保留的本地证据（均不入库）：

- `.tmp/ci/run-kve4E9/report.json`：总报告，四阶段退出码均为 0，`ok: true`。
- `.tmp/l4/20261027172453-IaZoh2/report.json`：L4 八阶段结果，`ok: true`；同目录保留安装/服务日志。
- `.tmp/l5/run-VsqJLV/report.json`：L5 两场景结果，`ok: true`；`artifacts/baseline/results.json` 与 `artifacts/fixture/results.json` 保存五项断言结果，子目录保存截图、trace 和页面诊断。

`--keep` 保留临时 profile、store 和证据目录；测试服务与浏览器在各阶段结束后关闭，服务端口关闭由 harness 检查。L1–L3 中出现的预期失败日志用于验证失败报告和清理路径，不代表本次 L4 失败。上述报告路径是本次运行记录，后续运行应以各自新生成的报告为准。

### 11.13 仓库 Web 配置与实际启动入口验收（2026-10-28）

当时的日常 `web` profile 保留插件管理器建立的 `@local/notify-web` 链接安装与 bundle 启用记录。通知参数由当时的 `profiles/web/cordis.patch.yml` 管理，通过 `start.ps1` 的 `--patch` 加载；本次没有手改用户目录的 profile 配置或安装记录。该文件现已迁为 example 与本机 patch，当前用法见 [Web 配置说明](../profiles/web/README.md)。

- 仓库 patch 用 `id: notify-web` 覆盖已安装插件的行，不重复 `insert`。显式配置审批/完成/错误通知为开启，审批延迟 300ms，心跳 15000ms，补发窗口 120000ms，缓存与单连接队列上限各 256。
- HMR `root` 新增 `<repo>\notify-web\lib`，保留原有路径及 Windows 排除规则。共享库先构建并内联进插件；Client 代码更新后仍需刷新浏览器。
- 插件源码未改；`node scripts/bootstrap.mjs build` 通过，包含元数据门禁、TypeScript 编译与 bundle 生成。

本次先检查日常 profile 与仓库 patch 的实际合成结果：`notify-web` 只有一行且未禁用，八个参数和 HMR 新路径均匹配，无配置警告。随后因已有日常 Web 服务运行，保留原进程，在独立临时 profile 中安装同一个仓库插件，并实际调用：

```powershell
pwsh -NoProfile -File profiles/web/start.ps1 --no-open --host 127.0.0.1 --port 0
```

验证进程通过环境变量选择临时 `DSH_HOME`、普通 Node 版 `DSH_CLI` 及相应 Node PATH。`start.ps1` 的解析、`Start-Process`、仓库 `--patch` 和 URL 等待流程均实际执行，没有改用测试 harness 直接启动 `dsh web` 来代替这个入口。

| 检查 | 结果 |
|---|---|
| 日常与临时 profile 加载同一份仓库通知配置及 HMR root | 通过 |
| `start.ps1` 启动、Web HTTP 200、boot HTML 注册通知 Client | 通过 |
| 通知 SSE 拒绝未认证请求，认证后返回 200 / `text/event-stream` / `sync` | 通过 |
| 插件激活警告 | 无 |
| 测试进程树停止、端口关闭 | 通过 |
| 日常 profile 的 `package.json`、`cordis.patch.yml` 前后哈希一致 | 通过 |

报告保存在 `.tmp/web-overlay/run-GdTde5/report.json`，`ok`、`cleanup`、`dailyConfigUnchanged` 均为 `true`，日志与临时 profile 不入库。此项为仓库启动入口和配置集成验收，未重新验证 HMR 文件变化后的热重载，也未重新执行系统通知弹窗/点击；原生行为证据仍见 §11.11，完整本地 CI 结果见 §11.12。

日常旧服务未被重启，仍需用户停止后通过 `dshweb` 或 `profiles/web/start.ps1` 重新启动，再刷新浏览器并允许通知。

### 11.14 加载时立即申请浏览器通知权限（2026-10-28）

旧 Client 在首次点击或按键时申请权限，虽然不依赖通知事件，但打开页面后仍可能一直没有申请。现在插件加载时读取权限：`default` 立即调用 `Notification.requestPermission()`；`granted` 直接竞争通知锁并连接 SSE；`denied` 保持关闭，由用户在浏览器站点设置中重新允许。

自动请求结束后若权限仍为 `default`，首次点击或按键补充请求一次。同步抛错与 Promise 拒绝也走这一回退。等待请求期间不注册补充请求监听，避免并发询问；补充请求执行前移除监听，不因之后的交互反复申请。卸载后忽略尚未完成的权限请求结果，不重新连接 SSE 或注册监听。

浏览器可能要求用户交互，立即调用 API 不保证页面加载时一定出现授权弹窗；相关约束见 [Notification.requestPermission 文档](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static#examples)。本次只调整 Client，Host 触发规则、仓库通知配置与日常 profile 安装记录均未改；已重新生成 `lib/client.js`，链接安装的页面刷新后加载新版。

回归验证：

- L3 权限用例从 1 项扩展为 11 项：无事件/无手势立即申请、等待期间去重、三种自动请求回退、补充请求后不反复询问、已授权/已拒绝不申请、本次拒绝不连接、卸载后忽略两类延迟结果。
- 类型检查及 L1–L3 全部通过：**220 项通过，0 失败、0 跳过**。
- 完整 L4 八阶段通过，报告为 `.tmp/l4/20261027180656-q5fLAE/report.json`。
- L5 基线与插件场景全部通过，共五项。允许/拒绝场景均从 `default` 开始；在任何点击、按键、测试会话创建或通知触发之前，确认权限已经请求一次且输入事件计数为 0。允许后继续验证真实 SSE 与通知内容，拒绝后确认不建立通知流。

首次统一 CI 在 L5 中因测试使用 `navigator.userActivation.isActive` 断言而失败；Playwright 的 Chromium 脚本执行本身会携带 `userGesture: true`，该标记不能可靠证明实际点击。已改为在页面初始化时记录 `pointerdown` / `keydown` 输入事件，产品代码不变，并单独重跑 L5 通过。

证据保留于 `.tmp/ci/run-p0iDbU/report.json`（前三级通过、初次 L5 失败）和 `.tmp/l5/run-BgnAw4/report.json`（修正断言后 `ok: true`），后者的 `artifacts/*/results.json` 保存五项成功结果。没有将初次 CI 总报告改写为成功。L5 仍替换 Notification，仅证明调用时机与逻辑；本次没有重新进行浏览器原生权限弹窗的人工验收。

### 11.15 远端自动化验收（2026-10-30）

提交 `d9f2a12` 的 [GitHub Actions run 41061844806](https://github.com/mbda9091/dsh-plugin/actions/runs/41061844806) 在 Windows、macOS 均通过类型检查与 L1–L5。L5 使用实际 DSH Web、Chromium、认证 SSE 和通知插件，替换操作系统 Notification API，覆盖权限请求/拒绝及中英文通知内容；这补齐了 macOS 的 Web 自动化证据。

原生权限弹窗、系统通知显示、真实点击聚焦、操作系统勿扰/后台冻结仍不由该 CI 覆盖。§11.11 的人工证据限于当时 Windows Codex 内嵌浏览器；§11.14 改动后的原生权限流程、独立 Chrome/Edge 和 macOS 的人工验收仍待补。完整远端记录与当前待办见 [测试方案 §19.7、§20](testing-plan.md#197-远端-ci-验收2026-10-30)。
