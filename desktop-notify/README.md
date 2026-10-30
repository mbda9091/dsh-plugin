# @local/desktop-notify

在 **桌面应用** 中，当工具申请权限或一轮对话结束时，弹出 Windows 通知并播放提示音。

## 适用场景

- 形态：桌面应用（Electron 壳）；`dsh web`、headless 不适用。
- 平台：Windows 10/11；macOS、Linux 不适用。
- 声明：`package.json` 的 `dsh.targets` 为 `["desktop"]` / `["windows"]`。
- 不匹配时：插件行会变成 `failed`，不会静默无操作。
- Web 场景使用独立的 `notify-web` 插件。

## 行为

| 触发时机 | 通知标题 | 正文 |
|---|---|---|
| 工具申请权限（`approval/asked`） | 需要确认权限 | 工具名 + 申请理由 |
| 一轮正常结束（`turn/end`，`completed` / `max-tokens`） | 对话已完成 | 本轮回复已结束 |
| 一轮因错误结束（`turn/end`，`error`） | 对话出错 | 错误信息 |
| 用户主动停止（`aborted`） | 不通知 | — |

审批通知会延迟 `approvalDelayMs`（默认 300ms）：如果 `approval/decided` 在此之前到达（例如 `approval-allowlist` 自动放行），通知会被取消，不会为一次从未展示的审批打扰你。手动审批仍会在等待期间正常提醒。

通知以 DeepSeek Harness 的身份显示（复用桌面应用的 AppUserModelID + 开始菜单快捷方式）。Toast 不可用时自动退化为托盘气泡提示；提示音独立播放，不依赖 Toast 自身的声音。

子代理（subagent）的回合不会触发通知，只有根会话会；根身份从真实 Agent registry 读取，无法确认时不通知。

触发判断与 `notify-web` 共用 `@local/notify-host`，标题/正文格式化共用 `@local/notify-core`；桌面仍使用固定中文文案。

## 点击通知

点击通知正文会把 DSH 窗口激活到前台（最小化时恢复），不会打开新窗口。

实现方式：toast 使用协议激活 `dsh-notify:focus`；插件启动时在 `HKCU\Software\Classes\dsh-notify` 注册一个 wscript 处理器，脚本位于 `%LOCALAPPDATA%\dsh-notify\focus.vbs`，通过 WMI 找到 DSH 进程并调用 `AppActivate`。点击记录写入 `%TEMP%\dsh-notify-focus.log`。

目前**没有**「通过 / 拒绝」按钮；审批仍需回到界面操作。

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id `desktop-notify` 覆盖，或在安装后由插件管理器写入：

```yaml
- id: desktop-notify
  config:
    notifyOnApproval: true    # 权限申请时通知
    approvalDelayMs: 300      # 等待自动审批决定的毫秒数；自动放行会取消通知
    notifyOnTurnEnd: true     # 回合正常结束时通知
    notifyOnTurnError: true   # 回合因错误结束时通知
    sound: true               # 播放提示音
    appId: com.deepseek.dsh   # 通知归属的应用 ID（桌面版默认值）
    soundFile: 'C:\Windows\Media\Windows Notify Calendar.wav'
    powershell: powershell.exe
```

`config` 是整行替换而非深合并：覆盖时把需要的键写全，缺省的键使用 `src/index.ts` 里 `DEFAULTS` 的值。字段类型见同文件的 `Config` interface；运行时不做校验，写错类型会按 JS 语义生效（例如字符串 `"false"` 是 truthy）。

## 构建

Host 入口是 TypeScript，`lib/` 是构建产物、不入库；`build.json` 声明 Host bundle，构建脚本用 `tsc` 生成声明、用 esbuild 内联 `@local/notify-host` 与 `@local/notify-core` 并产出 `lib/index.js`：

```powershell
node scripts/bootstrap.mjs build          # 构建
node scripts/bootstrap.mjs build --check   # 只做类型检查
```

插件**没有运行时依赖**；`@local/notify-host` 与 `@local/notify-core` 是 workspace 内的构建期依赖，不会进入 profile。

## 安装

Web UI 左侧 **Plugins（插件）** 页 → 安装 → 填本目录的绝对路径：

```text
<repo>\desktop-notify
```

也可以用 `dsh plugin --profile desktop add (Join-Path $PWD 'desktop-notify')`（需要先完全退出桌面应用）。

## 开发与稳定版

```powershell
node scripts/bootstrap.mjs dev-install     # link 安装，改代码 HMR 生效
node scripts/bootstrap.mjs pack            # 构建 + pnpm pack → dist/*.tgz
node scripts/bootstrap.mjs stable-install  # 覆盖 link，安装 tarball（需重启）
node scripts/bootstrap.mjs status          # 查看当前是 link 还是 tarball
```

两个安装脚本支持 `--dry-run` 预览。link 模式不会安装插件的 `dependencies`，tarball 会——所以稳定版要单独验证一次依赖路径。

## 限制

- 仅 Windows：依赖 Windows PowerShell 5.1 的 WinRT 通知绑定。
- 系统关闭通知或开启「专注助手」时，Toast 可能不显示；提示音仍会尝试播放。
- 通知内容使用固定的中文文案；Web 侧（`notify-web`）走 Client locale（中/英）。
- 点击通知不会跳转到对应会话（没有注册通知激活器）。
- 不处理 Web 表面；Web 由独立的 `notify-web` 提供。
