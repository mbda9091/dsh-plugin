# @mbda9091/notify-web

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

安装器默认只展示 4 个常用通知选项，内部通信参数保留可配置能力，但不写入生成文件。在 `<home>/profiles/<profile>/mbda9091/cordis.patch.yml` 中为新插件生成以下配置：

```yaml
- id: notify-web
  name: '@mbda9091/notify-web'
  config:
    notifyOnApproval: true
    approvalDelayMs: 300
    notifyOnTurnEnd: true
    notifyOnTurnError: true
```

直接修改上述选项即可调整通知行为；需要调优内部通信时，可按下表将对应字段手动添加到同一 `config` 下。省略的字段由插件补充默认值；显式填写的字段会固定为该值。重新安装会保留已有同 ID 配置，不会自动精简旧文件。

### 通知选项

| 字段 | 默认 | 作用 |
|---|---:|---|
| `notifyOnApproval` | `true` | 根会话需要工具权限审批时通知；不会替你批准权限 |
| `approvalDelayMs` | `300` 毫秒 | 等待后再弹审批通知；期间审批已决定则取消，避免短暂请求造成打扰 |
| `notifyOnTurnEnd` | `true` | 根会话一轮正常完成或达到输出上限时通知 |
| `notifyOnTurnError` | `true` | 根会话一轮因错误结束时通知 |

### 内部通信参数

以下参数控制服务端向浏览器发送通知事件的长连接（SSE），一般无需调整。它们不执行任务、不自动审批，也不是定时弹通知。

| 字段 | 默认 | 作用 |
|---|---:|---|
| `heartbeatMs` | `15000` 毫秒 | 每 15 秒发送保活信号，不显示系统通知；最小有效值为 1000 毫秒 |
| `replayWindowMs` | `120000` 毫秒 | 短暂断线重连时可补发最近 2 分钟的事件；缓存只在当前宿主进程内存中保存 |
| `maxReplayEntries` | `256` 条 | 补发缓存最多保留的事件数，与时间窗口共同限制缓存大小 |
| `maxQueuedUpdates` | `256` 条 | 每个连接的待发送队列上限；浏览器消费过慢导致积压超限时关闭连接，避免无限占用内存 |

补发不是无限历史恢复：超出缓存范围的事件不保证补发；已决定的审批不会作为待审批通知重新弹出。关闭页面后也不会后台推送通知。

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

- `src/index.ts`：Web Host。建立共享通知源，并通过 DSH Connection 的认证 Fetch 路由 `GET /api/notify-web/events` 提供 SSE。
- `src/client/index.ts`：浏览器入口。消费 SSE、按当前 locale 格式化、请求权限、显示/撤回通知、处理点击和多标签页。
- `@mbda9091/notify-host`：与 `desktop-notify` 共用的触发逻辑（根会话过滤、审批延迟、`turn/end`、`agent/disposed` 清理）。
- `@mbda9091/notify-core`：共用的文案与 locale。
- 两个 `@mbda9091/*` 共享库都由 esbuild 在构建期内联，profile 不需要安装。
- `build.json` 声明 Host（ESM）和 Client（IIFE classic script）两个 bundle 入口。Client 只注入 `locale` 与 `uiWorkspace`，不再读取当前 Session 或逐 Session 事件流。

## 构建

```powershell
node scripts/bootstrap.mjs build          # tsc 声明 + esbuild 打 bundle
node scripts/bootstrap.mjs build --check   # 只做类型检查
```

`lib/client.js` 是构建产物，不入库。构建脚本直接调用平台自带的 esbuild 可执行文件，并通过继承 stdio 避免 DSH 沙箱对管道式子进程的限制；esbuild 自身不做类型检查，类型检查仍由 `tsc` 完成。

## 安装

Web GUI 左侧 **Plugins（插件）** 页 → 安装 → 填本目录的绝对路径：

```text
<repo>\notify-web
```

安装后刷新页面，插件会立即尝试申请通知权限；允许浏览器通知即可。若未显示授权提示，可点击页面触发一次补充请求。

日常 Web 使用 `node scripts/bootstrap.mjs web`（或 `dshweb`）启动配置中绑定的 `daily` 目标，默认端口 3080；通知参数由该目标已有的 profile/home 配置层管理，旧 `profiles/web/cordis.local.patch.yml` 不会自动加载。开发调试使用 `dev-install` 与 `dev-web`，数据在 `.local/dsh-dev/home`，参数放在 `.local/dsh-dev/cordis.patch.yml`；不复制日常凭据或会话。Host 配置修改后需重启对应环境，再刷新浏览器。详见 [Web 配置与启动说明](../profiles/web/README.md)。

## 限制

- 标签页必须保持打开；页面级 `Notification` 无法在标签页关闭后继续工作。
- 浏览器权限被拒绝、页面被冻结或 Web Locks/存储不可用时，投递能力和跨标签页去重会退化。
- SSE 恢复窗口默认只有 2 分钟；超出窗口按重置处理，只同步当前待审批，不补齐丢失的完成/错误。
- `notify-web` 与 `desktop-notify` 是独立插件，需要分别安装到对应 profile。
- 真实操作系统提示与点击聚焦仍需在浏览器里人工验收；模拟 `Notification` 不能代替。
