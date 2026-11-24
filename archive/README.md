# 已归档插件

本目录保存停止维护的插件源码和专属测试，不参与 workspace、构建、测试、CATALOG 或安装打包。恢复前须迁回顶层插件目录，并重新适配、验证当前 DSH；不要直接安装归档目录。

| 插件 | 归档日期 | 冻结基线 | 原因 |
|---|---|---|---|
| [desktop-notify](desktop-notify/README.md) | 2026-11-24 | `caf23be4197821c1bf207e0e1e492a508edf26e8`，DSH `0.2.2-rc.1` | 用户确认当前没有使用场景，停止更新 |
| [app-restart](app-restart/README.md) | 2026-11-24 | `41dccc9`，插件 `1.0.1` | 用户确认将 Windows 桌面重启插件一并归档 |

历史已安装的插件由用户通过宿主管理，本次仓库归档不卸载现有 bundle 或删除 profile 数据。归档前本地目录和构建产物暂存于被 Git 忽略的 `.tmp/desktop-notify-before-archive-20261124/`、`.tmp/app-restart-before-archive-20261124/`。
