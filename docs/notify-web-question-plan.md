# notify-web 用户提问提醒方案与迭代记录

> 本文使命：补齐 Web 根会话调用 `ask_user_question` 后等待用户回复时的系统通知。
> 完成：否。状态：待验收（实现已提交，用户已确认通知恢复并认可交付；A9 点击/撤回实机分项尚未单独记录）。
> 更新日期：2026-11-16（Asia/Shanghai）。完成日期：—。归档：未归档。
> 实现 commit：`dcfff6c1f72220de31c0cd26d0ab27bd8392f1c9`；本次提交对账见第 9.9 节。
> 调研基线：`bd43b4b593cfae04a6e2bbe427508fc9aefc587c`，调研开始时工作区干净。
> 验收基线：当前实现提交 `dcfff6c1f72220de31c0cd26d0ab27bd8392f1c9` 与最终 2.2.0 固定包对账；历史批次保留追溯：固定批次 `7f6b4d98-078f-4036-9c63-c049bb21fe01`，2.1.0 首轮固定包见第 9.2 节；2.1.1 修正结果见第 9.4 节；历史 2.1.2 固定批次为 1a9b44ae-e5c9-4205-9a51-c76bcce076ff，升级防护与验证见第 9.6 节。当前 2.2.0 固定批次为 3b5d6f25-b04e-4226-b7d7-757ce9bfeafb，见第 9.7 节。
> 关联：[现有通知设计与历史验收](archive/notification-host-design.md)、[测试方案](testing-plan.md)、[notify-web 使用说明](../notify-web/README.md)。

## 1. 结论摘要

当前通知源只处理权限审批与回合结束，遗漏了用户提问。`ask_user_question` 等待回答时不满足这两个条件，因而不会向 SSE 发出提醒；这是已确认的代码能力缺口。尚未读取用户日常会话或检查其浏览器权限，不能据此排除运行环境同时存在其他问题。

本轮为 notify-web 增加独立的 question 通知类型，以已提交的会话事件重建待回答状态，沿用认证 SSE、Web Locks、浏览器权限申请、点击跳转与诊断能力。覆盖标准工具的阻塞提问、限时等待及超时后继续接受回复的状态；回答后撤回，重连不复活已回答的问题。Desktop 行为保持原约定。

当前实现为 notify-web 2.2.0 / 协议 v3：Client 收到提问请求后提醒，保留持久状态、去重、撤回和跨标签处理。固定包的 Firefox/Chrome 自动回归通过并已安装。用户强制刷新 Firefox 后确认通知恢复，随后表示“没问题”并授权提交 push。实现已提交；未把整体认可扩写为未单独反馈的 OS 点击/撤回实测证据。

用户随后指出提醒早于卡片，明确拒绝固定等待，并选定 Client 收到 user-questions/request 的时机。2.2.0 改动及验证见第 9.7 节；此入口不等于卡片已绘制完成。

## 2. 范围与完成条件

目标行为：浏览器收到根会话的 `user-questions/request` 后，已授权且保持打开的 Web 页面收到一次“需要你的回复”通知；正文为首个问题摘要，点击后聚焦页面并进入对应会话。在 A 提问后切换到 B，不影响 A 的通知。

覆盖范围：

- 标准原生工具调用，包括无限等待与带 timeout 的调用；一批多个问题合为一条通知。
- 原生/PTC 调用记录仅建立候选，不能直接通知；收到 Remote 请求后才提醒。带调用 ID 的请求沿用持久状态处理 pending/晚答，无调用 ID 的阻塞请求按该次 Remote 请求生命周期关闭。
- 回答、失败、取消、Agent 释放、SSE 重连、页面刷新与多标签页接管。
- 现有审批、完成、错误通知的行为回归。

本轮不识别普通聊天正文问句。按用户选定的 Remote 入口，无调用 ID 的直接提问请求也按实时请求生命周期提醒，不伪造工具调用对应关系或持久会话记录；其提醒恢复依赖宿主重新转发请求。approval intent 跳过，避免重复审批提醒。

关闭标签页后的后台推送、Service Worker、通知中心与 Desktop 新增提问提醒也不属于本轮。浏览器通知未授权时沿用现有授权流程。

完成条件：第 8 节必要验收项全部通过，真实 OS 通知与点击行为有人工证据；实现提交、固定产物与验收基线可核对。文档完成或模拟 Notification 通过不代表功能完成。

## 3. 现状与依据

