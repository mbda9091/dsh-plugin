# app-restart 归档记录

> 范围：停止维护 Windows 桌面重启插件 app-restart，将源码与专属测试移出活跃集合。
> 完成：否（本机检查通过，实现未提交，待提交对账）。
> 状态：待验收（待提交对账）。
> 更新日期：2026-11-24（Asia/Shanghai）。
> 实现 commit：未提交；基线 `41dccc994b59fd728c53415e33f1a5528de84a2e` 加本轮改动。
> 当前结论：归档已实施，仅保留 notify-web、role-agent 为活跃插件，本机检查通过；验证与交付集合见第 8 节。

## 1. 结论摘要

按用户“这个也归档”的明确决定，app-restart 停止更新。源码及专属 L1/L3 测试保存在 [archive/app-restart](../archive/app-restart/README.md)，版本冻结为 `1.0.1`。

## 2. 范围

移除 workspace、构建打包、安装发现、CATALOG、专属测试、HMR 路径及当前安装指引中的 app-restart。保留历史验收记录；不卸载日常 DSH 中已有 bundle，不修改 profile 或会话。

## 3. 现状与问题

app-restart 只适用于 Windows 桌面，依赖 WMI 与 Windows Script Host。原顶层目录会被自动构建、测试和打包，继续占用维护入口；用户决定在 desktop-notify 之后将其一并归档。

## 4. 具体方案

沿用已有 `archive/<插件 id>/` 约定与 `!archive/**` workspace 排除规则，不新增归档机制。源码及专属测试冻结于上述提交，原顶层目录及生成物备份到 `.tmp/app-restart-before-archive-20261124/`。通用目标守卫与环境检测改用仍活跃的 role-agent，HMR 模板仅去掉原 app-restart 路径。当前说明与生成目录同步为两个活跃插件。

## 5. 里程碑

源码与专属测试归档、活跃引用清理、目录更新及本机检查均已完成；证据见第 8 节，实现提交待对账。

## 6. 决策记录

2026-11-24 用户确认 app-restart 为 Windows 桌面专用后，明确要求归档。停止后续适配，不改变旧轮次的完成结论，不将桌面实机未验证项改记为通过。

## 7. 风险与边界

归档包保留历史 import 和目录约束，不是当前可独立构建或安装的插件。恢复时须另行明确决定，迁回原布局并重新适配验收。旧 dist 批次保留为历史证据，新的交付集合以 `dist/current.json` 指向清单为准。

## 8. 验收状态

2026-11-24，macOS arm64、Node `v24.16.0`、pnpm `11.28.5`，基于上述提交加本轮未提交改动：

- 类型、targets 与生成目录检查通过，仅发现 notify-web、role-agent，见[检查日志](../.tmp/app-restart-archive/check.log)。
- L1–L3：268 通过、0 失败、1 平台跳过，见[测试日志](../.tmp/app-restart-archive/test.log)。
- 快速环境检查 28 项通过，见[环境报告](../.tmp/environment-tests/run-tB8x1K/report.json)；冻结安装通过，见[冻结安装日志](../.tmp/app-restart-archive/frozen-install.log)。
- workspace 仅列出根包、两个活跃插件和两个共享库，见[成员清单](../.tmp/app-restart-archive/workspace.json)；锁文件仅移除了 app-restart importer，未改动其他依赖版本。
- 归档源码、清单与两份专属测试逐字节匹配冻结提交，README 仅补充归档说明，见[快照核对](../.tmp/app-restart-archive/snapshot.json)。
- 安装预览只包含 notify-web、role-agent，见[预览日志](../.tmp/app-restart-archive/install-dry-run.log)。
- 最终完整工作区执行 `pack`，日志在 `.tmp/app-restart-archive/pack.log`；交付清单以 [dist/current.json](../dist/current.json) 指向批次为准，核验标准为仅包含两个活跃插件，不包含任一归档包。

本轮没有修改 Web 运行时行为，未重跑真实 L4/L5 或 Windows 桌面实机能力；此前验证保留为各自轮次的历史证据，不代替本轮交付集合检查。

## 9. 实施结果与修正

专属测试移入归档而非继续随当前宿主运行；通用场景守卫保留 Windows-only envelope 的纯函数测试，使用活跃插件导出的通用判断函数，不将该测试 envelope 当成 role-agent 的实际平台声明。安装入口不增加桌面兼容分支。

## 10. 当前未完成事项与下一步

实现尚未提交，后续提交时补齐 SHA 和已测差异对账；不新增 app-restart 的适配或桌面验收待办。恢复该插件须另行明确决定、还原原布局并重新适配验收。
