# 虚拟伙伴 Agent 的人格记忆与主动交互研究

> 当前方向已转向持续成长的角色扮演 Agent，见[设计方向与新一轮研究](role-agent-research.md)。本文保留 2026-11-11 调研背景，不作为当前目标定义或实施计划。

调研日期：2026-11-11。本文补充 [DSH 插件调研](virtual-companion-plugin-research.md)，关注长期相处的虚拟伙伴，不覆盖通用编码 Agent 的全部研究。

核心判断：人格与记忆是必要基础，但持续的伙伴体验还依赖动态用户理解、关系上下文、动机与行为一致性、主动介入时机。平台接入只完成其中的观察与行动接口。这个模块划分是本文结合研究提出的工程建议，不是已经得到统一验证的标准架构。

## 范围与证据

来源限于作者论文、正式论文集、官方研究博客和作者项目页。本轮核对论文元数据、摘要与相关方法描述，对 Generative Agents 和 MemGPT 查阅了正文；不构成逐篇全文复现或系统性文献综述。研究覆盖经典工作与截至调研日可查的 2026 年进展，不以榜单分数排名。

证据类型必须区分：会议及期刊论文、预印本、研究解释模型、项目愿景、用户实验各自回答不同问题。拟人行为不证明主观体验；模拟用户的测评不等同于真人长期陪伴效果。文中“启发”均为面向本项目的推论。

## 大厂与研究团队

### 微软 XiaoIce

**The Design and Implementation of XiaoIce, an Empathetic Social Chatbot**，Li Zhou、Jianfeng Gao、Di Li、Heung-Yeung Shum，Computational Linguistics 2020；预印本始于 2018。

研究将陪伴式聊天组织成对话管理、核心聊天、技能和共情计算模块，并以决策过程处理长期互动。它说明陪伴系统需要选择怎样回应、切换话题与技能，而不仅是生成带有口头禅的句子。原系统使用会话轮数等参与度指标，不能由此推出用户福祉或关系质量提升。