| 对象 | 已有实现与依据 | 本轮影响 |
|---|---|---|
| 通知触发 | [notify-host](../packages/notify-host/src/index.ts) 的 `onSessionEvent` 只分支处理 `approval/asked`、`approval/decided`、`turn/end`；其他事件返回 | 提问不会生成通知意图 |
| Web 投递 | [Host](../notify-web/src/index.ts) 的 pending 快照、重放过滤只认识审批；[Client](../notify-web/src/client/index.ts) 的 show、idKind、sync 同样只认识审批/结束 | 仅补 Host 触发还不够，须贯通协议、重放与 Client |
| DSH 提问 | 本地 workspace 安装的 DSH `0.2.2-rc.1`：`dsh-tool-ask-user/lib/index.js` 调用 `ask` / `askTimed`，`dsh-user-questions/lib/index.js` 使用 `user-questions/request` waterfall | 提问与 `approval/asked` 是不同路径，不应套用审批文案 |
| DSH 状态 | 同一版本 `dsh-user-questions` 的 `userQuestions` 投影从 `request/header`、`tool/call`、`tool/result`、`tool/ptc-dispatch`、`user/message` 重建限时提问；legacy blocking schema 不纳入其状态 | 参考并对齐其语义，新增通知投影补齐阻塞调用，不能只读现有 active 数组 |
| 晚到回答 | `user-question-reply` 在实际提交为 `user/message` 后才关闭问题；排队中的回答可被丢弃 | 点击回答或 RPC 返回成功不能提前撤回 |
| 最近演进 | `fc90f9d4498e24bb3d7402416032fc619150c5ea` 增加诊断与串行重连；`7011a6b53a65b62254dc5ad21a16611f88500d41` 升级宿主类型 | 保留诊断与连接代次隔离，不恢复旧版 Client 事件订阅机制 |

历史通知方案已完成并归档。本轮增加新的触发能力，不修改其完成结论，也不复用历史报告宣称本轮通过。

## 4. 具体方案（已实现，验收边界见第 8、9 节）

### 4.1 Web 专用提问源与持久投影

在 `notify-web/src/` 新增提问源和 Host-only 投影模块，与已有 `createNotificationSource` 合并输出。共享 notify-host 仍负责原有审批/结束逻辑，避免为 Web 修复扩大 Desktop 行为。

使用 `ctx.sessionProjections.register()` 注册独立、带版本的投影，例如 `mbda9091.notifyWebQuestions`。await 注册完成后再挂载提问消费者和 SSE 路由；生命周期交给 Cordis effect，卸载释放投影 handle、监听器和定时器。`apply` 仍先执行目标守卫。缺少投影服务时明确加载失败，不静默降级为漏提醒。

投影 `apply(state, event)` 纯同步，仅消费真实 DSH 类型，忽略无关事件时返回原引用。状态保存每个待回答调用的 callId、来源 seq/time、问题摘要、open/continued 状态及必要的 schema 信息；不用内存 Map 作为待回答事实来源，不 append 自定义 session event。schema 校验库作为构建依赖内联，不新增 profile 运行时依赖。新增 DSH 类型依赖固定 `0.2.2-rc.1`，同步 lockfile。

| 已提交事件 | 提问状态变化与通知含义 |
|---|---|
| `request/header` | 记录当前 ask 工具是否为 timed schema，按真实工具定义解释后续结果 |
| 原生 `tool/call`，name 为 `ask_user_question` | 安全解析问题列表，非空且有效时进入 open；损坏 JSON/空问题不通知，不影响宿主执行 |
| 对应 `tool/result` 返回回答或执行失败 | 移除 open/continued，撤回该通知；普通失败不作为新提问 |
| timed 调用返回 pending | 转 continued，沿用同一通知 id，不撤回、不重复 show |
| timed 调用恢复修复结果 `TOOL_OUTCOME_UNKNOWN` | 对齐宿主语义：保留为 continued；legacy 调用不推断仍可回复 |
| `tool/ptc-dispatch-start` 为 ask 子调用 | 以 subCallId 建立 open 候选，等待 Client 收讫；记录 rootCallId 以便中断恢复时收敛 |
| `tool/ptc-dispatch` 为 ask 子调用 | 回答/失败撤回；pending 转 continued、保持同一 id；旧日志缺 start 时仍可从 pending 恢复 |
| 父 run_code 的 tool/result | 清理尚无子调用 outcome 的 open；保留 continued，避免恢复后悬挂或误撤回 |
| `user/message` 的 source 为 `user-question-reply` | 仅移除 source.callId 对应的调用；排队但未提交的回复不关闭 |
| `turn/end` | continued 仍可回复，不能因 completed/error 一律删除；取消中的 open 依据工具最终结果收敛 |

投影读取使用注册返回的 `handle.stateOf(session)`，不依赖 session/event 监听器的先后顺序。投递仅覆盖真实 Agent registry 确认的 runtime root，与当前页面选中会话无关。忽略继承前缀中的旧提问，避免 fork 继承日志导致误弹；按 DSH 的 inheritedEventCount 边界实现并测试。

根 Agent 注册/恢复时，从其 Session 重建当前待回答状态；Agent 释放时撤回当前投递并清理派生缓存。若恢复为新的 root，仍可回答的问题可以再次进入 pending。SSE 快照读取时重新校验 root，防止注册、恢复与连接竞态遗漏。Host 候选状态可由投影重建；Client 是否收到过请求由浏览器收讫记录决定，不能从工具日志反推。无 callId 的实时请求另由 Remote 生命周期管理。

### 4.2 通知时间、正文与配置

