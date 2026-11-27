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

独立后续变更：`b554760` 简化通知生成配置，记录在 [notify-web README](../plugins/notify-web/README.md)；`7011a6b` 升级 DSH/Cordis，完整变更与验收记录见 [测试方案 §19.10](testing-plan.md#1910-dsh-022-rc1-整体适配2026-11-06)。`be2043e` 是多项变更的合并落点，不能仅凭该 SHA 推断其中每轮操作都在这个提交上验收。

## 功能支线

- [持续成长的角色扮演 Agent](companion/README.md)：按[调研依据](companion/role-agent-research.md)、[总体设计](companion/role-agent-design.md)、[初步落地](companion/role-agent-initial-plan.md)分工维护。M1 与 [M1.5 DSH 适配](companion/role-agent-dsh-adaptation.md)设计已完成，[M2 选型与成本](companion/role-agent-memory-evaluation.md)已按三方记忆／角色成长分工修订，M3 已有[角色插件](../plugins/role-agent/README.md)及[真实工程／短轨迹验收](companion/role-agent-m3-acceptance.md)，长期成长收益和部分费用未闭合；[M4 方案](companion/role-agent-m4-plan.md)已交付，反馈修补已实施，其余建设与持续试用未开始。 新增 [M5 标准工具对齐](companion/role-agent-m5-plan.md)，排除子 Agent，其余有效标准能力保留；已实现并完成隔离工具／长材料验证，交付记录见 M5 附件。

| 文档 | 使命 | 结果与核验边界 |
|---|---|---|
| [Web 通知](archive/notification-host-design.md) | 共享通知触发、认证 SSE 与浏览器投递 | 当前 Web 功能已完成，2026-11-07 用户确认人工验证并归档；历史证据边界保留，Desktop 不纳入当前交付 |
| [外部目录审批](archive/external-directory-authorization-plan.md) | 精确调用审批建设、历史实施与废弃决定 | 已废弃：复杂且不好用；`be2043e` 已删除，原建设正文已从 Git 对象恢复，保留原阶段结果 |
| [沙箱目录扩展](archive/sandbox-directory-extension-plan.md) | macOS Web 追加可写目录 | 已废弃、未实施：用户确认 DSH 0.2.2 已支持配置化扩展，不再建设插件 |
| [OpenAI API Key 接入](archive/openai-api-plan.md) | 用平台 API Key 接入内置 `openai` 路由；profile 根 patch 与 Web 设置页同步 | 已完成，2026-11-18 用户确认；仓库无代码变更，配置在本机 profile |

本次扫描只核对文档、Git 和相关源码入口；不产生新的功能验收通过结论。尚未核实的历史基线、原始报告以及当前外部归档专项覆盖各自记录，不能互相替代，也不因此重开已完成轮次。已将三份明确废弃的方案及当轮已完成的日常独立运行方案移入 archive，原路径保留跳转；Web 通知、OpenAI API Key 接入也已按用户确认的完成结果归档；其他文档仍在原位置。

## 当前独立调整

- [插件与测试目录整理](repository-layout-plan.md)：活跃插件统一 plugins，共享库放 plugins/common，停更插件放 archive-plugins；测试区分 common 与各插件，再保留 L1–L5 层级。插件/测试目录迁移的完整 CI 已通过；追加共享库移动的冻结安装、类型、L1–L3、fast、L5 和打包对比通过；已提交 `6341f2c`，原工作区安全登记已正常刷新。

- [环境测试宿主复用与推送清理](environment-test-storage-plan.md)：M1–M3 的 v0.5 已提交并验收；v0.6 已改为原生 pre-push，普通 git push 推送前自动尝试清理，失败/dry-run 也可能触发，已提交 `ba03889`，本地验证通过、当前仓库已启用。保留共同锁、7 天和 keep，报告/产物/共享宿主不删。
- [Codex 订阅登录插件](codex-subscription-login-plan.md)：0.1.0 已实现，代码 `35c4086` 与文档对账 `8e48445` 已推送至 `origin/main`；首版仅覆盖 Linux Web，复用原生 `openai-codex` 授权，不修改 DSH 内部实现；2026-11-27 自动化通过，用户确认预览登录正常，已仅安装本插件至日常 `mbda9091-lab`，未迁移开发授权或重启日常 DSH；真实推理／刷新及其余边界待验收，极端竞争暂缓。
- [notify-web 用户提问提醒](notify-web-question-plan.md)：补齐标准 `ask_user_question` 的提醒、回答撤回及重连恢复；2026-11-16 已实现并安装日常 2.1.1，修正 PTC start 遗漏；自动验收及固定包 L4/L5 通过，待真实 OS 人工验收与提交对账。
- [内部开发测试与外部交付分离](development-delivery-separation-plan.md)：已提交两个脚本入口、按用途解析输入，安装必填 profile，保留缓存及必要时构建打包，并合并 Linux Web 支持。本轮按用户确认的 macOS 范围已完成，验收基线 `4049f6f`，完整 CI 通过；Windows/Linux 与真实 DSH 沙箱暂缓。尚未归档，实现提交和证据见原文。
