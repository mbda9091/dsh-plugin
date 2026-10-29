# @local/app-restart

在对话输入框里输入 `/restart`，自动重启 DeepSeek Harness 桌面应用（包含 Host），不用手动关闭再打开。

## 适用场景

- 形态：桌面应用（Electron 壳）；`dsh web`、headless 不适用。
- 平台：Windows 10/11；macOS、Linux 不适用。
- 声明：`package.json` 的 `dsh.targets` 为 `["desktop"]` / `["windows"]`。
- 不匹配时：插件行会变成 `failed`，不会静默无操作。

## 行为

1. `/restart` 命令立即返回「正在重启…」；
2. 插件写两个 VBScript，并用 `wscript.exe` 启动 launcher（**GUI 进程，不创建控制台**）；
3. launcher 通过 WMI 创建一个 **不在 Host 进程树里** 的 helper（关键：Host 被结束时它仍然存活）；
4. helper 等待 600ms，然后用 WMI 结束应用与 Host；
5. 等待 2 秒，用 `WScript.Shell` 启动应用；如果没起来会自动重试；
6. 进度写入 `%TEMP%\dsh-restart.log`，出问题时看这个文件。

全程没有 PowerShell、没有控制台窗口：关闭时不会闪终端，应用也不会继承任何终端，所以关掉别的窗口不会连带结束 DSH。

重启后会话数据仍然存在，但**当前正在进行的回合会被中断**。

## 为什么不是宿主内重启

Electron 的 `app.relaunch()` 只在主进程可用，而插件运行在 Host 进程里，无法直接调用。桌面壳也没有向 Web UI 暴露重启 IPC，所以只能由 helper 从外部关闭并拉起应用。

helper 必须通过 WMI 创建：Electron 壳会把 Host 放进一个 job 对象，宿主直接 spawn 的 helper 会随 Host 一起被杀，导致「关掉了但没重新打开」。WMI 创建的进程不在这个 job 里。

## 安装

```powershell
dsh plugin --profile desktop add (Join-Path $PWD 'app-restart')
```

开发期也可以用 `scripts\dev-install.ps1` 以 link 方式安装（改代码 HMR 生效）。

## 限制

- 仅 Windows（使用 WMI 与 Windows Script Host）。
- 整个应用会重启；做不到只重启 Host、窗口不动。
- 不提供界面按钮，只有 `/restart` 命令。
- 强制关闭时，正在写入的最后一小段会话事件可能丢失（DSH 的会话是持久化的，通常只影响最后一条）。
- 个别安全软件可能拦截 `%TEMP%` 下的 VBScript；如果 `/restart` 无反应，检查 `dsh-restart.log` 是否生成。
