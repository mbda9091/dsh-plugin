# @mbda9091/notify-web

在 **Web 界面（`dsh web`）** 中，当根会话需要回答问题、工具申请权限或一轮对话结束时，通过浏览器调用操作系统的系统通知；点击通知会关闭该通知，聚焦或打开 DSH 标签页并切换到对应会话。

## 适用场景

- 形态：Web（`dsh web` 的浏览器界面）；桌面应用、headless 不适用。
- 平台：Windows、macOS、Linux 宿主（浏览器通知本身跨平台；平台声明用于宿主侧的目标校验）。
- 声明：`package.json` 的 `dsh.targets` 为 `["web"]` / `["linux","mac","windows"]`。
- 桌面应用不在本插件适用范围；客户端检测到桌面启动标记时会主动跳过。原桌面通知插件已[归档停更](../archive/desktop-notify/README.md)。

## 行为

Host 全局监听已提交的 `session/event`，按真实 Agent registry 只处理根会话；与当前打开哪个会话无关。

| 触发时机 | 通知 |
|---|---|
| 浏览器收到根会话的 `user-questions/request` | 「需要你的回复」+ 首个问题摘要 |
| 根会话工具申请权限 | 「需要确认权限」+ 工具名/理由 |
| 根会话正常结束，goal 不存在或已完成，且子结果已汇总、无待处理输入 | 「对话已完成」 |
| 根会话 `turn/end` 为 `max-tokens` | 「本轮已达到输出上限」，提示任务可能尚未完成 |
| 根会话 `turn/end` 为 `error` | 「对话出错」+ 错误信息 |
| `aborted`、`blocked`、`interrupted`、`forked` 及其他结束原因 | 不通知 |
| subagent 的审批或回合结束 | 不通知 |

- goal 为 active（包括 disarmed）、paused 或 blocked 时，中间回合结束不发成功通知。标记 goal complete 不立即通知，等待主 agent 最终回复收尾。
- 等待过子 agent 的旧回合不补发完成通知；由主 agent 收齐结果并汇总后的新回合重新判断。新输入、新回合或卸载会作废旧检查。
- 每批提问一条通知。带 callId 的请求收到后才放行对应 SSE 候选；限时等待结束后仍可回答时保留，实际回答提交后撤回。旧式无 callId 的阻塞请求由接收页面提醒，回答、取消或请求结束时关闭。
- `tool/call`、`tool/ptc-dispatch-start` 只建立候选，不直接弹提醒。Client 在第一启动阶段订阅 Remote 提问入口，先调用 next() 放行真实卡片处理器，再处理通知；不加固定延迟，也不承诺卡片已经完成绘制。普通聊天问句不识别，approval intent 卡片沿用审批通知。
- 审批通知先等待 `approvalDelayMs`；延迟内收到 `approval/decided` 会取消。
- 已经显示的审批在决定或 Agent 释放后会收到 `withdraw`，浏览器关闭对应通知。
- 在 A 会话启动任务后切到 B，A 的完成/错误仍会通知；返回 A 不依赖历史事件补弹。
- 点击持久通知：Worker 先关闭通知，再聚焦已有 DSH 页面或打开新页面，由 Client 尝试切到对应会话；跳转失败不阻止后续通知。
- 关闭页面保留已弹出的持久通知；接收新通知仍需至少一个 DSH 页面打开。不支持 Service Worker 时回退为页面级通知，详见下方限制。

## 多标签页

支持 Service Worker 的浏览器使用持久通知：关闭 DSH 页面保留已弹出的通知；点击时 Worker 先关闭通知，再聚焦已有 DSH 页面，或打开新页面并切换到对应会话。新页面不会因首次同步立即重弹刚点击的同一条通知。问题已回答、审批已决定时，仍由在线页面根据 Host 状态撤回通知。