新增 Web 配置 `notifyOnQuestion?: boolean`，默认 true；旧 profile 未设置时直接取得默认值。新生成的 profile defaults 加入这一项，保留安装器对已有配置不覆盖的约定。现有 `notifyOnApproval` 不控制提问。

工具调用只建立候选，Client 收到 user-questions/request 后才具备提醒资格，不加固定延时。通知插件在第一阶段仅依赖 remote 注册观察器，UI 消费器另等 uiWorkspace/locale；先调用 next() 放行真实卡片处理器，保持回答/错误原样传递。带 wait.callId 的请求写入仅含 ID 的收讫记录并传给 SSE 持锁页；无 callId 的阻塞请求由实际接收页面直接提醒，返回、失败或取消时撤回。认证 GET /api/notify-web/options 提供开关及协议版本，不依赖日常配置内容的客户端推断。

- 中文标题“需要你的回复”，英文“Reply needed”；首个问题经空白归一和裁剪后作为正文，空摘要使用本地化兜底。
- 多问题批次只发一条，通知不携带完整选项、回答、方案正文或工具参数。
- 保持既有正文长度限制；通过 notify-core 增加文案函数与中英文键，不改变 Desktop 通知开关或触发。
- 并存多个调用时逐 callId 管理；question tag 与 approval、turn-end 分离。
- 保留已有完成/错误通知：continued 与回合结束是不同事实，不为隐藏重复感而删除完成通知。

### 4.3 SSE 协议、重放与 Client

新增 Web 专用联合类型 `WebNotificationUpdate`，包含原有类型与 question show/withdraw；例如 id 为 `${sessionId}:question:${callId}`。协议类型放在 Web 包内共用文件，Host 与 Client 同源导入；不把新增 question 强行塞进 approval。

`pending` 扩展为仍有效的审批与提问通知。快照合并、重放过滤及 Client `idKind`、`applyUpdate`、`applySync` 都按待处理类型处理：

1. 建立一致的当前 pending 快照，再提供增量；不可在收集快照和注册订阅之间丢事件。
2. 缓存中的 question show 若已不在 pending，不重放，避免断线期间已回答的问题短暂复活。
3. 同一 callId 从 open 到 continued 不改变 id；重复事件、SSE replay 和快照相遇不重复弹。
4. Client sync 后关闭已不在 pending 的带调用 ID 的 question，withdraw 仅关闭对应 id；无 callId 的实时请求不由 SSE 空快照关闭。
5. 沿用 localStorage 的游标和过期 id 集合，不向持久存储写问题正文；重连通常不重弹，页面重载/持锁页接管按既有 pending 恢复策略恢复一次。
6. 保持单一消费循环、AbortController 取消与连接代次隔离。卸载后的异步结果不得再 show 或重新订阅。

Host/Client 协议 version 为 3，Client 对未知版本明确诊断并停止消费，提示刷新页面；不把不支持的 question 当作 turn-end。Host 更新后需重启、Client 需刷新；不承诺已打开的旧 Client 能展示新类型。保留原 v1 字段含义，升级失败可回退固定旧包并重启刷新，未新增会话事件格式需要迁移。

沿用认证 SSE 和 Web Locks，新增只读 options 请求及浏览器间收讫信号，不轮询 Agent 状态。诊断仅记录版本、类型、id、seq 与错误，不输出问题全文。点击通知仍调用 `window.focus()` 和 `ctx.uiWorkspace.openSession(sessionId)`，不操作其他插件 DOM。

### 4.4 文件与交付范围

| 位置 | 预计工作 |
|---|---|
| `notify-web/src/` | 新提问投影、提问源、Web 协议类型；Host 合并源及 pending/replay，Client 渲染/同步/版本判断 |
| `packages/notify-core/src/index.ts` | 提问文案、摘要与中英文翻译键 |
| `notify-web/package.json`、`profile.defaults.patch.yml`、lockfile | 必需的开发依赖、构建打包覆盖、新配置及版本更新 |
| notify-web / notify-core README、locale | 行为边界、开关与升级步骤，保留场景前缀；元数据变更时由 catalog 生成目录 |
| `test/src/l1`、`test/src/l3`、`test/fixtures/web-hello`、`test/e2e` | 状态、协议、通知与真实 DSH 生命周期覆盖 |

构建由现有 dev.mjs 入口生成 lib，不手改或提交 lib/dist。日常安装按用户已授权范围执行，保留现有配置，不自动重启日常 DSH。

## 5. 里程碑

| 阶段 | 事项与出口条件 | 状态 | 实现 commit |
|---|---|---|---|
| M1 | 提问投影及 Web 源；阻塞、timed、continued、晚到回复、PTC pending、恢复、PTC start 及 root 过滤测试通过 | 自动验收通过，已提交对账 | `dcfff6c1f72220de31c0cd26d0ab27bd8392f1c9` |
| M2 | 协议、SSE、Client、配置与文案接通；重放/撤回/多标签页测试通过 | 自动验收通过，已提交对账 | `dcfff6c1f72220de31c0cd26d0ab27bd8392f1c9` |
| M3 | 构建检查、L1–L5、固定包能力与真实 OS 人工验收；回写版本、证据、遗留并核对提交 | 自动验收通过，用户确认恢复；A9 点击/撤回分项待记录 | `dcfff6c1f72220de31c0cd26d0ab27bd8392f1c9` |

