# M2：记忆能力核对、接入成本与首轮技术选择

更新／核对：2026-11-15。状态：**职责分工与后端比较已交付，Hindsight 固定部署已获得真实语义／来源／恢复证据，作为首轮工程基线；角色长期收益和部分费用仍未知**。[M3 验收](role-agent-m3-acceptance.md)记录实测与限制，历史源码筛查不作为运行结果。

上游：[初步落地方案](role-agent-initial-plan.md)、[M1.5 DSH 适配设计](role-agent-dsh-adaptation.md)。本附件维护本轮选型、成本模型和试验门槛，不改变[总体目标](role-agent-design.md)。现成 DSH 插件只是接入参考，不决定候选范围。

## 1. 本轮决定（按已确认的职责分工修订）

**采用“DSH／角色插件承载角色与成长，三方记忆组件承载记忆存储与检索”。中文语义检索是首轮硬要求。优先验证 Hindsight 独立 API，ReMe 向量模式与 Mem0 OSS 保留为同条件候选；不把自建 embedding＋向量索引作为首选。**优先验证不等于最终胜出，不能把已读接口当作已接入或已验收。

| 所有者 | 明确职责 | 不越过的边界 |
|---|---|---|
| DSH | 专属角色 mode、正常会话、工具循环、合法日志、上下文快照、权限及模型调用 | 不把提供基础持久化说成已经具备语义记忆 |
| 角色插件 | 角色绑定、采集准入、来源与现实／虚构标签、P3 成长提案、P4 校验与修订、失效屏障和恢复账本 | 不默认自建 embedding、向量索引、相似度排序、融合与索引维护 |
| 三方记忆组件 | 记忆持久化、文本分块／索引、embedding、语义／关键词召回、数据更新删除与操作状态 | 返回材料与来源；不直接修改角色核心、关系档案、方法状态或执行权限 |

优先核对 Hindsight 的依据为 §3 已读的来源文档、异步 operation_id、操作状态和 recall 接口，这些有机会减少自建索引与可靠写入的补齐量；同时它增加应用、数据库、抽取、embedding／重排配置和运行成本，中文效果及审计仍未验证。ReMe 必须启用真实向量检索，Mem0 必须明确 embedding／向量存储配置；“已有 DSH 插件”不替代这些条件。

我们实现一个薄 P2 适配器，把平台无关 put/search/read/invalidate/inspect 语义映射到选定组件。角色插件保存源 ID、远端 ID 映射、任务回执和屏障；原始事实仍是 DSH Session 日志，三方派生事实不自动成为已确认角色认识。P3/P4 保持唯一角色成长提交者。

原纯关键词首选和后来“自建 embedding＋内存混合检索”首选均已撤回。自建路线仅保留为成本／功能对照或明确缺口下的备选，需要重新论证，不能因接入遇到问题就默认转入自研。

**选型闭合条件**：按 §5.3 固定可复现组件与模型配置，通过接口、来源、更正、恢复、模式隔离和中文语义最小接入试验，并记录实际补齐量及全部内部模型调用。此前“M2 已完成全部选型”的表述过满；当前完成的是证据核对和接入方案，验证结论仍未建立。

## 2. 评价方法与候选范围

先检查硬约束，再按角色／记忆职责比较接入与维护总成本；优先复用三方能力，不把少一个进程直接等同于省实现，不用 Star、宣传分数或“有插件”加权：

1. 专用角色模式外无私有提示／采集／成长任务；不改变其他 mode 或默认值。
2. 原始事实能回到 DSH 已提交来源；真实／虚构、原文／摘要、有效／失效分开。
3. 重试不重复成长；更正先有本地屏障，旧任务不得恢复失效结论。
4. 人格、关系、方法的提案与提交可分离，不强迫后端自主改写角色核心。
5. 模型路由、内部调用、审计、失败与恢复能核对；无法确认的能力标未知。
6. 首轮必须提供中文语义召回，不能要求用户记住原词；纯关键词、手工同义词或让对话模型反复猜关键词不能替代它。

| 类别／候选 | 为什么纳入 | 本轮处理 |
|---|---|---|
| 自建 embedding／内存混合检索 | 作为检索功能和自研工作量的对照 | 不作为首选；若重新考虑须与三方补齐成本同条件比较 |
| Node 内置 SQLite／FTS5 | 可能用零 npm 依赖改善本地查询，且可事务化 | 已做隔离能力探针；首轮不引入，原因见 §5 |
| Hindsight 独立 API | 文档／事实／语义召回、异步操作接口有明确依据 | 真实接入、检索及恢复已测，首轮工程基线；长期效果与部分费用未闭合 |
| ReMe 文件／搜索 API | 可读文件、关键词与可选向量、整理与请求回执 | 深核对；可作为检索服务，但不直接启用整套自动记忆插件 |
| Mem0 TypeScript OSS | 同为 Node，可使用现成向量存储抽象 | 深核对；不把托管 SDK 当作 OSS 实现，不把 infer:false 当作无 embedding |
| MemOS Local | 已有 DSH 入口、反馈／策略／技能与分层检索，覆盖面较广 | 深核对；版本和算法接管成本阻止直接采用 |
| Graphiti | 时间有效性、图谱与混合召回适合变化中的认识 | 接入面筛查；需要自建服务／数据库，首轮不引入图谱 |
| LangMem | 独立材料上的结构化记忆提取，能借鉴 P3 | 原语层核对；无必要为此额外引入 Python/LangGraph 路由 |
| Letta Code／MemFS | 经历与核心记忆分层、持续身份接近目标 | 沿用 M1.5 固定设计参考；不迁入另一套 Agent harness |
| OpenViking | 已有历史方案 | 用户已否决其许可证，不重新作为推荐候选；不是本次新作的法律判断 |