Worker 使用独立的 `api/notify-web/` scope，不接管应用页面或拦截请求，不缓存会话内容，也不在后台连接 SSE。所有页面关闭后不会收到新的通知；已弹通知仍可点击。通知自身携带目标会话 ID 和通知 ID，用于点击跳转。安装新版本后需要重启宿主并刷新页面；旧版页面级通知无法迁移到 Worker，需手动关闭。

2.3.1 将通知链接的会话跳转移到通知初始化完成之后，并隔离跳转异常；冷启动时目标会话暂时不能打开，也不阻止后续通知。`window.__NOTIFY_WEB__.navigationError` 单独表示跳转失败，不包含会话内容，不与通知连接错误混用。

支持 Notification 且权限已授予的页面通过 **Web Locks** 竞争一个按通知协议版本与应用 base 路径命名的锁；持锁页负责 SSE 通知，其他页在持锁页离开后接管。带 callId 的提问收讫标记通过 localStorage/BroadcastChannel 传给持锁页；标记只保存 ID，不保存问题正文。无 callId 的阻塞请求由 Host waterfall 交给一个 Client 回答器，该页面独立管理其通知，不猜测它属于哪条工具调用。

- 游标和带过期时间的已处理通知 id 集合存放在同源 `localStorage`，不保存通知正文。
- 没有 Web Locks 或存储不可用时，每个标签页独立消费，靠稳定 tag 和页内去重降低重复，不保证跨标签页只提示一次。
- 浏览器冻结持锁页时仍可能延迟通知；本插件不增加后台抢锁协议。
- 首次升级或清空浏览器存储后，没有“已收到请求”记录的旧提问不会仅凭工具日志补弹；需宿主重新发送请求或发起新提问。已记录收讫的带 callId 请求仍可在重连/接管时恢复。

## 配置

安装器默认只展示 5 个常用通知选项，内部通信参数保留可配置能力，但不写入生成文件。在 `<home>/profiles/<profile>/mbda9091/cordis.patch.yml` 中为新插件生成以下配置：

```yaml
- id: notify-web
  name: '@mbda9091/notify-web'
  config:
    notifyOnQuestion: true
    notifyOnApproval: true
    approvalDelayMs: 300
    notifyOnTurnEnd: true
    notifyOnTurnError: true
```

直接修改上述选项即可调整通知行为；需要调优内部通信时，可按下表将对应字段手动添加到同一 `config` 下。省略的字段由插件补充默认值；显式填写的字段会固定为该值。重新安装会保留已有同 ID 配置，不会自动精简旧文件。

### 通知选项

| 字段 | 默认 | 作用 |
|---|---:|---|
| `notifyOnQuestion` | `true` | 标准用户提问需要回复时通知；旧配置省略时默认开启 |
| `notifyOnApproval` | `true` | 根会话需要工具权限审批时通知；不会替你批准权限 |
| `approvalDelayMs` | `300` 毫秒 | 等待后再弹审批通知；期间审批已决定则取消，避免短暂请求造成打扰 |
| `notifyOnTurnEnd` | `true` | 根会话通过完成检查或达到输出上限时通知；上限提醒不表示任务完成 |
| `notifyOnTurnError` | `true` | 根会话一轮因错误结束时通知 |

### 内部通信参数

以下参数控制服务端向浏览器发送通知事件的长连接（SSE），一般无需调整。它们不执行任务、不自动审批，也不是定时弹通知。

| 字段 | 默认 | 作用 |
|---|---:|---|
| `heartbeatMs` | `15000` 毫秒 | 每 15 秒发送保活信号，不显示系统通知；最小有效值为 1000 毫秒 |
| `replayWindowMs` | `120000` 毫秒 | 短暂断线重连时可补发最近 2 分钟的事件；缓存只在当前宿主进程内存中保存 |
| `maxReplayEntries` | `256` 条 | 补发缓存最多保留的事件数，与时间窗口共同限制缓存大小 |
| `maxQueuedUpdates` | `256` 条 | 每个连接的待发送队列上限；浏览器消费过慢导致积压超限时关闭连接，避免无限占用内存 |