## 6. 决策记录

| 决策 | 理由 | 日期 |
|---|---|---|
| 使用已提交事件和专用投影，不把 request waterfall 作为唯一通知源 | 兼顾恢复、重放和晚到回答；旁观监听不能抢占 answerer 或阻断 next() | 2026-11-16 |
| 新源放 Web 包内，沿用共享审批/结束源 | 满足本轮 Web 目标，Desktop 无新增能力承诺 | 2026-11-16 |
| pending 与 replay 同步扩展，协议明确升级 | 防止已回答问题复活和旧 Client 误解析；升级要重启并刷新 | 2026-11-16 |

## 7. 风险与待核验项

| 项目 | 已知事实或待核验内容 | 处理时点 |
|---|---|---|
| 原问题具体路径 | 缺用户现场会话证据；已确认标准工具缺通知，尚不能断言现场一定是该路径 | M1 用真实 ask 工具复现；若属于第 2 节未覆盖路径，回写并讨论范围 |
| 执行前误提醒 | tool/call 可能随后参数校验失败或被取消 | M1 测试失败/取消的撤回；不把所有叫同名的任意数据都视为有效提问 |
| 生命周期竞态 | 注册投影为异步；root 注册、释放及 Session 事件可能交错 | M1 验证先注册后发布、恢复快照与 effect 清理；不依赖监听顺序 |
| timed/PTC 结果格式 | 本地 DSH 实现与真实原生/PTC 请求链路已通过隔离验证 | M1 用实际类型、真实 Session 和工具执行固定语义，避免手写 any 或错误 mock 掩盖问题 |
| OS 通知限制 | 权限、系统勿扰和页面冻结影响真实展示；模拟通过不代表真实弹窗 | M3 在目标 macOS 浏览器人工验证并记录版本和截图，不伪报跨平台通过 |

## 8. 验收状态

验收对象：实现提交 `dcfff6c1f72220de31c0cd26d0ab27bd8392f1c9`、最终固定批次 3b5d6f25-b04e-4226-b7d7-757ce9bfeafb。自动测试使用 Node 24、workspace DSH 0.2.2-rc.1 与临时 home，覆盖 macOS Firefox/Chrome。用户实际使用 Firefox；未宣称 Windows/Linux 实机通过。

| 项目 | 可观察的预期结果与验证方式 | 当前结果 / 证据 |
|---|---|---|
| A1 标准提问 | 工具调用记录出现时不提醒；Client 收到请求后每批一条 | 通过 / 真实原生工具、Host 闸门、Remote 卡片、L3/L5；第 9.7 节 |
| A2 回答与继续 | 回答/取消撤回；带 ID 的 pending 保留，晚答按持久事件关闭 | 通过 / L3 生命周期与真实卡片提交；第 9.7 节 |
| A3 异常与身份 | root/继承边界正确；错误不被观察器吞掉；卸载与取消清理 | 通过 / L3 Session 投影、Client 错误原样传递与生命周期回归 |
| A4 PTC 生命周期 | PTC start 不直接提醒，收到 Remote 请求后提醒；结果/pending 正确收敛 | 通过 / L3；真实 PtcExecutor 的 question-ptc-received-sse；第 9.7 节 |
| A5 重连与协议 | 收讫页与持锁页可不同，接管恢复不重复；旧协议明确拒绝 | 通过 / L3、Firefox/Chrome question-leader-handover；第 9.7–9.8 节 |
| A6 开关与文案 | 禁用不提醒；中英文/裁剪正确；浏览器存储无正文 | 通过 / L1/L3 与真实浏览器回归 |
| A7 浏览器行为 | 实际卡片交互、主题/locale、权限流程及原有通知正常 | 通过 / Firefox 和 Chrome 各 baseline 1 项、fixture 7 项；Notification 使用测试替身 |
| A8 构建与回归 | 类型检查、L1–L5、固定 tarball 能力验证通过 | 通过 / 259 项中 258 pass、1 条平台条件跳过；固定包 L4/L5；第 9.7 节 |
| A9 实机交付 | macOS Firefox 实际弹窗、点击聚焦对应会话、回答后撤回 | 部分已确认 / 用户强制刷新后确认恢复并认可交付；未单独反馈点击/撤回分项，不补造证据 |

实施后的命令入口：

```sh
node scripts/dev.mjs build --check
node scripts/dev.mjs test
node scripts/dev.mjs l4
node scripts/dev.mjs l5
```

L4/L5 沿用固定产物和临时环境协议，报告保存实际输出路径（通常为 `.tmp/l4/`、`.tmp/l5/`）。扩展 fixture 时，纯注入 NotificationUpdate 的测试只算适配器测试；至少一条端到端路径须执行真实 ask 工具、提交真实 Session 事件，再通过认证 SSE 抵达浏览器，不能直接绕过新增提问源。