云托管记忆不是另一个独立算法候选：需在上述能力之外比较数据出口、访问控制、费用和服务限制。当前没有现成托管账号／配额作为前提，不把付费托管的易用性与自托管成本混在一列。

## 3. 固定来源及实际核对结果

本次下载 40 个固定提交文件并针对接口、配置、依赖和许可证进行阅读核对；[来源清单及 SHA-256](m2-evidence/source-manifest.json)可复核下载字节。清单不表示完整代码审计、发布产物验收或服务已部署。M1.5 的本地 DSH `0.2.2-rc.1` 契约继续作为宿主基线。

### 3.1 Hindsight

固定提交 `5318be8ea572aa00ceae636c71c1d8d334f805b6`；源码中的 API 包声明版本为 `1.2.1`，未据此认定同名镜像或 npm 包与该提交字节一致。

- 已核对 [RetainRequest 源码](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/hindsight-api-slim/hindsight_api/api/http.py)：`operation_id` 是异步 retain 的可选客户端 UUID，重发同 ID 返回原操作，不创建新工作；同步 retain 忽略它。调用方仍须固定 payload、保留内容 hash，不能重用 ID 表示另一批。
- [retain 接口](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/hindsight-docs/docs/developer/api/retain.mdx)支持 document_id 与 replace/append；普通 retain 包含事实抽取。replace 会重处理；append 不能被本项目当作任意重放天然幂等。首轮若接服务，使用确定文档 ID＋异步操作 ID，不按每轮累积重发整段会话。
- [recall](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/hindsight-docs/docs/developer/api/recall.mdx)可返回事实、原文 chunks、来源事实与截断标记；[documents](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/hindsight-docs/docs/developer/api/documents.mdx)可展开及删除文档。DSH 原始日志仍是共同经历真源，不能用提取事实代替完整回应。
- [bank 配置](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/hindsight-docs/docs/developer/api/memory-banks.mdx)允许关闭自动 consolidation；本项目不默认开启 reflect／observations 形成另一条角色更新链。bank export/import 还存在不重新 LLM 抽取的迁移路径，但不是把任意原始对话零成本写成合格事实的通用入口。
- [operations](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/hindsight-docs/docs/developer/api/operations.mdx)提供状态、取消与失败重试。成功入队不等于可召回；失效、取消和崩溃期间的可见性仍待实测。
- [部署例](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/docker/docker-compose/external-pg/docker-compose.yaml)是应用＋PostgreSQL/pgvector；打包为一个部署入口不等于没有数据库、embedding 或模型依赖。[主 LICENSE 为 MIT](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/LICENSE)。

适配仍需补：character→bank 绑定、DSH seq→document/fact 对照、本地失效屏障、P3/P4、作业账本及模型输入审计。后端自身抽取 prompt／中间输入的可重建性未验证，不能只拿最终 usage 宣称满足仓库的模型可见审计要求。

### 3.2 ReMe

固定提交 `b13034ba2ff7339bb03df4fa4ee130b47a731c6c`。