补发不是无限历史恢复：超出缓存范围的事件不保证补发；已决定的审批、已回答的问题不会作为待处理通知重新弹出。关闭页面后也不会后台推送通知。

### 修改并加载配置

例如只关闭错误通知、把审批等待时间改为 500 毫秒，在已有 `notify-web` 行中修改：

```yaml
- id: notify-web
  name: '@mbda9091/notify-web'
  config:
    notifyOnTurnError: false
    approvalDelayMs: 500
```

安装 bundle 已负责插入插件行，这份覆盖配置不需要再写 `insert`。`mbda9091` 子目录不会被自动扫描；要让修改生效，需要在启动时显式加载文件，并重新启动宿主。例如默认 home 下的 macOS Web：

```sh
dsh --profile macos-web --patch "$HOME/.dsh/profiles/macos-web/mbda9091/cordis.patch.yml"
```

已有 provider 等其他 `--patch` 参数时保留它们，再追加通知配置的 `--patch`。多个覆盖层中同一行的 `config` 是整段替换，插件再为最终配置中省略的字段补上内置默认值。未加载这份文件时，插件仍可正常使用内置默认值。

## 权限

浏览器通知需要 `Notification` 权限。插件加载时，如果权限为 `default`（尚未决定），立即调用 `Notification.requestPermission()`，不等待通知事件或用户交互；已授权则直接连接通知流。

自动请求结束后若权限仍为 `default`（包括请求抛错/拒绝），在首次点击或按键时补充请求一次。等待授权期间不会并发重复请求；补充请求后不再因后续交互反复询问。插件卸载后，未完成请求的结果不会重新订阅或注册监听。