验收结论：A1–A8 自动验收及提交对账通过，用户确认实机通知恢复并认可交付。A9 点击/撤回实机分项未单独记录，保留待验收和完成“否”；这不阻止已授权的提交与 push。

## 9. 实施结果与修正

### 9.1 方案调研（2026-11-16）

- 实际完成：读取仓库规则、方案模板、通知相关 Git 历史，核对 Host/Client 与本地 DSH 提问实现，形成本文。
- 改动范围：新增本方案及文档导航；实现 commit 不适用，本次没有功能代码修改。
- 代码事实：现有触发类型不包含用户提问，Host/Client pending 仅覆盖审批；timed 超时后问题仍可回答，不能在工具返回或 turn/end 时一律撤回。
- 验证边界：仅静态代码与文档核对，未访问日常会话、profile、凭据；未运行构建或功能测试，未检查 OS 通知。
- 历史结论：保留已归档通知方案的完成事实；最近重连修复继续有效，本轮不重开旧方案。

### 9.2 实现与自动验收（2026-11-16）

- 实现 commit：未提交。变更包含 notify-web 的提问投影/源、Web 协议、Host/Client、配置/locale/README、notify-core 文案、开发依赖和 lockfile，以及 L1/L3/L5 与报告校验器。
- 实际行为：原生提问按 callId 通知；timed pending 保留；回答/失败撤回；根会话恢复与多标签页接管恢复 pending；已回答问题不重放。版本更新为 2.1.0，新增 notifyOnQuestion 默认 true；Desktop 无新增提问触发。
- 验证环境：macOS、Node v24.16.0、pnpm 11.28.5、workspace DSH 0.2.2-rc.1、系统 Chrome（具体启动信息见 L5 日志）；未测试 Windows/Linux 实机。
- build --check 通过，日志：<repo>/.tmp/notify-question-check.log。test 通过：248 项中 247 通过、0 失败、1 条 Windows launcher 条件跳过；跳过项不计为通过。日志：<repo>/.tmp/notify-question-test.log。
- 最终固定批次：`7f6b4d98-078f-4036-9c63-c049bb21fe01`；清单：<repo>/dist/batches/7f6b4d98-078f-4036-9c63-c049bb21fe01/manifest.json。
- notify-web 包：`mbda9091-notify-web-2.1.0.tgz`；SHA-256：`f806a32915fc07eaae837e2b93b957517670d744c37087e2104be3e781ddd363`。
- 固定包源码快照 SHA-256：`eb06038b7ab4f190c209aef142274b3f1e30251f8e08c022b18312d9c1e56ff4`；基于 `bd43b4b593cfae04a6e2bbe427508fc9aefc587c` 加未提交变更。产物与证据保存于本机，不提交 lib/dist。
- 固定包 L4 全部通过：<repo>/.tmp/l4/run-mle9dT/report.json；L5 全部通过：<repo>/.tmp/l5/run-c1iK5X/report.json。
- L5 基线 no-custom-plugins 和 fixture 的 6 项检查通过：slot/theme/locale/reload、真实提问工具→SSE→通知、Web Lock 接管、通知 en/zh/denied。截图和 trace 在该 L5 run 的 artifacts/ 下；OS Notification 被替换，不是实机系统通知证据。
- 总验证记录：<repo>/dist/verification/7f6b4d98-078f-4036-9c63-c049bb21fe01/web-mac.json，status=passed；verify-artifacts --check 已回读通过。验收后仅回写本方案及导航，固定包本身和运行时源未变；文档回写会改变仓库源码快照，后续重新交付时按现有机制重新打包，不把此包清单当作回写后全仓快照。

实施中修正：最初 fixture 缺少 agents 服务依赖，导致空 400；补齐后真实工具链路通过。新增 L5 用例需同步报告中的必需检查清单，现统一由 browserChecks 供普通验收和固定包验收使用，不能跳过提问检查报成功。一次固定包验收期间并行 test 重建构建记录，验收按预期拒绝；最终在回归结束后顺序 pack→verify-artifacts，并以上述最终批次结果为准。

环境记录：Corepack 自动发现曾返回带噪声的入口输出，使用同版本 pnpm.cjs 显式覆盖；沙箱内临时端口受限，完整测试和真实 Web/Chrome 验收在获准的沙箱外执行。冻结安装沿用系统配置与 store，没有修改日常 DSH/profile。

本轮遗留：A9 的 macOS Chrome 真实系统通知、点击聚焦及回答撤回仍需人工验收；尚未提交对账。没有安装到日常环境，也未进行发布。恢复实施时，先核对本文未提交差异及实际验收基线，再完成这些事项。

### 9.3 安装到日常 Web（2026-11-16）

用户明确要求安装到日常环境进行试用。按运行中的 Web 进程及只读状态确认目标为默认 home 下的 macos-web，使用当前普通 Node 全局 DSH 0.2.2-rc.1，仅选择 @mbda9091/notify-web。安装器因文档回写后的源码快照变化自动重建/打包，未修改运行时代码。

