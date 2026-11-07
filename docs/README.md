# 文档导航与迭代顺序

本次扫描日期为 2026-11-07，对照提交 `981f1ba58d722c43dabc28298f096afe305e506c`。每份方案独立记录其使命与当轮结果；导航只说明版本顺序，不充当验收证据，也不设置接替关系。日期或文件排列不能代替 Git 祖先关系。已完成工作后来被调整或删除，不撤销原完成。

## 当前使用与约定

- [环境输入](configuration-v2.md)、[指定 profile 安装](profile-install.md)、[开发与测试 Web](../profiles/web/README.md)：操作指南，按当前实现维护。
- [插件概念](dsh-concepts.md)、[适用场景](plugin-targets.md)：机制与约定；文中注明的旧宿主版本是原调研基线，未因此宣称新版本全部重新核验。
- [方案模板](plan-template.md)、[归档索引](archive/README.md)：按轮次填写与归档，保留真实 commit 和证据边界。
- 各插件与共享包 README：用途、配置、安装及限制；生成的 [CATALOG](../CATALOG.md) 不手工修改。

## 建设与维护主线

| 文档 | 本文使命与主分支落点 | 当轮结果/边界 |
|---|---|---|
| [本机配置](archive/local-configuration-design.md) | 配置统一 `99b07bb`，TS/PS 迁移 `ab745e9` | 已废弃（2026-11-07）；前两阶段及 P0 历史完成，剩余维护设计不再实施 |
| [测试与 L5](testing-plan.md) | 基础测试建设及各轮测试扩展；P0 `ab745e9`，宿主升级 `7011a6b` | 历史完成与后续验收分节记录；按需 UI、桌面等不合并计算 |
| [开发环境隔离](development-environment-plan.md) | `ff461e0` → `8478d76` → `686c78d` → `f481036` → `ee55cfc`；收尾 `ec585d2` | M1–M6 已实现，各轮平台结果分别保留 |
| [日常独立运行](archive/daily-environment-isolation-plan.md) | S1–S3 `d62a0d1`；S4 文档收尾 `fd286ce` | 已归档；Windows Web 历史已完成，原始报告本次未回读 |
| [脚本职责与安装](script-scope-and-profile-install-plan.md) | `be2043e` 删除启动职责、实现显式安装及配置 | 已实现；正文各轮证据不冒充最终 head 全量通过 |

独立后续变更：`b554760` 简化通知生成配置，记录在 [notify-web README](../notify-web/README.md)；`7011a6b` 升级 DSH/Cordis，完整变更与验收记录见 [测试方案 §19.10](testing-plan.md#1910-dsh-022-rc1-整体适配2026-11-06)。`be2043e` 是多项变更的合并落点，不能仅凭该 SHA 推断其中每轮操作都在这个提交上验收。

## 功能支线

| 文档 | 使命 | 结果与核验边界 |
|---|---|---|
| [Web 通知](archive/notification-host-design.md) | 共享通知触发、认证 SSE 与浏览器投递 | 当前 Web 功能已完成，2026-11-07 用户确认人工验证并归档；历史证据边界保留，Desktop 不纳入当前交付 |
| [外部目录审批](archive/external-directory-authorization-plan.md) | 精确调用审批建设、历史实施与废弃决定 | 已废弃：复杂且不好用；`be2043e` 已删除，原建设正文已从 Git 对象恢复，保留原阶段结果 |
| [沙箱目录扩展](archive/sandbox-directory-extension-plan.md) | macOS Web 追加可写目录 | 已废弃、未实施：用户确认 DSH 0.2.2 已支持配置化扩展，不再建设插件 |

本次扫描只核对文档、Git 和相关源码入口；不产生新的功能验收通过结论。尚未核实的历史基线、原始报告以及当前外部归档专项覆盖各自记录，不能互相替代，也不因此重开已完成轮次。已将三份明确废弃的方案及当轮已完成的日常独立运行方案移入 archive，原路径保留跳转；Web 通知也已按用户确认的完成结果归档；其他文档仍在原位置。

## 当前独立调整

- [内部开发测试与外部交付分离](development-delivery-separation-plan.md)：已提交两个脚本入口、按用途解析输入，安装必填 profile，保留缓存及必要时构建打包，并合并 Linux Web 支持。本轮按用户确认的 macOS 范围已完成，验收基线 `4049f6f`，完整 CI 通过；Windows/Linux 与真实 DSH 沙箱暂缓。尚未归档，实现提交和证据见原文。
