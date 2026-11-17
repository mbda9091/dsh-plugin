# 虚拟伙伴记忆后端替代选型与续接记录

> 2026-11-15 当前实施依据：[M2 能力与成本评估](role-agent-memory-evaluation.md)。当前由三方记忆组件承载必需语义检索，DSH／插件承载角色成长，Hindsight API 优先接入验证但尚未最终选定；纯词面及自建检索首选均已撤回；下文旧排序及“当前入口”均为历史文本。

> 2026-11-13 最新状态：技术选型已重新开放，先审阅[总体设计](role-agent-design.md)与[初步落地](role-agent-initial-plan.md)，再按能力契约评估候选及成本。下文的 Hindsight 选择、ReMe 排序与第 7 节执行指引均为历史记录，不再是当前实施入口；许可证约束及调研背景保留。

> 更新日期：2026-11-12（Asia/Shanghai）；候选调研发生于 2026-11-11。
> 状态：用户已选择 Hindsight；尚未安装、实测或提交实现代码。
> 用户明确约束：不接受 OpenViking 本体的 AGPL-3.0 许可证。
> 当前入口：[Hindsight 接入与伙伴方案](hindsight-companion-plan.md)。下列候选比较保留调研历史；原“优先 ReMe”建议不再执行。
> 关联：[原 OpenViking 方案](../archive/openviking-companion-plan.md)、[社区插件调研](virtual-companion-plugin-research.md)、[研究综述](virtual-companion-agent-research.md)。

## 1. 已确定的需求与未确定的选择

用户希望建设 DSH 虚拟伙伴，倾向轻量、可编辑的 Markdown 人格与记忆，避免捆绑平台操作和复杂陪伴套件。讨论中接受评估独立记忆后端，不再把整个系统纯 JS 作为硬性条件；Markdown 可读性仍是重要偏好。

保留的职责划分：

- `SOUL.md` 定义人格、表达、边界与行为示例；不必另建人格或自然表达引擎。
- 记忆后端承载用户画像、共同经历、关系事实和阶段状态。状态需要来源、时间范围及更新规则，不能把即时情绪当永久特征。
- 自研 DSH 伙伴插件补充纠错控制与主动性，首版建议仅做明确约定的回访。
- 优先复用后端的官方 DSH 插件，不从头重写捕获、召回和后台队列；只补经验证确实缺少的能力。

原方案中的单用户、单伙伴、Linux Web、人格会话内冻结、回访默认关闭等属于首版提案，不能全部视为用户已经逐项确认。用户已明确否决 OpenViking 的许可证；2026-11-12 选择 Hindsight，具体接入设计见新方案。

## 2. 许可证与候选比较

以下排序为 2026-11-11 的历史评估，当前选择以 Hindsight 新方案为准。

许可证依据为本次读取的主仓库 LICENSE，不表示所有子包、模型权重、传递依赖或托管服务采用同一许可。最终固定版本后逐项核对实际交付内容。本表不作具体商业使用方式的法律结论。

