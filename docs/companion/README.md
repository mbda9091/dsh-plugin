# 持续成长的角色扮演 Agent

更新：2026-11-16。目标是一个有连续性、自身立场并能因共同经历成长的角色；产品形态暂定 DSH 对话。M3 已补齐真实 Hindsight／DeepSeek／DSH 的检索、短轨迹、纠正、隔离与恢复实验，详见 [M3 验收](role-agent-m3-acceptance.md)。工程链路可作为评估基线；长期关系／成长收益和完整费用尚未证明。[M4 方案](role-agent-m4-plan.md)已交付，反馈修补已实施，其余建设与持续试用尚未开始。记忆仍采用 DeepSeek 抽取＋本地数据库／embedding／重排，角色成长由 DSH／插件负责。 [M5](role-agent-m5-plan.md)：角色模式对齐标准工具、排除子 Agent；已实现并完成隔离工具／长材料验证。

## 三份主文档

| 文档 | 回答什么 | 应在这里修改什么 |
|---|---|---|
| [调研依据](role-agent-research.md) | 有什么研究、证据能支持到哪里？ | 论文记录、证据边界、支持与反例 |
| [总体设计](role-agent-design.md) | 最终体验是什么，系统有哪些稳定职责？ | 目标、产品形态、三层架构、领域能力和不变量 |
| [初步落地方案](role-agent-initial-plan.md) | 第一轮做什么、怎样做、付出什么成本、如何验证？ | P1–P4、模型调用、复盘与检索策略、选型差距、阶段及验收结果 |

阅读关系：**调研提供依据 → 总体设计定义目标与边界 → 初步落地选择本轮实现 → 验证结果反馈假设。** 术语统一维护在 [CONTEXT.md](../../CONTEXT.md)。审阅当前实现提案可先读初步落地，遇到目标与边界问题再回到总体设计。

当前进度：M1／M1.5 设计和 M2 后端比较已交付，Hindsight 的固定配置已获得真实接入证据；M3 的[角色插件](../../plugins/role-agent/README.md)、[验收入口](../../test/src/plugins/role-agent/acceptance/README.md)与[阶段结果](role-agent-m3-acceptance.md)可互相核对。40项检索、六类注入、独立复盘审计、实践／反馈门槛和重启／备份恢复均有记录；产品效果逐项区分通过、局部观察和未知，未将短场景当成长体验成立。M4 已进入方案审阅，反馈修补已实施，其余建设与持续试用尚未开始；[M4 附件](role-agent-m4-plan.md)明确增量工作、实际入口、观察与对照，依赖和回流见落地方案 §5.2。

## 修改范围与对齐规则

- 调整检索预算、复盘触发、模块拆合、调用次数或后端选型：修改初步落地，记录受影响的验收项。正常情况下不改总体设计。
- 改变目标、产品形态、角色与经历含义或稳定能力边界：修改总体设计，并核对初步落地是否仍满足 G1–G5；术语变化同步 CONTEXT。
- 新论文或上游能力变化：修改调研或技术比较的证据记录。只有证据改变现有决定时，才修改相应设计。
- 用户认可目标和方案方向，不等同于具体机制已经通过验证；实验、真实运行与人工体验结论分别记录。
- 三份文档使用相对链接关联；不互相复制整段方案，不靠同步版本号维持一致。总体目标使用 G 编号，初步落地使用 P 职责和 A 验收编号建立映射。
- 当前首轮迭代持续更新初步落地；形成独立后续轮次时按[方案模板](../plan-template.md)另建。归档遵守[仓库约定](../archive/README.md)。

## 阶段设计附件

[角色 Agent 的 DSH 适配设计（M1.5）](role-agent-dsh-adaptation.md)属于初步落地方案：改宿主接法、上下文与持久化时序在此维护；后端技术选择仍交给 M2，不改变三份主文档的职责。

[M2 记忆能力与成本评估](role-agent-memory-evaluation.md)同属初步落地附件：维护后端比较、首轮选择、成本和可推翻该选择的实验；固定来源及探针在 [m2-evidence](m2-evidence/source-manifest.json)。

[M3 真实验收](role-agent-m3-acceptance.md)集中维护运行基线、结果、费用缺口与 A/C 对账；脱敏数据在 [m3-evidence](m3-evidence/acceptance-summary.json)。实验细节不复制进总体设计。

[M4 持续交流方案](role-agent-m4-plan.md)维护反馈修补、试用基线、检查／导出、观察流程与评价标准；区分建设完成和长期试用结论。已先行实施[反馈修复](role-agent-feedback-fix.md)，其余建设及持续试用未开始。

[M5 标准工具对齐](role-agent-m5-plan.md)维护标准有效工具的保留／排除矩阵、role-lan 装配、长输出经历及后台任务回执适配；不支持子 Agent 及依赖它的多 Agent workflow，保留其他已启用标准能力。M4 与 M5 分工及试用基线回流见落地方案 §5.2。

## 补充资料与历史记录

| 文档 | 使用边界 |
|---|---|
| [早期 Agent 研究综述](virtual-companion-agent-research.md) | 2026-11-11 调研背景，不定义当前方案 |
| [社区插件调研](virtual-companion-plugin-research.md) | 2026-11-10 实现参考，不以插件能力限定目标 |
| [历史记忆后端比较](companion-memory-alternatives.md) | 保留许可证与选型背景，旧排序和实施指引已失效；新比较按初步落地要求进行 |
| [旧 Hindsight 接入草案](hindsight-companion-plan.md) | 旧目标下的未实施草案，不作为当前实施入口；可查接入细节 |
| [v0.1–v0.3 混编草案快照](../archive/role-agent-design-v0.3.md) | 保留十四模块和早期取舍；已停止作为当前方案维护，未实现或验收 |
| [OpenViking 伙伴方案](../archive/openviking-companion-plan.md) | 已废弃；许可证原因及原始边界见正文，不恢复实施 |

此前 Hindsight 选择及 ReMe 更省实现的未验证推荐保留为历史，不作为实施依据。当前首轮路线以 M2 为准；对后续候选仍按功能契合、补齐工作、质量和总成本重评。

原 [role-agent-direction.md](role-agent-direction.md) 仅保留跳转，旧章节锚点不再维护。

[返回仓库文档导航](../README.md)