权限已经是 `denied` 时不重复申请，需要在浏览器站点设置中手动允许。[浏览器可能要求用户交互](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static#examples)，因此立即调用 API 不保证加载时一定显示授权弹窗；操作系统或浏览器的限制不能由插件绕过。

- 仅支持安全上下文：`http://127.0.0.1`、`http://localhost` 或 HTTPS。
- 通知由操作系统渲染；插件只负责标题、正文、tag 和点击行为。

## 实现

- `src/questions.ts`：Web 专用提问源和 Host-only 会话投影，从已提交事件恢复提问状态，不接管提问回答流程。
- `src/index.ts`：Web Host。建立共享通知源，并通过 DSH Connection 的认证 Fetch 路由 `GET /api/notify-web/events` 提供 SSE。
- `src/client/question-requests.ts`：第一启动阶段观察 Remote 提问请求，原样传递回答与错误。
- `src/client/index.ts`：浏览器入口。按请求收讫放行提问通知，消费 SSE、按当前 locale 格式化、请求权限、显示/撤回通知、处理点击和多标签页。
- `@mbda9091/notify-host`：Host 触发逻辑（根会话过滤、审批延迟、`turn/end`、`agent/disposed` 清理）。
- `@mbda9091/notify-core`：共用的文案与 locale。
- 两个 `@mbda9091/*` 共享库都由 esbuild 在构建期内联，profile 不需要安装。
- `build.json` 声明 Host（ESM）和 Client（IIFE classic script）两个 bundle 入口。Client 只注入 `locale` 与 `uiWorkspace`，不再读取当前 Session 或逐 Session 事件流。

## 构建

```powershell
node scripts/dev.mjs build          # tsc 声明 + esbuild 打 bundle
node scripts/dev.mjs build --check   # 只做类型检查
```

`lib/client.js` 是构建产物，不入库。构建脚本直接调用平台自带的 esbuild 可执行文件，并通过继承 stdio 避免 DSH 沙箱对管道式子进程的限制；esbuild 自身不做类型检查，类型检查仍由 `tsc` 完成。

## 安装

Web GUI 左侧 **Plugins（插件）** 页 → 安装 → 填本目录的绝对路径：

```text
<repo>\notify-web
```

安装后刷新页面，插件会立即尝试申请通知权限；允许浏览器通知即可。若未显示授权提示，可点击页面触发一次补充请求。

日常 Web 由用户自行启动，仓库已移除 `web` / `daily-launcher`；安装与显式加载命名空间配置见[安装指南](../docs/profile-install.md)。开发调试使用 `dev-install` 与 `dev-web`，数据在 `.local/dsh-dev/home`，参数放在 `.local/dsh-dev/cordis.patch.yml`；不复制日常凭据或会话。升级到 2.2.0 后需重启对应宿主并刷新所有 DSH 标签页（或关闭后重开）。旧页面可能接管提问却没有收讫观察器，不能只刷新通知持锁页。新版 Client 显式协商 v3 通知协议，通知锁、游标及收讫记录按协议隔离；Host 对未协商或不支持的客户端返回 426，旧页面需刷新后才能继续通知。新版 Client 遇到未知协议或 426 会停止消费并在诊断中提示刷新。Host 配置修改后同样需重启对应环境，再刷新浏览器。详见 [Web 配置与启动说明](../profiles/web/README.md)。

## 限制

### 已知问题（暂不修复）

2026-11-16 CR，核对基线为 `34bea9eb476694cfdbfd4b68ff4660e32c5ce25c`（插件 2.3.1）。以下三项均为 P2，已用隔离夹具复现；不代表真实系统通知中心的逐项复测，也未读取日常会话数据。用户明确决定先记录、暂不修复；本次仅更新文档，不修改实现，不将问题标为已解决。

1. **投递尚未成功就记录“已通知”，关页可能漏提醒。** [Client 投递逻辑](src/client/index.ts) 在异步 `persistent.show()` 完成前写入 `seen`。如果 Worker 注册或投递仍在等待时关闭页面，新页面会根据该记录跳过同一条待处理通知。隔离复现中，`seen` 已存在，但实际展示次数为 0。后续修复需区分待投递与已投递，协调成功确认、去重记录和游标推进。
2. **其他标签页的同步可能误关仍待回答的无 callId 提问通知。** [持久通知清理](src/client/persistent-notifications.ts) 遍历共享 Worker 注册下的通知，但 Client 传入的 `legacyQuestions` 仅属于当前页面。A 页接收的无 callId 请求不在 B 页的本地集合及 Host pending 中，B 页同步时会将它误判为失效并关闭。隔离复现中，提问尚未回答，通知已关闭。后续修复需区分 Host 管理与接收页面独立管理的通知，避免用局部状态清理其他页面的有效请求。
3. **会话跳转失败仍回报成功，且没有恢复入口。** [Client 点击处理](src/client/index.ts) 捕获 `openSession()` 异常后仍回复 `opened`，[Worker](src/worker.ts) 因而不执行备用导航；冷启动路径还会在跳转前删除 URL 参数，失败后没有重试入口。隔离复现中，未打开会话却收到 `opened` 确认。后续修复需返回真实跳转结果，并保留失败后的恢复机制，同时继续隔离导航与通知初始化。

### 环境与能力边界

- 接收新通知需要至少一个 DSH 标签页保持打开；已发出的持久通知不随页面关闭而清理。
- 不支持 Service Worker 的环境回退为页面级通知，不能保证关页后点击；Worker 注册/投递失败会记录诊断错误，不静默回退到会遗留通知的路径。
- 浏览器权限被拒绝、页面被冻结或 Web Locks/存储不可用时，投递能力和跨标签页去重会退化。
- SSE 恢复窗口默认只有 2 分钟；超出窗口按重置处理，只同步当前待审批和待回答问题，不补齐丢失的完成/错误。
- 真实操作系统提示与点击聚焦仍需在浏览器里人工验收；模拟 `Notification` 不能代替。
