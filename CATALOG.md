# 插件目录

> 本文件由 `node scripts/bootstrap.mjs catalog` 根据各插件 `package.json` 的 `dsh.targets` 生成，不要手动编辑。
> 适用场景语义见 [docs/plugin-targets.md](docs/plugin-targets.md)。

| 插件 | 包名 | 形态 | 平台 | 说明 |
| --- | --- | --- | --- | --- |
| 重启应用 | `@local/app-restart` | 桌面 | Windows | 新增 /restart 命令，自动重启 DeepSeek Harness 桌面应用。 |
| 桌面通知 | `@local/desktop-notify` | 桌面 | Windows | 权限申请或回合结束时弹出 Windows 通知并播放提示音。 |
| 审批白名单 | `@local/approval-allowlist` | 通用 | 通用平台 | 按精确工具调用参数为指定命令加白审批，默认只观察不自动放行。 |
| 浏览器通知 | `@local/notify-web` | Web | 通用平台 | 权限申请和回合结束时发送浏览器系统通知，点击可定位标签页并切换到对应会话。 |

## 组合规则

- 桌面应用（目标平台）：安装形态为“桌面”或“通用”、且平台覆盖目标平台的插件。
- Web（目标平台）：安装形态为“Web”或“通用”、且平台覆盖目标平台的插件。
- 平台列为“通用平台”的插件同时覆盖 macOS 与 Windows。
