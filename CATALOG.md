# 插件目录

> 本文件由 `node scripts/dev.mjs catalog` 根据各插件 `package.json` 的 `dsh.targets` 生成，不要手动编辑。
> 适用场景语义见 [docs/plugin-targets.md](docs/plugin-targets.md)。

| 插件 | 包名 | 形态 | 平台 | 说明 |
| --- | --- | --- | --- | --- |
| 重启应用 | `@mbda9091/app-restart` | 桌面 | Windows | 新增 /restart 命令，自动重启 DeepSeek Harness 桌面应用。 |
| 成长角色 | `@mbda9091/role-agent` | 通用 | 通用平台 | 专属角色模式、可溯源语义记忆与有界成长修订 |
| 浏览器通知 | `@mbda9091/notify-web` | Web | 通用平台 | 用户提问、权限申请和回合结束时发送浏览器系统通知，点击可定位标签页并切换到对应会话。 |

## 组合规则

- 桌面应用（目标平台）：安装形态为“桌面”或“通用”、且平台覆盖目标平台的插件。
- Web（目标平台）：安装形态为“Web”或“通用”、且平台覆盖目标平台的插件。
- 平台列为“通用平台”的插件同时覆盖 macOS、Windows 与 Linux。
