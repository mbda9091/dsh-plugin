# desktop-notify 归档记录

> 范围：停止维护 desktop-notify，将源码及专属测试移出活跃插件集合。
> 完成：是（本机归档检查与提交字节对账通过）。
> 状态：已完成。
> 日期：2026-11-24（Asia/Shanghai）。
> 完成日期：2026-11-24。
> 实现 commit：`4cc5ca723054d2e6a67120b0cdedd3fe1d52f006`；测试在提交前执行，提交后核对文件字节一致。
> 当前结论：归档已实施，活跃插件检查通过，结果与交付集合见第 8 节。

## 1. 结论摘要

按用户明确决定，desktop-notify 停止跟随 DSH 升级。源码及专属测试冻结于升级前 DSH `0.2.2-rc.1` 基线，保存在 [archive/desktop-notify](../archive/desktop-notify/README.md)。活跃插件为 app-restart、notify-web、role-agent。

## 2. 范围

移除 desktop-notify 的 workspace 成员、构建打包、安装发现、CATALOG、专属测试及开发 HMR 路径。保留历史文档与已有验收事实；不卸载日常环境中已有的 bundle，不修改 profile 或会话。

## 3. 现状与问题

此前 desktop-notify 作为顶层 bundle 自动进入构建、打包、类型检查及包契约测试，导致每次宿主升级都需要继续维护。用户确认当前没有使用场景，不再要求兼容新版 DSH。

## 4. 具体方案

将历史源码及 L1/L3 专属测试移入 `archive/desktop-notify/`，注明归档日期、原因、历史基线及恢复条件；pnpm 显式排除 `archive/**`。沿用现有顶层 bundle 发现机制，无需新增禁用开关。更新当前插件清单、测试期望及使用指南。notify-core、notify-host 仍由 notify-web 使用，继续保留并随当前宿主维护。

## 5. 里程碑

归档、活跃引用清理、锁文件更新、本机验证及实现提交对账均已完成，证据见第 8 节。

## 6. 决策记录

2026-11-24 用户明确表示“desktop-notify 能归档吗？不打算更新这个，当前没有使用场景”。归档为停止维护，不将此前未执行的桌面实机验证改为通过。恢复时应从历史提交还原对应共享库与原目录结构，再重新适配和验收。

## 7. 风险与边界

归档目录不是可安装、可独立构建的当前插件包；它保留原始 import 与历史布局约束。旧版共享库可从冻结提交回溯。归档前未提交文件及生成物暂存在 `.tmp/desktop-notify-before-archive-20261124/`，不入库。旧 dist 批次作为历史证据保留，新的交付以 `dist/current.json` 为准。

## 8. 验收状态

2026-11-24，macOS arm64、Node `v24.16.0`、pnpm `11.28.5`，测试基线为 `caf23be4197821c1bf207e0e1e492a508edf26e8` 加本轮改动，随后提交为 `4cc5ca723054d2e6a67120b0cdedd3fe1d52f006`：

- 类型、targets 与生成目录检查通过，仅发现 app-restart、notify-web、role-agent，见[检查日志](../.tmp/desktop-notify-archive/check.log)。
- L1–L3：300 通过、0 失败、1 平台跳过，见[测试日志](../.tmp/desktop-notify-archive/test.log)。
- 快速环境检查 28 项通过，见[环境报告](../.tmp/environment-tests/run-KbfCOF/report.json)；冻结安装通过，见[冻结安装日志](../.tmp/desktop-notify-archive/frozen-install.log)。
- `pnpm list -r --depth -1` 仅列出根包、三个活跃插件和两个共享库；锁文件没有 desktop-notify 或 archive importer。归档代码、清单及专属测试逐字节匹配冻结提交，README 仅补充归档说明与修正链接。
- 安装预览只列出兼容的 notify-web、role-agent，app-restart 按场景跳过，见[预览日志](../.tmp/desktop-notify-archive/install-dry-run.log)。
- 最终完整工作区 `pack` 通过，日志在 `.tmp/desktop-notify-archive/pack.log`；[批次 8d4d64c9-6034-49bf-827d-9d6a134882b1](../dist/batches/8d4d64c9-6034-49bf-827d-9d6a134882b1/manifest.json) 已核对仅包含三个活跃插件，不包含归档包。
- 实现提交前检查了该清单的全部源码文件哈希，均与暂存内容一致；提交后工作区干净，确认提交保存了同一组字节。后续仅更新本页及 rc.5 记录的提交对账，不将本次核对表述为提交后重新跑测试。提交元信息及文档变化会使交付缓存失效，后续安装由脚本按快照规则重新构建打包。

本轮没有修改 Web 运行时行为，未重跑真实 L4/L5 或桌面实机能力。上一轮 rc.5 的 Web 能力证据见[适配记录](dsh-rc5-adaptation-plan.md)，其四插件批次和测试数量保留为归档前历史事实。

## 9. 实施结果与修正

归档采用历史提交快照，撤去此前对 desktop-notify 的 rc.5 类型依赖升级；notify-web 需要的通知接口迁移继续保留。通用目标守卫测试改用仍活跃的 app-restart，插件发现测试增加嵌套归档包，验证它不会进入活跃集合。

## 10. 当前未完成事项与下一步

本轮无未完成实施事项；不新增 desktop-notify 的适配或桌面验收待办。恢复该插件须另行明确决定、还原历史布局并重新适配验收。