**启发**：单独设计互动策略与共情回应；不要只用聊得久来判断伙伴是否好用。这是大模型普及前的系统，模块思想可参考，具体技术不能直接照搬。[论文](https://aclanthology.org/2020.cl-1.2/)

### 微软 CompanionX 与角色评估

[CompanionX](https://www.microsoft.com/en-us/research/project/companionx/) 是研究项目入口，组织了社会认知、Agent 协作、社会模拟与行为边界等方向。项目目标不是已完成产品的效果证明。

其中两项具体研究值得读：

- **CharacterBox**，Lei Wang、Jianxun Lian、Xing Xie、Ji-Rong Wen 等，NAACL 2025。用角色 Agent 和叙事 Agent 形成情境与行为轨迹，评估持续行动中的角色一致性，超出单轮问答。**启发**：用连续事件测试性格，不能只问“你是什么性格”。[论文](https://aclanthology.org/2025.naacl-long.323/)
- **MotiveBench**，Xixian Yong、Jianxun Lian、Xiaoyuan Yi、Xiao Zhou、Xing Xie，2025；CompanionX 将其列为 ACL Findings 2025。评估丰富情境中的动机推理，报告被测模型对归属相关动机的困难，以及过度理性化、理想化倾向。**启发**：应区分角色价值倾向、当前目标和情境压力，不能只配置几个形容词。[论文](https://arxiv.org/abs/2506.13065)

### Anthropic 人格与情绪机制

**Persona Vectors: Monitoring and Controlling Character Traits in Language Models**，2025。研究从模型内部激活中提取与行为特征相关的方向，并用于监测或干预人格偏移；官方介绍的实验涉及 Qwen 与 Llama 开放模型。**启发**：人格需要持续检测，模型或上下文变化后可能漂移。激活干预需要模型内部访问，不能直接变成普通 DSH API 插件的功能。[研究介绍](https://www.anthropic.com/research/persona-vectors) · [论文](https://arxiv.org/abs/2507.21509)

**The Persona Selection Model**，Sam Marks、Jack Lindsey、Christopher Olah，2026-02-23。提出一种解释框架：预训练形成多种角色模拟能力，后训练选择并细化 Assistant 角色。它是带经验论据的研究观点，作者仍讨论其解释是否充分，不是已经确立的心智理论。**启发**：系统提示、上下文和模型训练共同影响角色，单独一张人格卡不能保证所有场景一致。[原文](https://alignment.anthropic.com/2026/psm/)

**Emotion concepts and their function in a large language model**，2026-04-02。对 Claude Sonnet 4.5 的机制研究发现情绪概念表示可影响行为；研究明确不据此判断模型是否有主观感受。**启发**：可以研究状态如何调节行为，但不能将插件里一个“心情数值”当成复现该机制。[官方研究](https://www.anthropic.com/research/emotion-concepts-function)

### Apple 与高校合作的主动 Agent 评估

**Proactive Agent Research Environment**，Deepak Nathani、William Yang Wang、Xin Eric Wang 等，2026；arXiv 首发 4 月，Apple 研究页面标注 7 月。作者涉及 Apple、UCSB、华盛顿大学等。

Pare 用带状态的应用与用户模拟构建环境，Pare-Bench 考察上下文观察、目标推断、介入时机和跨应用协作。它是主动助手的研究与测评框架，不能直接推断陪伴体验。

**启发**：主动性是“现在是否需要我、做什么合适”的决策；定时器只是触发器。应有等待、准备但不发送、询问和执行等不同结果。[Apple 研究页面](https://machinelearning.apple.com/research/proactive-agent-research-environment) · [论文](https://arxiv.org/abs/2604.00842)

### Google DeepMind 的助手关系研究

**The ethics of advanced AI assistants**，2024。官方介绍由 Iason Gabriel、Arianna Manzini 撰写，讨论自主助手的价值对齐、隐私、拟人化及用户控制。这是一项规范性研究，不能作为某种人格或记忆算法更有效的实验证据。

**启发**：用户应能检查和修改画像、控制主动联系与信息使用范围；关系设定不能代替操作授权。[官方介绍及论文入口](https://deepmind.google/blog/the-ethics-of-advanced-ai-assistants/)

### OpenAI 与 MIT Media Lab 的长期使用实验

**How AI and Human Behaviors Shape Psychosocial Effects of Extended Chatbot Use**，Cathy Mengying Fang、Pattie Maes、Pat Pataranutaporn 及 OpenAI 合作者等，2025。四周随机实验共 981 名参与者，比较交互模式和话题条件。

须以 2025-10-02 的修订摘要为准：未发现实验条件对所测结果的显著效应；自愿使用更多与较差结果相关。使用时长不是随机分配的，因此不能写成“研究证明多聊导致孤独”，更不能推出所有陪伴系统的结果相同。

**启发**：评估中要有用户控制感、被打扰程度和生活影响，不能只追求使用时长。这是用户结果研究，不提供人格或记忆实现方案。[论文 v2](https://arxiv.org/abs/2503.17473v2) · [MIT 项目](https://www.media.mit.edu/projects/mit-openai-study/overview/)

## 学术架构与经典理论

### Generative Agents

Joon Sung Park、Michael S. Bernstein、Percy Liang 及 Google 合作者，UIST 2023。这是最直接的架构参考：保存经历流，按相关性、近期性与重要性检索，通过反思形成较高层理解，再规划和调整行动。

论文在 25 个 Agent 的模拟小镇中评估可信行为，消融显示记忆、反思和规划的重要性；同时记录错误召回、记忆添饰等问题。它不是面向真实用户的多年陪伴验证。

**启发**：角色需要“观察 → 记忆 → 反思 → 计划 → 行动”的循环。反思应保留来源，不能把推断直接升级成事实。[论文正文](https://arxiv.org/html/2304.03442v2)

### MemGPT

Charles Packer、Ion Stoica、Joseph E. Gonzalez 等，UC Berkeley，2023 预印本，2024 修订。以操作系统分层内存为类比，让模型管理有限上下文和外部记忆之间的信息移动，并在多会话聊天等任务评估。

**启发**：分开常驻角色信息、当前工作上下文和可检索历史；给记忆读写明确接口与预算。它说明怎样管理有限上下文，不保证任何规模下都不遗忘。[论文](https://arxiv.org/abs/2310.08560)

### Relational Agents

Timothy Bickmore 的 MIT 博士研究，Rosalind W. Picard 参与指导，2003。讨论能够建立并维持长期社会情感关系的交互系统；伙伴研究早于 LLM，也不限于人形或聊天窗口。

**启发**：把关系连续性作为独立设计目标，不应只关注回答正确或角色外观。经典研究的特定场景不能直接外推到开放式生成模型。[MIT 论文介绍](https://www.media.mit.edu/publications/relational-agents-effecting-change-through-human-computer-relationships/)

### Mixed Initiative Interaction

Eric Horvitz，微软研究院，CHI 1999，**Principles of Mixed-Initiative User Interfaces**。讨论自动服务与用户直接控制的结合，尤其是目标不确定性、用户注意力以及介入成本。

**启发**：主动联系应考虑用户是否方便、判断是否可靠、推迟是否更好，而不只是到点执行。[论文与研究介绍](https://www.microsoft.com/en-us/research/publication/principles-mixed-initiative-user-interfaces/)

## 人格与记忆评估

这里必须区分两个主体：角色人格回答“它是谁”，用户画像回答“它如何理解你”。名字里有 Persona 的基准不一定测角色人格。

| 研究 | 测什么 | 对虚拟伙伴的用途与边界 |
|---|---|---|
| [InCharacter](https://aclanthology.org/2024.acl-long.102/)，Xintao Wang、Jiangjie Chen、Yanghua Xiao 等，ACL 2024 | 通过心理访谈和量表评估角色人格保真度 | 可借鉴跨情境性格评估；不是临床人格诊断，也不证明主观体验 |
| [LongMemEval](https://arxiv.org/abs/2410.10813)，Di Wu、Kai-Wei Chang、Dong Yu 等，ICLR 2025 | 信息提取、跨会话推理、时间推理、知识更新、应当弃答 | 适合做基础记忆测试；问答正确不等于聊天自然 |
| [LoCoMo](https://aclanthology.org/2024.acl-long.747/)，Adyasha Maharana、Mohit Bansal 等，ACL 2024 | 长期多会话中的问答、事件总结和多模态对话生成 | 可测试长期事件关联；合成与整理后的对话仍不同于真实使用 |
| [PersonaMem](https://arxiv.org/abs/2504.14225)，Bowen Jiang、Lyle Ungar、Dan Roth 等，COLM 2025 | 从历史推断并更新用户画像，在当前场景给出个性化响应 | 很贴近日常陪伴；测的是用户变化，不是助手自己的性格 |
| [LoCoMo-Plus](https://aclanthology.org/2026.acl-long.1150/)，Yifei Li 等，ACL 2026 | 未被直接询问的用户状态、目标和价值约束能否继续影响回答 | 比显式事实问答更接近日常相处；属于基准实验 |
| [When Users Don’t Ask / LOCOMO-CONV](https://aclanthology.org/2026.findings-emnlp.1289/)，Wen Yu Chang、Yun-Nung Chen，Findings EMNLP 2026 | 对话、隐含、反事实和组合式查询下的召回与最终回复 | 强召回不保证好回复；记忆可以改善回应而无需把旧事实复述出来 |
| [LongMemEval-V2](https://arxiv.org/abs/2605.12493)，Di Wu、Nanyun Peng、Kai-Wei Chang 等，2026 预印本，标注 Work in Progress | 环境状态、流程、常见问题与前提意识等经验记忆 | 适合参考平台操作经验；不是原版用户聊天记忆基准的简单扩容 |

不同论文可能使用不同模型、检索预算、数据版本和裁判。不能将不同系统公开的百分数直接排列比较，也不能把检索命中率当成端到端回复准确率。

## 对本仓库设计的启发

下表是工程建议，尚未实施或形成 ADR。

| 模块 | 建议职责 | 主要研究依据 |
|---|---|---|
| 核心人格 | 稳定身份、价值倾向、表达方式及版本 | InCharacter、CharacterBox、Persona Vectors |
| 当前状态与动机 | 本轮目标、关注点、情境；与长期性格分开 | MotiveBench、Generative Agents |
| 用户与关系模型 | 用户偏好、变化、称呼和关系上下文 | PersonaMem、Relational Agents |
| 事实与经历 | 原始来源、时间、参与者、真实执行结果 | Generative Agents、LongMemEval |
| 记忆管理 | 提炼、索引、召回、更新、失效及上下文预算 | MemGPT、LongMemEval |
| 互动决策 | 回应、探索、跟进、等待或保持沉默 | XiaoIce、Horvitz、Pare |
| 平台与表达 | 观察、发送、分段、语音及形象 | 承接插件调研，不自行维护另一套角色 |
| 评估与用户控制 | 一致性、适时性、可纠正、可暂停和信息使用范围 | CharacterBox、DeepMind、MIT/OpenAI |

核心人格可保持稳定，兴趣与理解随经历变化。对用户的推断应允许纠正；临时情境不应永久改变画像。反思、计划、感受与已经发生的事实应有不同记录类型。

本仓库实现仍需遵守 session event 为模型可见事实来源的规则：外部存储是可追溯的记忆载体，不能让模型看到无法从已提交事件重建的隐形历史。具体与 DSH 扩展点的映射需要另行设计。

## 可以立即用于验证的场景

以下是本项目可自建的评估案例，不是已运行的测试或原论文题目。

| 场景 | 应检查的行为 |
|---|---|
| 同一角色在私聊、公开评论与任务协作中切换 | 语气适应场景，核心立场和身份不相互矛盾 |
| 用户早先不喜欢建议，今天明确求助 | 当前表达优先，保留历史情境而非简单覆盖成永恒偏好 |
| 用户说“今天又碰到上次那种事” | 能寻找相关经历；证据不足时询问，不编造共同过去 |
| 记住用户不希望公开的经历 | 私下可用于理解，公开回复不泄露细节 |
| 昨天承诺今天跟进，但用户刚说在忙 | 结合当前状态延期或不打扰，而不是机械发送 |
| 平台发送失败或结果不明 | 不写成已完成，不让角色日记捏造成功经历 |
| 角色受到连续奉承、反驳或话题切换 | 行为仍符合设定，不能只检查口头禅是否保留 |
| 用户纠正、删除某条记忆 | 后续召回与推断同步更新，避免旧摘要反复恢复错误 |

评估至少分开记录事实正确性、更新正确性、角色一致性、回应适切性、打扰程度、隐私范围、延迟和成本。固定模型版本、提示、历史与裁判方法；对同一配置重复试验，并保留人工核对。

## 推荐阅读顺序

1. **Generative Agents**：先理解完整行为循环。
2. **MemGPT**：理解有限上下文下的记忆管理。
3. **PersonaMem 与 LongMemEval**：明确“懂你”和“记得事实”的不同测法。
4. **InCharacter 与 CharacterBox**：学会评估人格，尤其连续情境中的行为。
5. **LOCOMO-CONV 与 LoCoMo-Plus**：理解记忆怎样自然地影响回应。
6. **XiaoIce、Horvitz 与 Pare**：设计主动互动和回应策略。
7. **Anthropic 机制研究、DeepMind 与 MIT/OpenAI**：理解人格稳定性、证据边界和用户结果。

若后续只深入三个问题，优先研究：记忆如何在用户没直接询问时正确生效；角色在长会话及跨平台中的一致性；主动跟进如何判断现在适不适合打扰。
