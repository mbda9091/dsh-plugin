# @local/notify-web

在 **Web 界面（`dsh web`）** 中，当根会话的工具申请权限或一轮对话结束时，通过浏览器调用操作系统的系统通知；点击通知会聚焦 DSH 标签页并切换到对应会话。

## 适用场景

- 形态：Web（`dsh web` 的浏览器界面）；桌面应用、headless 不适用。
- 平台：Windows、macOS 宿主（浏览器通知本身跨平台；平台声明用于宿主侧的目标校验）。
- 声明：`package.json` 的 `dsh.targets` 为 `["web"]` / `["mac","windows"]`。
- 桌面应用使用 `desktop-notify`，不要同时安装本插件；客户端检测到桌面启动标记时会主动跳过，避免重复。

## 行为

Host 全局监听已提交的 `session/event`，按真实 Agent registry 只处理根会话；与当前打开哪个会话无关。

| 触发时机 | 通知 |
|---|---|
| 根会话工具申请权限 | 「需要确认权限」+ 工具名/理由 |
| 根会话 `turn/end` 为 `completed` / `max-tokens` | 「对话已完成」 |
| 根会话 `turn/end` 为 `error` | 「对话出错」+ 错误信息 |
| `aborted`、`blocked`、`interrupted`、`forked` 及其他结束原因 | 不通知 |
| subagent 的审批或回合结束 | 不通知 |

- 审批通知先等待 `approvalDelayMs`；延迟内收到 `approval/decided` 会取消。
- 已经显示的审批在决定或 Agent 释放后会收到 `withdraw`，浏览器关闭对应通知。
- 在 A 会话启动任务后切到 B，A 的完成/错误仍会通知；返回 A 不依赖历史事件补弹。
- 点击通知：`window.focus()` 聚焦标签页，并通过 `ctx.uiWorkspace.openSession(sessionId)` 切到对应会话。
- 通知只在页面打开期间存在；没有 Service Worker，关闭标签页后不会再通知。

## 多标签页

支持 Notification 且权限已授予的页面通过 **Web Locks** 竞争一个按应用 base 路径命名的锁；只有持锁页建立 SSE 并显示通知，其他页在持锁页离开后接管。

- 游标和带过期时间的已处理通知 id 集合存放在同源 `localStorage`，不保存通知正文。
- 没有 Web Locks 或存储不可用时，每个标签页独立消费，靠稳定 tag 和页内去重降低重复，不保证跨标签页只提示一次。
- 浏览器冻结持锁页时仍可能延迟通知；本插件不增加后台抢锁协议。

## 配置

Host 从 `notify-web` loader 行读取以下字段，默认值如下：

| 字段 | 默认 | 作用 |
|---|---:|---|
| `notifyOnApproval` | `true` | 审批通知开关 |
| `approvalDelayMs` | `300` | 审批延迟；期间决定则取消 |
| `notifyOnTurnEnd` | `true` | 完成 / max-tokens 通知开关 |
| `notifyOnTurnError` | `true` | 错误通知开关 |
| `heartbeatMs` | `15000` | SSE 心跳间隔 |
| `replayWindowMs` | `120000` | 断线补发时间窗口 |
| `maxReplayEntries` | `256` | 补发缓存条数上限 |
| `maxQueuedUpdates` | `256` | 单连接输出队列上限 |

示例：

```yaml
- insert:
    - id: notify-web
      name: '@local/notify-web'
      config:
        notifyOnTurnError: false
        approvalDelayMs: 500
```

## 权限

浏览器通知需要 `Notification` 权限。插件加载时，如果权限为 `default`（尚未决定），立即调用 `Notification.requestPermission()`，不等待通知事件或用户交互；已授权则直接连接通知流。

自动请求结束后若权限仍为 `default`（包括请求抛错/拒绝），在首次点击或按键时补充请求一次。等待授权期间不会并发重复请求；补充请求后不再因后续交互反复询问。插件卸载后，未完成请求的结果不会重新订阅或注册监听。

权限已经是 `denied` 时不重复申请，需要在浏览器站点设置中手动允许。[浏览器可能要求用户交互](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static#examples)，因此立即调用 API 不保证加载时一定显示授权弹窗；操作系统或浏览器的限制不能由插件绕过。

- 仅支持安全上下文：`http://127.0.0.1`、`http://localhost` 或 HTTPS。
- 通知由操作系统渲染；插件只负责标题、正文、tag 和点击行为。

## 实现

- `src/index.ts`：Web Host。建立共享通知源，并通过 DSH Connection 的认证 Fetch 路由 `GET /api/notify-web/events` 提供 SSE。
- `src/client/index.ts`：浏览器入口。消费 SSE、按当前 locale 格式化、请求权限、显示/撤回通知、处理点击和多标签页。
- `@local/notify-host`：与 `desktop-notify` 共用的触发逻辑（根会话过滤、审批延迟、`turn/end`、`agent/disposed` 清理）。
- `@local/notify-core`：共用的文案与 locale。
- 两个 `@local/*` 共享库都由 esbuild 在构建期内联，profile 不需要安装。
- `build.json` 声明 Host（ESM）和 Client（IIFE classic script）两个 bundle 入口。Client 只注入 `locale` 与 `uiWorkspace`，不再读取当前 Session 或逐 Session 事件流。

## 构建

```powershell
pwsh -File scripts\build.ps1          # tsc 声明 + esbuild 打 bundle
pwsh -File scripts\build.ps1 -Check   # 只做类型检查
```

`lib/client.js` 是构建产物，不入库。构建脚本直接调用平台自带的 esbuild 可执行文件，并通过继承 stdio 避免 DSH 沙箱对管道式子进程的限制；esbuild 自身不做类型检查，类型检查仍由 `tsc` 完成。

## 安装

Web GUI 左侧 **Plugins（插件）** 页 → 安装 → 填本目录的绝对路径：

```text
<repo>\notify-web
```

安装后刷新页面，插件会立即尝试申请通知权限；允许浏览器通知即可。若未显示授权提示，可点击页面触发一次补充请求。

在本仓库的日常 Web 环境中，安装记录由插件管理器维护，通知参数统一放在 `profiles/web/cordis.patch.yml`，使用 `profiles/web/start.ps1`（或 `dshweb`）启动。修改该配置后需要重启 Web 服务，再刷新浏览器；不要将同一套日常参数另写进用户目录的 profile patch。详见 [Web 配置与启动说明](../profiles/web/README.md#notify-web-的安装与日常配置)。

## 限制

- 标签页必须保持打开；页面级 `Notification` 无法在标签页关闭后继续工作。
- 浏览器权限被拒绝、页面被冻结或 Web Locks/存储不可用时，投递能力和跨标签页去重会退化。
- SSE 恢复窗口默认只有 2 分钟；超出窗口按重置处理，只同步当前待审批，不补齐丢失的完成/错误。
- `notify-web` 与 `desktop-notify` 是独立插件，需要分别安装到对应 profile。
- 真实操作系统提示与点击聚焦仍需在浏览器里人工验收；模拟 `Notification` 不能代替。