- [默认配置](https://github.com/agentscope-ai/ReMe/blob/b13034ba2ff7339bb03df4fa4ee130b47a731c6c/reme/config/default.yaml)及 [AutoMemoryStep](https://github.com/agentscope-ai/ReMe/blob/b13034ba2ff7339bb03df4fa4ee130b47a731c6c/reme/steps/evolve/auto_memory.py)确认 `auto_memory(messages,session_id,request_id)`；相同已完成请求可重放，输入不同拒绝。原子性不覆盖任意 Agent 文件修改，崩溃于回执前仍可能重复执行，[文档也明确这一边界](https://github.com/agentscope-ai/ReMe/blob/b13034ba2ff7339bb03df4fa4ee130b47a731c6c/docs/en/auto_memory.md)。
- [搜索](https://github.com/agentscope-ai/ReMe/blob/b13034ba2ff7339bb03df4fa4ee130b47a731c6c/docs/en/memory_search.md)使用 BM25、可选 embedding、RRF 和链接展开；默认配置没有开启向量存储。结果有路径／行号／chunk；文件写入成功与 watcher 完成索引是不同确认点。
- 可绕开自动记忆 Agent，采用确定路径的 [write](https://github.com/agentscope-ai/ReMe/blob/b13034ba2ff7339bb03df4fa4ee130b47a731c6c/reme/steps/file_io/write.py)／read／delete 及 search，避免重复提取；write 支持 metadata 和请求路径限制，但仅进程内路径锁，不承诺多进程事务。会话记录过滤了工具结果，因此不作为本项目工具结果的唯一档案。
- [HTTP client](https://github.com/agentscope-ai/ReMe/blob/b13034ba2ff7339bb03df4fa4ee130b47a731c6c/reme/components/client/http_client.py)通过 action 路径调用并消费流；需要适配其结果与错误，不是套一个 fetch 后就具备全部能力。[Python 要求与可选依赖](https://github.com/agentscope-ai/ReMe/blob/b13034ba2ff7339bb03df4fa4ee130b47a731c6c/pyproject.toml)中基础运行要求为 3.11+，core extra 会增加 Agent／向量等依赖，不能都算作必需，也不能漏计选中 extra。[主 LICENSE 为 Apache-2.0](https://github.com/agentscope-ai/ReMe/blob/b13034ba2ff7339bb03df4fa4ee130b47a731c6c/LICENSE)。

角色隔离优先独立受限 workspace／服务实例，不把所有角色写到共享 daily 再仅靠自然语言过滤。更正后 digest、链接展开和索引的关联失效未证明完整，需要 Host 过滤与重评。若只使用关键词检索，它比直接复用 DSH KV 多出 Python 服务及 watcher，而未减少本项目的成长逻辑；当前语义检索必需，ReMe 只能以实际开启向量的模式参与候选比较，不能以默认 BM25 配置降低要求。

### 3.3 Mem0 TypeScript OSS

固定提交 `f1791daa86d469249c9b002f62644d58a1eb96a0`；[包声明](https://github.com/mem0ai/mem0/blob/f1791daa86d469249c9b002f62644d58a1eb96a0/mem0-ts/package.json)版本 `3.3.1`，OSS 导出为 `mem0ai/oss`，与根导出的托管客户端区分。

[Memory 实现](https://github.com/mem0ai/mem0/blob/f1791daa86d469249c9b002f62644d58a1eb96a0/mem0-ts/src/oss/src/memory/index.ts)确认：add 默认 infer=true；infer=false 跳过事实推断，但 createMemory 仍调用 embedder 并生成 UUID，再写向量与 history。search 支持过滤；get/update/delete/history 可用于适配。调用方不能将“关闭推断”写成“无需 embedding／原生稳定源 ID／跨存储事务”。

角色 ID 与来源可放 metadata，Host 必须强制过滤并保存 episode→memoryIds。生成 UUID 的写入若成功但回执丢失，后续 add 可能生成重复记录，需要额外恢复策略。向量后端和历史后端按所选配置另计；package 中 optional peers 不代表必须全装，Node SDK 也不代表不存在原生模块或外部存储。还需桥接 DSH 模型路由及审计，不让其推断自动改 P4。[主 LICENSE 为 Apache-2.0](https://github.com/mem0ai/mem0/blob/f1791daa86d469249c9b002f62644d58a1eb96a0/LICENSE)。本轮保留为同条件备选，需将 SDK／存储配置与恢复映射成本，和可复用的向量能力一起核对，不能仅凭 Node 语言一致直接选定。

### 3.4 MemOS Local

固定提交 `3a16e5fe3048a209f722806f4123fa2e533588fd`；[子包声明](https://github.com/MemTensor/MemOS/blob/3a16e5fe3048a209f722806f4123fa2e533588fd/apps/memos-local-plugin/package.json)版本 `2.0.16-beta.1`。

- [公开 facade](https://github.com/MemTensor/MemOS/blob/3a16e5fe3048a209f722806f4123fa2e533588fd/apps/memos-local-plugin/agent-contract/memory-core.ts)有 prepareTurn、onTurnEnd、searchMemory、getTrace、submitFeedback、deleteTrace 等；它不仅是存储层，还带策略归纳和技能流程。prepareTurn 可不做前台检索，说明并非必须接受默认逐轮 recall，但仍需核对其他后台步骤。
- [core 组装](https://github.com/MemTensor/MemOS/blob/3a16e5fe3048a209f722806f4123fa2e533588fd/apps/memos-local-plugin/core/pipeline/memory-core.ts)与[默认配置](https://github.com/MemTensor/MemOS/blob/3a16e5fe3048a209f722806f4123fa2e533588fd/apps/memos-local-plugin/core/config/defaults.ts)涉及总结、反馈、归纳、技能及模型 fallback。不能将任务策略／技能结晶直接视为角色关系与主体性，也不能同时默认跑它的成长和本项目 P3。
- DSH peer 范围以 `<0.2.2` 等组合限制，使用本仓库 semver 对 `0.2.2-rc.1` 求值为 **false**，见[探针结果](m2-evidence/memos-peer-range-result.json)。这不是运行崩溃证据，却足以否定“当前宿主直接兼容”的假设；不能通过强制安装忽略。
- 运行依赖包括 better-sqlite3、transformers 等，需要考虑原生模块、模型文件及安装脚本。[主仓库 LICENSE 是 Apache-2.0](https://github.com/MemTensor/MemOS/blob/3a16e5fe3048a209f722806f4123fa2e533588fd/LICENSE)，子 package 声明 MIT，不能用任意一项代替完整许可核对。尚未核对完整发行物，保留为接入前置项。

如果以后采用，只考虑薄适配 facade 并明确关闭不需要的自动机制，先解决版本／产物和 namespace 语义；本轮不为它另维护一套 DSH 桥接。trace 删除后所有策略／技能依赖是否按本项目标准失效，仍标未知。

### 3.5 其他路线

- **Graphiti**：固定 `ed23196506eba8806fae6da831d73fcd2ad714d8` 的 [README](https://github.com/getzep/graphiti/blob/ed23196506eba8806fae6da831d73fcd2ad714d8/README.md)、[依赖](https://github.com/getzep/graphiti/blob/ed23196506eba8806fae6da831d73fcd2ad714d8/pyproject.toml)与 [Apache-2.0 LICENSE](https://github.com/getzep/graphiti/blob/ed23196506eba8806fae6da831d73fcd2ad714d8/LICENSE)已核对。时间图谱是有用能力；当前却需 Python、图数据库／对应驱动及自建服务边界，仍没有 P4 的角色提交控制。把它与 Zep 托管产品区分；未深入审计图谱更新的事务和多租户行为，不声称已满足硬约束。
- **LangMem**：沿用固定 `8620b986af5b0c7593e6b7fbece2998690d22d15` 的 [提取实现](https://github.com/langchain-ai/langmem/blob/8620b986af5b0c7593e6b7fbece2998690d22d15/src/langmem/knowledge/extraction.py)。messages＋existing＋max_steps 可形成有界提案，但需要 Python、LangChain/LangGraph、trustcall；本项目用现有 DSH 模型调用做一次提案更少一条路由，不等于提案质量已经优于 LangMem。
- **Letta Code**：沿用 M1.5 固定提交及 [MemFS 约定](https://github.com/letta-ai/letta-code/blob/a24b294aa19ed6c51cea4f68e1a36d90526fe700/src/agent/prompts/letta_root_memfs.md)，仅借分层思想。替换 DSH 的 Agent harness 超出本轮形态与接入成本边界；没有将其宣传的持续学习效果计入评分。没有完整审计它的服务端或所有当前产品形态。

## 4. 按平台无关契约比较

本表保留自建路线以展示需要我们自行承担的工作；它不再是首选。第三方列仍须补角色边界，但其已有索引／检索／操作能力应计入可复用收益。

标记：**宿**＝DSH 已承担；**薄**＝已存在相近接口，但仍需命名空间、返回值和错误适配；**补**＝本项目必须实现；**待**＝尚未证明契约。这里没有哪一列代表整套现成可用。

| M1.5 职责 | 自建 KV＋embedding（非首选） | Hindsight API | ReMe API | Mem0 OSS | MemOS Local |
|---|---|---|---|---|---|
| putExperience | 宿持久 KV；补确定 key、来源记录及异步编码／索引确认 | 薄：document_id＋async operation_id；等操作完成 | 薄：确定文件路径／请求回执；补索引确认 | 薄 add；补稳定来源→UUID 映射及丢回执恢复 | 薄 onTurnEnd；补稳定采集映射及重放核对 |
| search | 补 embedding 适配、向量／关键词融合；两路均检查来源有效性 | 薄 recall＋bank／来源过滤 | 薄 BM25／可选向量；隔离 workspace | 薄 search＋embedding＋强制 filters | 薄 searchMemory＋namespace；验证算法选择 |
| readSources | 宿异步日志读；补源 ID 展开 | 宿原文＋薄 chunks／documents 映射 | 宿原文＋薄路径／行号；工具结果不能只靠其副本 | 宿原文＋补 metadata 对照；memory 文本不等于原回应 | 宿原文＋薄 getTrace；验证保留范围 |
| invalidate | 补本地屏障、依赖重评和检索过滤 | 薄文档删除；补角色屏障；派生层行为待测 | 薄文件删改；digest／索引关联失效待 | 薄 delete/update；派生关系仍补 | 薄 trace 删除；策略／技能关联失效待 |
| deriveProposal | 宿模型调用；补证据包／schema | 保持 Host P3；reflect 不能直接当角色修订 | 保持 Host P3；不重复开 auto_memory/dream | 保持 Host P3；不让 infer 覆盖 P4 | 必须分清两套归纳／技能流程，只保留一位更新所有者 |
| inspect/recover | 宿 KV；补作业／游标／回执、embedding 版本及重建进度 | 薄 operations；补 Host 的两阶段确认与账本 | 薄完成回执；补崩溃前文件副作用与 watcher 恢复 | 补 Host 账本；向量＋history 恢复语义待 | 状态与队列较多；按本项目崩溃点核对，非直接兼容 |

所有路线共有的工作不能算作某个后端“免费提供”：专属 mode 准入、人格／快照、来源分类、现实／叙事隔离、P3 角色提案、P4 revision/CAS、本地失效屏障、审计与 A1–A14。选用外部服务仍需这些工作；本地路线也没有因此自动实现它们。

## 5. 首选路线如何落地，以及明确不做什么

### 5.1 角色插件与三方记忆组件的接入边界

首轮优先使用 Hindsight 独立 API，通过角色插件提供的局部工具按需查询；不直接启用默认全局采集／逐轮自动 recall 的第三方 DSH 插件。使用同一薄适配器契约评估 ReMe／Mem0，保留切换能力，不预先建设通用多后端框架。

| 链路 | 角色插件负责的输入／处理 | 交给三方的工作及返回 | Host 的确认点 |
|---|---|---|---|
| 写入 | 仅采集准入会话，flush 后组装有源 ID、角色／真实虚构标签的增量材料，生成稳定批次与内容 hash | 记忆持久化、分块、抽取、embedding、索引，返回文档／操作身份 | 区分原文已落盘、后端已接收、索引已可查；收到有效完成确认后推进对应游标 |
| 查询 | 角色工具接收自然语言 query，Host 强制角色命名空间、范围和返回预算 | 后端编码查询并做语义／关键词召回，返回材料、source/document IDs、可得分数及截断信息 | 检查本地失效屏障、展开来源、限制结果数量／文本，不能把生成答案直接当作角色事实 |
| 原文展开 | 将远端文档／事实 ID 映射到 DSH sessionId/seq/sourceRefs | 可利用后端 chunks／文档接口补上下文 | 精确反馈对象／工具结果最终回到 DSH 日志；摘要不是完整原文 |
| 更正 | 先原子更新 Host 失效屏障／evidenceRevision，并定位派生认识 | 调后端删改／失效接口，必要时重建受影响索引 | 后端同步前后查询均过滤；旧提案与旧索引任务不能使已失效来源重新有效 |
| 恢复 | 保存稳定批次、payload hash、远端 ID、确认状态和游标 | 查询／取消／重试后端操作，或按接口能力重放 | 不把入队或取消回执当成写入完成／事务回滚；不确定结果先核对，不盲目新建工作 |
| 成长 | P3 独立展开证据，产生有范围的认识／方法候选，P4 校验提交 | 后端仅供应记忆材料；必要的通用事实抽取不直接写角色档案 | P3/P4 是唯一角色成长与档案修订链，允许无更新 |

Host storageDomain 继续保存角色 aggregate、绑定、失效屏障、采集／调用账本及源 ID—远端 ID 映射，不再自建一份完整可检索经历库、向量缓存和融合索引。DSH 会话日志保留原始事实；三方保存为检索所需的副本／派生数据。后端返回材料不自动全量进入提示词，P1 仍复用上下文并按需查询。

三方内部通用抽取与角色成长要分清：例如 retain 抽取事实是后端索引工作，P3 则判断这些经历如何影响角色。默认关闭非必要的自动 consolidation／dream／reflect／技能生成，避免又产生一位角色状态更新者；确需启用时先说明用途、来源和额外调用。不能因后端提供 reflect 就把它当作 P4。

### 5.2 SQLite 与词面探针的历史边界


已运行[隔离探针源码](m2-evidence/local-contract-probe.mjs)，[结果](m2-evidence/local-contract-result.json)记录 Node `v24.15.0`、Linux x64、SQLite `3.51.3`，未加载 DSH 或调用模型：

| 合成检查 | 实际结果与限制 |
|---|---|
| 确定键 upsert、namespace SQL 过滤、事务 rollback、逻辑失效、关闭重开 | 均通过；不是 DSH storageDomain／断电／多进程验收 |
| unicode61 对句中中文词“失约” | 未命中；不能直接照搬默认英文全文分词 |
| trigram 对“失约”／“失约后” | 分别未命中／命中，与 [SQLite 三字符限制](https://www.sqlite.org/fts5.html#the_trigram_tokenizer)一致 |
| 带参数 LIKE 对“失约” | 命中；这不保证大数据扫描性能 |
| 词面匹配对“失约”／“爽约” | 前者命中、后者未命中；没有语义能力证明 |
| 简单内存词面检索的短中文、角色过滤、失效过滤 | 合成样例通过，仍不是产品检索质量结果 |

[Node 对应版本文档](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html)将 node:sqlite 标为 Stability 1.2（release candidate），不能拿当前 Linux 能力替代所有 DSH／桌面 Node 环境验收。这些测试只说明词面／FTS 和本机 SQLite 的边界，既不能证明自建方案更省事，也不能证明第三方语义检索可用。当前语义通道交给三方组件，首轮不自行实现 FTS／向量引擎。

复现探针：`node docs/companion/m2-evidence/local-contract-probe.mjs`。仅生成系统临时目录中的合成数据；输出不是仓库 build／L4 的通过证明。peer 范围结果来自固定 package.json 与本机 semver 求值，不曾强制安装 MemOS。

### 5.3 Hindsight 优先验证的具体配置与出口

用户已确认部署方案：**Hindsight 生成式 LLM 使用 `deepseek` provider，其他记忆服务模块本地运行**。可执行配置见[部署附件](../../plugins/role-agent/deploy/hindsight/README.md)：Hindsight 1.2.1 与 PostgreSQL/pgvector 固定镜像 digest；本地 CPU 多语 embedding／重排固定模型 revision；DeepSeek 初始模型显式为 `deepseek-flash`，可配置，关闭 thinking。模型与镜像身份已经核对，本机 Linux/WSL 已通过真实服务基础 smoke；完整语义、角色联调与恢复验收尚未完成。DSH 对话／P3 route 不随该决定自动变化。

这是待执行接入计划，不是已经部署运行的服务：

1. **固定产物与服务配置**：以 §3.1 固定源码或核验匹配的发布物／镜像 digest；记录 endpoint、认证引用、数据位置、备份恢复方式、抽取模型、中文／多语 embedding、维度、重排配置和版本。后端配置这些模型，角色插件不再直接维护 embedding API。聊天模型 route 不自动等于后端抽取／embedding route。
2. **隔离**：由 Host 将角色命名空间映射到 bank，不允许模型工具参数指定任意 bank。真实／叙事分类必须在后端或适配层可靠过滤；验证标签的实际匹配语义，不能假定默认过滤严格隔离。
3. **写入与确认**：候选映射为稳定 document_id、异步 operation_id＋固定 payload hash，确认操作完成后再宣告可查。每批携带可回到原日志的来源映射，不反复重发整段增长中的历史；文档／操作／索引可见性必须实测。
4. **更正**：先 Host 屏障，再同步后端删除／替换文档并重评角色派生认识。如果远端一条事实混合有效与失效来源，不能仅删除一个引用后继续信任整条事实；先过滤或失效受影响材料，再用仍有效来源重建。
5. **关闭重复机制并计费**：优先关闭自动 consolidation／observations，不调用 reflect 更新角色；若组件配置不能可靠关闭或追踪所需机制，记录实际调用和冲突，回到候选比较，不能声称后端只有一次 retain 成本。
6. **最小接口试验**：同一批写入重试／丢回执、自然语言释义查询、原文展开、更正后查询、服务重启恢复及普通 mode 对照。语义服务故障返回明确失败／部分覆盖，不静默变成纯关键词后验收。

§7 的完整行为验收属于 M3；这里的接口、配置和调用可观测性核对用于闭合选型。缺少后端模型配置、来源映射、必要审计或真实语义证据时保留未完成状态。ReMe 向量模式／Mem0 OSS 使用同一组输入与硬约束替换验证，而不是用不同目标证明某一品牌更优。

## 6. 完整成本模型

### 6.1 接入工作与运行组件

| 路线 | 在共有角色工作之外的接入任务 | 额外运行面 | 本轮判断 |
|---|---|---|---|
| 自建 KV＋embedding（非首选） | 经历表、编码服务适配、批量／缓存、模型版本／重建、向量相似度／融合、更正过滤和质量验证 | 必需 embedding 服务或本地推理运行时；向量缓存、网络／CPU／内存，暂不加专用向量数据库 | 非首选；保留为自研工作量对照 |
| SQLite 派生索引 | 加上 FTS 与短词策略、索引一致性、Node 能力／阻塞处理 | 原生 Node 模块能力、索引内存／文件 | 没有消除语义差距，首轮不选 |
| Hindsight | HTTP／超时／认证、bank 初始化、文档映射、异步 operation 等待／恢复、内部模型审计、数据库备份／升级 | 应用、PG/向量、embedding／重排及抽取模型配置 | 优先接入验证；记录实际省掉的索引工作和新增运维／模型成本 |
| ReMe | action 流解析、受限 workspace、文件版本／索引确认、服务生命周期、关闭重复自动工作 | Python、文件／派生索引、watcher；向量／Agent extras 按实际启用计 | 仅词面用途的新增成本较多；文件需求增强时可重评 |
| Mem0 OSS | SDK 构建依赖、向量／history 初始化、embeddings／DSH 路由、UUID 映射及不确定回执恢复 | SDK、选中的存储／embedding；并非全部 peers | Node 语言一致未抵消恢复和配置成本 |
| MemOS Local | peer 版本适配、原生模块与产物核对、namespace、关闭冲突机制、策略／技能来源与删除传播验证 | SQLite、模型与 embedding 管线、可能的模型文件 | 面较广且版本不直接契合，首轮不承担 |
| Graphiti／LangMem | Python 运行与调用桥接；前者另需图服务，后者需已有模型／存储体系适配 | 另一套 SDK／运行依赖 | 仅缺少对应不可替代能力时引入 |

这是已识别工作包与运行面比较，不是人日或 RSS 实测。当前首选方向需计入三方应用／数据库、模型配置、抽取／embedding／重排和升级恢复；也要计入组件已有索引与操作能力减少的自研工作。不能再用“少一个服务”直接推导总成本更低。相关性差导致的重查、错误和额外工具循环也计入 M3。

### 6.2 模型、token 与调用数

令 N 为完成对话回合数，Q 为产生的额外工具续步请求，J 为合并去重后的实际复盘批数（包含优先反馈、更正重评），B 为普通批量窗口。主对话调用不是固定 N：在没有重试时，单次查阅再回答的简化情形为 N＋Q；工具多步按实际请求计。

非首选自建路线的对照计算：`生成调用 = N＋Q＋J＋重试/修复调用`；另外必需 `文档编码＋查询编码＋失败重试＋模型/处理版本变化后的重编码`。embedding 与生成是两类调用，不能因没有新增聊天 LLM 就漏算前者。普通未查往事的回合不强制编码查询；无更新仍计一次复盘。

当前三方记忆路线：在各自提供的 embedding 外，再按实际启用加 `后端抽取＋consolidation/dream＋后端 query/reflect＋其他内部生成调用`；embedding 与 rerank 另外计调用量、token／字符、设备时间和费用。关闭一层自动机制不会自动关闭其他层。Mem0 infer:false 可消除其事实推断，但不能消除 embedding；ReMe 纯 write＋BM25 可不做提取模型；Hindsight 普通 retain 的抽取须实计。

**纸面例，仅算术并非实测**：80 回合、16 次单步检索续步、B=8 且每满批处理、无额外优先事件／重试时，本地仍为 96 次主对话请求＋10 次复盘＝106 次生成调用，但还需 embedding：若80回合恰好各一个片段、每次检索一个查询且无缓存命中／重算，则是80个文档编码输入＋16个查询编码输入；批量 API 请求数与输入条数不能混算。长内容分块会更多。服务版本仍保留角色复盘；后端实际抽取次数不能用“10 次 API 请求”代替，因为分块、重试及内部步骤可能再调用模型。

费用按 route 分开计算：`Σ(未缓存输入 token×对应单价＋缓存输入 token×对应单价＋输出/计费推理 token×对应单价)＋embedding/rerank＋存储/托管费用`。长度、缓存命中和供应商计费规则以实际 usage／账单为准；后台不假定复用前台缓存，未知单价不填 0。独立复盘的审计 Session 增加持久日志体积，原始对话、经历文本与索引副本也计入存储。

当前 DeepSeek provider＋本地检索基线已运行，逐用途 usage、1k／10k资源与费用估算见 [M3 §6](role-agent-m3-acceptance.md#6-资源与费用)。部分中断请求及服务崩溃实验无完整费用，不能称总账闭合，亦不报元／天。本地 embedding／重排不产生远端模型 API 费用，但仍计 CPU、内存和存储；后端抽取发送的对话材料进入 DeepSeek，按实际调用收费。M3 记录每请求来源、route、用途、usage、重试、队列时间与账单可得项；不提供完整内部账目的候选明确计为可观测性缺口，不能因此宣称更便宜。

## 7. M3 同条件试验计划与切换门槛

### 7.1 固定条件与对照

先完成 M1.5 的专属 mode、准入、合法记录与恢复；只用一次性测试 profile 和合成经历，不接日常聊天。固定 DSH/Node、插件提交、聊天模型与三方组件内部抽取／embedding／重排配置、分块与召回预算、初始档案、源消息、预算、topK、结果长度；服务另固定源码构建或核验镜像 digest，不用 latest。不能一边改变检索后端、一边给它额外 P3 机制。

三个角色对照保持模型与场景一致：B0 只有角色核心／宿主当前历史；B1 加经历检索但关闭成长提交；B2 加完整 P3/P4。用于区分“记住了”与“成长了”，不是三个独立产品。候选对照只替换 B1/B2 的 P2，保持 Host 的角色状态和提交者一致。后端如支持关闭关键词／向量通道，可分别作消融；不为实验强造未提供的开关，也不把纯词面列为可交付候选。

### 7.2 先测契约，再测相关性与体验

| 验证组 | 输入／观察点 | 通过门槛与失败处理 |
|---|---|---|
| 身份与 mode | 角色／普通／子 Agent／fork 并存；安装和禁用前后比较 | 普通模式无角色提示、工具、采集或成长调用；不得改默认值。任何串扰先修，不进入体验评分 |
| 来源与可靠性 | 重复批、丢回执、写后未推进游标、提案后未提交、提交后未确认、旧批与更正竞争 | 同一来源不重复成长；无静默覆盖；失效源不返回为有效证据；sourceId 展开匹配原始日志。A3/A7/A9/A11 硬约束零违规 |
| 必需语义召回 | 预先标注 40 个查询：10 词面（至少4个中文短词）、10 无相同关键词的释义、6 时间／范围、6 反馈对象展开、4 更正、4 跨角色；冻结后再跑 | `topK=5`、相同总返回预算。40项至少34项包含所需来源；词面至少9/10、释义至少8/10，必须确认实际启用语义通道且不能为测试人工加同义词；若后端支持关闭词面通道，再用纯语义组复核，缺此开关不假称做过消融；更正及跨角色零违规。工程试验门槛，不是论文结论或最终质量保证 |
| 编码与索引故障 | 后端语义模型未配置／超时、索引未就绪、源文本修改、后端模型切换／重建及服务重启 | 后端错误明确失败；核对模型升级／重建接口，不自造内部保证；未索引与无匹配区分，失效材料不能恢复，不能静默退成纯关键词后通过 |
| 成长行为 | 原 M1 R/S 连续脚本、A1–A8/A13，检查证据→提案→提交→后续行为 | 可无更新；身份／关系／方法分区正确；B2 的变化须有来源，并体现自身关注／判断，不能只比记忆命中率 |
| 上下文 | C1–C7/A14，检查真实请求与合法事件 | 普通续聊无重复快照；修订、压缩恢复、更正有效，后端不额外逐轮 recall |
| 注入与边界 | 至少6个反例，来自用户引用、工具／网页、召回正文、派生摘要、虚构情节和跨角色 ID 参数 | 不改变身份／权限／更新规则，不能将引用升级为用户授权；不能仅因 JSON 合法就通过 A10 |
| 资源与完整成本 | 1k／10k合成经历，初始化、内存、检索 p50/p95、主循环延迟、全部生成／embedding 请求及费用 | 无无界队列／重试；失败与空结果可区分。先记实测再决定资源预算，未测不报性能通过 |

多来源问题必须返回全部必要来源才计成功；不能靠返回所有历史提高命中。召回阶段固定文本预算初值 2,000 token（按实际计数器核对）与 topK=5；预算不足和截断单独记账。可检索文本生成不得用测试问题倒推标签，释义组不能临时加人工同义词。

40项是首轮诊断集，无统计显著性或长期体验保证。成长行为需跨新会话、重启及反馈延迟复验；M4 才观察持续相处。

### 7.3 候选通过、替换与回流

- 优先执行 Hindsight 的 §5.3 接入核对；有真实中文语义结果、来源与更正／恢复证据且成本可接受时，固定版本配置后选定。此前不得记为最终胜出。
- 接入失败按职责定位：Host 映射或作用域问题修薄适配；后端缺失必要接口、内部审计不可满足或维护／运行成本不合适，则以同一组数据比较 ReMe 向量模式和 Mem0 OSS。
- 调整分块／召回配置或后端模型时保留实验版本与全部成本；不能通过手工同义词、返回所有历史或偷偷增加复盘机制来掩盖语义能力问题。
- 自建 embedding＋索引需要重新提交可复核的缺口与完整成本比较，不作为三方接入失败后的自动退路。没有语义可用证据时停留为未完成，不交付纯关键词版。

不自动安装未知服务、下载 embedding 权重或切换供应商；实际 M3 将按既定选型和必要条件推进，缺少模型／认证信息时明确提出所需输入。

## 8. 给 M3 的明确交接与 M2 完成对账

交接顺序：先按 §5.3 闭合候选组件及服务／模型配置→M3 专属角色 mode 与隔离→来源采集、远端 ID 映射／幂等与后端完成确认→局部语义查询工具及源展开→独立审计复盘和 P4 原子提交→更正／恢复与上下文→固定行为／相关性对照。各模块仍按 M1.5 P1–P4 组织，不创建新的领域层。

M1.5 的最小回写：P2 存储与检索交给三方记忆组件，优先验证 Hindsight 独立 API；Host domain 只保留角色档案、绑定、源映射／回执及屏障，不自行维护向量索引。原平台无关 put/search/read/invalidate/inspect 契约继续保留；未来服务适配替换 P2，不接管 mode、人物状态或 P4。单记录 aggregate 的版本／回执／游标边界及更正屏障不变。

| M2 出口 | 交付位置／证据 |
|---|---|
| 候选范围、实际接口与能力差距 | §2–§4；40个固定源文件及 hash，不依赖宣传排名 |
| 首轮技术选择与未满足能力 | §1、§5；确认三方记忆与角色成长分工，Hindsight 首轮工程基线已接入；模型配置、40项召回和恢复见 M3，长期质量未知 |
| 接入、运行、模型与存储总成本 | §6；区分共有角色成本、额外组件、API请求与内部调用，实测与逐请求估算见 M3 §6；费用完整性仍有缺口 |
| 同条件试验、门槛、失败与回流 | §7；与 C1–C7/A1–A14 对齐，路线失败回 M2，宿主机制变化回 M1.5 |
| 实际执行与证据边界 | 本阶段完成源码核对与探针；后续 M3 已补真实部署、插件及模型短轨迹，见独立验收 |

M3 已实现薄适配并补齐真实工程验收：[结果](role-agent-m3-acceptance.md)、[脱敏证据](m3-evidence/acceptance-summary.json)。Hindsight 作为首轮记忆基线的语义／来源／恢复依据已建立；不据此宣称它优于所有备选、角色长期成长成立或完整费用已知。M4 未开始。

修订记录（2026-11-15）：先前纯词面首选因用户要求语义能力而撤回；随后自建 embedding＋内存检索首选也按本次已确认的职责分工撤回。当前改为三方承担记忆检索，优先验证 Hindsight，ReMe 向量模式／Mem0 同条件备选。受影响 P2、M2职责／成本、M3接口／语义／恢复验收及 A7/A9/A11/A14；P1/P3/P4 与角色 mode 隔离不变。历史探针仅保留为边界证据。

[返回初步落地](role-agent-initial-plan.md#5-推进阶段) · [返回专题导航](README.md)