- 安装批次：364a699a-38ed-447f-a155-181e3a921b88，版本 2.1.0；delivery 状态 installed，bundle registered，warnings 为空，已核对实际安装包版本和安装字节。
- 日常持久包：<archiveRoot>/364a699a-38ed-447f-a155-181e3a921b88/mbda9091-notify-web-2.1.0.tgz；archiveRoot 为用户默认持久 releases 目录。
- 现有 notify-web 配置完整保留，没有新增或覆盖已有配置行；notifyOnQuestion 省略时使用默认 true。
- 安装报告：<repo>/dist/consumption/run-1f8vPV/report.json；日志：<repo>/.tmp/notify-question-daily-install.log；持久回执位于 <archiveRoot> 同级 receipts。
- 未自动重启 DSH。运行中的 Host/Client 是否切换到新版尚未确认，A9 实机通知仍未执行，等待用户重启日常 DSH、刷新浏览器后试用并反馈。

### 9.4 PTC 提问漏提醒修正（2026-11-16）

用户反馈 2.1.0 安装并重启后，带选项/输入框的提问卡片仍没有通知。只核对了进程启动时间、版本和通知配置，未读取用户日常会话日志；尚未据现场证据确认该次卡片的具体调用路径。

确认的实现缺陷：上一版忽略了宿主已有的 tool/ptc-dispatch-start，只在 PTC 返回 pending 后才建立状态。对于无限等待的阻塞提问，用户回答前不会产生 dispatch 结果，所以会一直没有通知。原方案“PTC 结果前缺持久证据”的事实判断错误，已更正第 2、4、8 节；9.1–9.3 的原自动验收与安装事实保留，但它们没有证明 PTC start 提醒。

修正内容：版本 2.1.1，投影 stateVersion 升为 2，从 start 立即显示；对应 dispatch 回答/失败撤回、pending 保持稳定 id；父调用恢复结果清理没有子结果的 open，continued 继续等待晚答。仍不识别普通正文问句或无持久工具调用的直接服务请求。

证据：新增三条回归在旧实现上均失败，日志 <repo>/.tmp/notify-question-ptc-before.log；修复后提问源 12 条定向用例通过。原版 PtcExecutor 驱动的真实 run_code→ask_user_question→持久 start→认证 SSE→浏览器通知，以及回答撤回，在 L5 run-Xn5E4o 通过；报告 <repo>/.tmp/l5/run-Xn5E4o/report.json。完整回归通过：251 项中 250 通过、0 失败、1 条平台条件跳过，日志 <repo>/.tmp/notify-question-ptc-test.log；build --check 通过，日志 <repo>/.tmp/notify-question-ptc-check.log。

最终固定批次 `fdda4bce-2afa-44f3-8110-279be83e0fa5` 的 L4/L5 全部通过，验证记录 <repo>/dist/verification/fdda4bce-2afa-44f3-8110-279be83e0fa5/web-mac.json（status=passed）；报告分别位于 <repo>/.tmp/l4/run-7qnTmE/report.json 与 <repo>/.tmp/l5/run-s78SJW/report.json。L5 基线 1 项、fixture 7 项通过，新增 question-ptc-start-sse 为必须检查，验证在子调用尚未返回结果时已经显示通知。

随后安装到日常 macos-web，安装器输出 reuse-tarball，复用上述已验证包，版本 2.1.1；安装回读状态 installed、bundle registered、warnings 为空、配置保持原样。包 SHA-256：`70af2326bc603de09e3de4f15880e112ea0ba773aaa859d72c756bbe05957fab`，与验证清单一致。报告 <repo>/dist/consumption/run-CAf6Iz/report.json，日志 <repo>/.tmp/notify-question-ptc-daily-install.log。没有自动重启日常 DSH，等待用户重启、刷新页面后触发一次新提问。实机 OS 展示仍不以模拟 Notification 替代；未读取日常会话内容确认现场调用路径。

本节验收与安装完成后仅回写文档，运行时代码和固定包不再变化。实现 commit 仍为未提交。

### 9.5 Firefox 隔离排查（2026-11-16）

用户确认 Firefox 中完成/审批通知正常，只有带选项/输入框的提问卡片不提醒。用户已撤回读取日常会话元数据的授权；此后不读取日常会话、问题、回答或事件元数据，只检查源码和一次性测试环境。此前安装文件的核验不等于现场能力已生效，不再将“待实机验收”作为唯一遗留。

本次核对普通 Node 全局 DSH 与 workspace 的提问工具、提问服务、PTC 执行器、Session 和 Agent 代码，五项文件字节相同，未发现宿主代码版本漂移。现有测试覆盖原生/限时/PTC 持久事件，但浏览器仅有 Chrome。新增 Playwright Firefox 选择及对应命令环境测试，使用独立临时 browser context，不复用日常 Firefox profile；Firefox 157.0（Playwright build 1555）安装完成。此改动补齐测试能力，尚不构成现场漏提醒的根因或修复证据。