| 候选 | 主仓库许可证 | 数据与运行形态 | DSH 接入 | 选型判断 |
|---|---|---|---|---|
| [ReMe](https://github.com/agentscope-ai/ReMe) | [Apache-2.0](https://github.com/agentscope-ai/ReMe/blob/main/LICENSE) | Python 服务；普通 Markdown 保存长期记忆；关键词索引及可选向量 | 官方 `@agentscope-ai/reme-dsh-plugin` | 优先验证，最贴近用户希望记忆可读可改的方向 |
| [Hindsight](https://github.com/vectorize-io/hindsight) | [MIT](https://github.com/vectorize-io/hindsight/blob/main/LICENSE) | 完整记忆服务，数据库存储，retain/recall/reflect | 官方 `@vectorize-io/hindsight-coding-agents` | 第二候选；现成集成偏编码，须调整默认采集与空间规则 |
| [Mem0](https://github.com/mem0ai/mem0) | [Apache-2.0](https://github.com/mem0ai/mem0/blob/main/LICENSE) | 有开源 Node/TypeScript 实现；向量存储与 SQLite 历史，不是纯 MD | 本次未确认官方 DSH 插件 | 若重视 Node 集成且接受自建接入，进一步评估 |

本次不按 Star 排名，不以主仓库关注度替代 DSH 插件的使用量、兼容性和伙伴场景效果。

## 3. ReMe：优先候选

项目把对话与资料整理为可读、可编辑的 Markdown，使用 frontmatter、wikilinks，提供 BM25、可选 embedding 和链接扩展。日常资料进入 `daily`，整理后的长期知识进入 `digest`；派生索引可重建。服务端需要 Python 3.11+，不是纯 JS。[主仓库说明](https://github.com/agentscope-ai/ReMe)

当前官方 DSH 包为 `@agentscope-ai/reme-dsh-plugin`，源码位于 `integrations/dsh`。旧搜索结果中的 `typescript/`、`@agentscope-ai/reme/dsh` 是旧布局，不作为新安装依据。此次读取清单版本为 `0.1.3`，尚未核对 npm 发布产物。[包清单](https://github.com/agentscope-ai/ReMe/blob/main/integrations/dsh/package.json)

官方接入提供记忆使用指引、只读 `reme_search`、回合完成后的自动记忆提取、定期 Auto Dream 整理、状态页面和持久后台队列。检索由 Agent 决定何时调用，并非每轮强制注入检索结果；这会影响伙伴能否自然想起过往，需要实测。自动整理是记忆维护，不等于主动给用户发消息。[DSH 接入文档](https://reme.agentscope.io/en/integrations/dsh)

优先检查的缺口：

1. 当前仓库 DSH `0.2.2-rc.1`、Cordis `4.1.0` 能否正常加载。官方文档列出 `0.2.2-alpha.2` 等已支持版本，未明确列出本仓库版本；包范围不能代替真实验收。
2. 模型是否会在涉及用户偏好、共同经历和约定时主动调用 `reme_search`；不足再补触发策略。
3. 后台整理如何处理用户更正、删除和旧队列重放，避免被遗忘内容再次生成。
4. 伙伴空间能否隔离编码资料；只部署需要的功能，不因有环境管理 UI 就自动安装依赖。
5. 服务连接、浏览器访问与认证边界。官方文档说明默认服务没有 API-key 认证；远程部署需另行设计访问控制。

## 4. Hindsight：完整记忆服务候选

Hindsight 提供 `retain`（保存）、`recall`（召回）、`reflect`（基于记忆推理），使用 memory bank 隔离数据，提供服务端、客户端和部署选项。它不是普通 Markdown 目录型后端。[核心说明](https://github.com/vectorize-io/hindsight)

官方 coding-agents 集成已经支持 DSH，可按 profile 安装 npm 包。其默认行为围绕项目记忆：按仓库解析 bank，导入 Git 历史和对话，并维护项目知识页；因此不能把“支持 DSH”直接等同于“适合虚拟伙伴”。[集成源码与说明](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents)

评估时需固定伙伴 bank，检查如何关闭不需要的仓库导入、历史采集和自动升级，替换编码向引导。官方说明有 profile 包安装路径，优先采用该路径，避免通用安装器写入所有 profile 共用的 home patch。尚未验证调整后是否足够轻量，以及与 DSH `0.2.2-rc.1` 的兼容性。

## 5. Mem0：Node/TypeScript 路线候选

`mem0-ts` 包含开源实现，并非只有托管 API 客户端。其开源能力包括记忆增删改查、向量存储提供方、模型配置及 SQLite 历史管理。托管版本能力不能直接当作 OSS 能力。[TypeScript 说明](https://github.com/mem0ai/mem0/tree/main/mem0-ts)

优势是可从 Node 侧集成记忆功能；代价是本次未确认官方 DSH 适配，可能需要自建会话捕获、召回、任务恢复和工具包装。也不能把“npm 安装”理解为无模型、无存储或全部纯 JS。先核对所选存储依赖，再判断是否比服务型后端更轻。

## 6. 原 OpenViking 调研的保留结论

排除原路线的原因是用户不接受 AGPL-3.0，不是缺少 DSH 插件。其官方插件源码已包含启动资料注入、自动召回、session event 捕获、提交、待处理队列、恢复以及 MCP/技能挂载；没有必要重写整套接入。[入口](https://github.com/volcengine/OpenViking/blob/main/examples/dsh-memory-plugin/index.mjs)、[运行时](https://github.com/volcengine/OpenViking/blob/main/examples/dsh-memory-plugin/runtime.mjs)

源码还暴露 `openvikingMemory` 服务，但不能把全部内部方法当成稳定扩展契约。严格遗忘、动态过滤和时效失效仍需额外验证。上述只是历史技术调研，当前不再推进其安装或实施。

## 7. 下次继续的具体入口

2026-11-12 用户明确要求 Hindsight 接入方案。当前执行入口为 [Hindsight 方案 §10](hindsight-companion-plan.md#10-当前未完成事项与下一步)，从 M1 固定版本与官方插件兼容验证开始。不要重新询问后端选择，不再优先试 ReMe，不恢复已废弃的 OpenViking 路线。

保留 Soul、关系连续性、状态时效、纠错与约定回访的需求；新方案独立记录官方插件配置、必要适配、验收标准和交付阶段。选择后端不等于已经验收，也不表示已授权安装到日常环境。

## 8. 当前交付状态

- 已完成：许可证与官方资料核对、候选比较、需求与续接记录。
- 未执行：服务部署、插件安装、源码完整审计、真实模型测试、性能/成本测试和宿主兼容验收。
- 代码变更：无。此次只修改文档，不提交或推送，不改日常 DSH 环境。