首次 Firefox L5 在专用浏览器尚未下载完成时启动失败（run-eGTBNy，缺可执行文件），不是插件功能失败。用户反馈新建空白对话也不弹通知；未查看该测试对话。

验证结果：build --check 通过（.tmp/notify-question-firefox-check.log）；L1–L3 共 252 项，251 通过、1 条平台条件跳过（.tmp/notify-question-firefox-test.log）。Firefox L5 基线及 fixture 全通过，报告 .tmp/l5/run-6DnDVT/report.json，日志 .tmp/notify-question-firefox-l5.log；覆盖原生提问、PTC start、回答撤回、标签页接管和原有通知。仍使用模拟 Notification API，没有证明 macOS 系统弹窗正常。此次仅改测试入口与文档，未新增插件修复或重新安装。

用户反馈空白测试也失败后，仅读取通知插件的安装依赖和加载配置，确认仅有 @mbda9091/notify-web 2.1.1、bundle 已登记，无重复通知包、无 notifyOnQuestion=false 或 disabled 覆盖；不读取任何日常会话及其元数据。请用户关闭全部 DSH 标签页后单页重试，以排除旧页面持有通知连接；用户确认关闭所有标签页后单页重开能够弹出提问通知，并确认访问本机 3080，排除安装目标不一致。

### 9.6 旧标签页占用通知锁的升级防护（2026-11-16）

现场事实：用户确认新建空白对话仍不弹，关闭全部 DSH 标签页后重新打开一个页面则能弹，访问目标确为本机 3080。未检查旧页面中的版本或会话数据，因此现场旧页面的具体版本未确认。

源码与隔离复现：基线旧 Client 对 update 的非 approval 类型直接走 turn-end，question 缺 reasonKind 而不显示；它不校验 sync 的协议版本，仍持有 notify-web:/ 的 Web Lock。新版原先也争抢该锁，导致旧页继续承担所有通知，新页一直等待。此机制能够重现“完成/审批正常、只有提问无通知”，与上述操作反馈一致。两条新增回归在修复前失败（.tmp/notify-question-legacy-before.log）：新版仍请求旧锁，Host 对未协商客户端仍返回 200。

修正为 2.1.2：Client 显式通过 protocol=2 协商现有 v2 协议；锁、cursor、seen 存储均加入协议版本，新页无需等待旧页退出。Host 对没有协议参数或不支持版本的请求返回 426，避免旧页误消费新事件以及与新页重复通知；新版收到 426 停止重试并提示刷新。安装后仍需用户重启宿主并刷新至少一页，不自动重启、不清理日常存储、不读取会话。

验证：build --check 通过；L1–L3 共 254 项，253 通过、1 条平台条件跳过（.tmp/notify-question-legacy-test.log）。L5 的原生工具用例新增同源旧页持锁场景，证明真实工具→SSE→新页通知不再被旧锁阻挡；固定包及 Firefox/Chrome 回归、安装结果见下方。此修复以协议兼容性为边界，不承诺解决同一协议下浏览器冻结持锁页的所有情况。

固定批次 1a9b44ae-e5c9-4205-9a51-c76bcce076ff 的验证通过：L4 报告 .tmp/l4/run-6RLSav/report.json；Firefox L5 报告 .tmp/l5/run-hfemis/report.json；总验证 dist/verification/1a9b44ae-e5c9-4205-9a51-c76bcce076ff/web-mac.json 为 passed。同一固定包的 Chrome L5 亦通过（.tmp/l5/run-SyRiRM/report.json）。两种浏览器均验证旧页面持有旧锁时，新页收到原生提问通知；同时验证 PTC、回答撤回、同协议标签接管与原有通知。系统 Notification 仍为模拟，用户前述实际弹窗成功证据属于 2.1.1 单页重开。

随后安装到日常 macos-web，复用上述固定批次的 2.1.2 tarball；报告 dist/consumption/run-uDTtCY/report.json 为 installed，bundle registered，warnings 为空，回读包版本为 2.1.2。包 SHA-256 为 18367d6e7311cf890d62f06301b710cdbf326936c87b0e144d3e03364d741511。安装保留已有配置；未自动重启，运行时加载及实机 2.1.2 仍待用户重启 DSH 后刷新至少一个页面。此后仅回写本文，不修改已验证代码或产物。代码未提交。

### 9.7 按 Client 收到提问请求触发（2026-11-16）

用户指出工具调用提醒早于卡片，否决固定等待，明确选择 Client 的 user-questions/request 入口。尚未实施过固定延时改动。

2.2.0 实现：第一阶段只依赖 remote 注册观察器，不等待 UI 服务；既有卡片处理器属于应用阶段。观察器同步调用 next()，不接管回答，不等待权限、HTTP 或通知才能放行卡片；回答与异常继续返回原流程。协议升为 3，工具事件不能单独触发系统通知。带 wait.callId 的请求通过仅含 ID 的收讫标记放行对应 SSE 候选，localStorage/BroadcastChannel 将标记传给通知持锁页；晚答/重连仍用持久投影清理状态。旧式无 callId 请求由接收页面管理实时通知，按结果/取消关闭，不按问题正文猜测工具调用。approval intent 不重复提醒。只读 options 路由使非持锁页也遵守 notifyOnQuestion 配置。

实际验证正在补齐：Firefox 已使用真实 UI 回答器验证原生/PTC 卡片与答案提交（.tmp/l5/run-aVsGN0/report.json）。测试先在 Host 挡住请求，确认工具记录出现后没有通知，放行 Remote 后再验证通知与真实卡片提交。当前 L1–L3 259 项，258 通过、1 条平台条件跳过（.tmp/notify-question-received-test.log）。最初 timed 测试夹具直接调用工具注册函数缺少 userQuestions 注入，已改为真实 agent.ctx.inject 后通过；这是测试夹具问题。不同页面接收请求/持有通知锁的检查及最终固定包验证已通过，见下方。

升级需重启 DSH 并刷新所有 DSH 标签页，防止旧页面接管提问却未安装收讫观察器；不自动重启，不读取日常会话。此时机仍不保证卡片已完成绘制，符合用户选定的“Client 收到请求”。无新会话事件、无模型内容变化。未提交。

最终 2.2.0 固定批次 3b5d6f25-b04e-4226-b7d7-757ce9bfeafb 验证通过：L4 .tmp/l4/run-JJptZ1/report.json；Firefox L5 .tmp/l5/run-qjzs7f/report.json；总验证 dist/verification/3b5d6f25-b04e-4226-b7d7-757ce9bfeafb/web-mac.json 为 passed。同一固定包的 Chrome L5 也通过（.tmp/l5/run-FPNvud/report.json）。真实浏览器验证 Host 闸门未放行时不提醒、Remote 到达后原生/PTC 提问提醒、真实卡片提交、跨标签收讫传递和接管恢复；OS Notification 仍由测试替身记录，实机时机待用户确认。最终 build --check 与 259 项回归通过（258 pass、1 条平台条件跳过），日志分别为 .tmp/notify-question-received-check.log、.tmp/notify-question-received-test.log。

已复用同一固定包安装到日常 macos-web，回读版本 2.2.0，installed / bundle registered / warnings=[]；报告 dist/consumption/run-vHR4XJ/report.json。包 SHA-256 为 440505aba7fc2ead15024fb1fdbdc95d47c6fca30bf95097c15f1029dfeedca0。配置保留，未自动重启。用户需重启 DSH 并刷新全部 DSH 标签页，再发起新提问验证。安装后仅回写本文，运行时代码和固定包不变；未读取日常会话或元数据。

### 9.8 全部通知停止的协议检查（2026-11-16）

用户反馈提问和完成通知均消失。仅读取插件安装文件及启动参数，确认日常目标仍为 macos-web/3080，当前进程启动晚于 2.2.0 安装，安装的 Host/Client 文件协议常量均为 3。没有读取会话、提问、回答或事件元数据。

用户主动提供的通知组件状态为 connected=false、leader=false、permission=granted、lastError=HTTP 426。已确认通知连接因协议不兼容被拒绝，不能归因为浏览器通知权限。最初代码审查提出的“Remote 注册异常拖累通用通知初始化”仅是潜在耦合风险，此现场未证实该异常，未据此修改代码。

用户关闭其他 DSH 标签页，并对保留页面执行 Firefox 强制刷新（macOS ⌘⇧R）后确认“恢复了”。结合 HTTP 426，定位为升级后页面仍保留不兼容 Client 导致通知流被拒绝；未读取浏览器实际旧协议号，不进一步区分页面内存与 HTTP 缓存来源。本次不需要重新构建或安装，未自动重启。2.2.0 的用户通知恢复已有人工反馈，点击跳转/撤回的完整 A9 与提交对账仍待完成。

### 9.9 提交对账（2026-11-16）

用户确认“没问题，提交 push 吧”，授权提交并推送当前 main。实现提交为 `dcfff6c1f72220de31c0cd26d0ab27bd8392f1c9`（fix(notify-web): notify after client receives question requests），包含 2.2.0 源码、测试、配置和文档，不含 lib/dist、临时报告、凭据或日常会话。

提交前回读最终固定包 source 清单，213 个文件逐一比对，唯一差异为本文追加的安装和现场反馈记录；运行时代码与测试均未变化，因此沿用第 9.7 节验证结果，不重新构建冒充原固定批次。git diff --check 通过；提交前 main 与 origin/main 同步。本文再以独立文档提交记录真实实现 SHA，与实现提交一并推送。

## 10. 当前未完成事项与下一步

2.2.0 已实现、验证、安装并提交对账，用户确认通知恢复且认可交付。A9 的真实点击聚焦/回答撤回未单独记录，保留为验收记录欠项；不据此撤销用户整体认可或阻断已授权的 push。未自动重启环境、未读取日常会话数据。后续若补充实机分项证据，再更新验收状态。
