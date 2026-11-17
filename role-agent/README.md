# 成长角色

用途：在专属「角色对话 · 岚」模式中，通过 Hindsight 独立 API 保存可溯源经历、按需语义查询，并后台提交有界成长修订。普通模式不注册角色人格／工具、不采集经历。M3 已运行真实 Hindsight／DSH 隔离工程验收与短场景，见 [验收记录](../docs/companion/role-agent-m3-acceptance.md)。M5 已补齐标准工具与长材料适配，见 [实现与验收](../docs/companion/role-agent-m5-plan.md#8-实现与验收记录2026-11-16)。长期成长收益未证明，M4 其余建设／持续试用待推进。

## 适用场景

桌面与 Web，Linux、macOS、Windows。当前自动验证优先 Web；桌面未实测。不支持自动接入子 Agent／分叉。

构建后按仓库方式安装本插件，新增 `role-lan` 自定义模式，不改变默认模式。preset 的薄 ESM 子入口注册局部人格与工具；支持空白会话在标准与角色模式之间切换，退出即撤去贡献，重新进入的采集从明确边界开始。在新建空白会话选择它；已加载 Host 代码更新后重启 DSH。依赖宿主已有 agentPresets、sessions、sessionPersistence、systemPrompt、tools、llm、storageDomain。存储路由未配置时明确失败，不自行重写 profile 存储配置。

## 工具与共同活动

角色模式沿用固定 DSH `0.2.2-rc.1` 的标准工具装配：网页搜索／读取、文件与图片读取／编辑／搜索、平台终端、后台 jobs、定时任务、技能、目标／待办／规划、询问用户、展示产物及已启用的插件管理。排除子 Agent 创建／分叉／控制及依赖子 Agent 的 workflow。原生权限与 provider 配置继续生效，不因角色身份自动授权；普通模式保持原装配。

该映射不会动态继承以后所有用户定制；升级须重新对账工具名与 schema。本次实际验证 Linux Web，其他平台及桌面未测。图片可走宿主原生附件路径，未建设视觉记忆。

## 配置

Host 行 `role-agent` 的配置（由用户 profile 覆盖；不要改 bundle 承载全局默认设置）：

```yaml
- id: role-agent
  config:
    characterId: lan
    presetId: role-lan
    endpoint: http://127.0.0.1:8888
    apiKeyEnv: ROLE_HINDSIGHT_API_KEY
    batchTurns: 8
    timeoutMs: 120000
```

`endpoint` 是 Hindsight base URL，不含 `/v1`。未配置时仍可使用当前角色与会话上下文；记忆工具明确不可用，采集任务保留待重试，绝不回退纯关键词。认证只从 `apiKeyEnv` 指向的环境变量读取，错误不回显响应正文／凭据。

已确定的服务方案为 **Hindsight 的生成式 LLM 使用 DeepSeek provider，Hindsight／数据库／多语 embedding／重排本地运行**。独立的 [Compose 配置与部署步骤](deploy/hindsight/README.md)包含固定镜像 digest、检索模型 revision、密钥示例与数据恢复说明；需显式启动，插件加载不下载模型或自动启动服务。DSH 对话和成长复盘 route 保持独立，Hindsight 的环境配置不会自动配置 DSH 的模型。Linux/WSL Web 已完成中文40项、真实角色短轨迹、纠正、压缩／重启与数据库恢复；费用按可得 usage 估算，部分中断请求仍未知。

`characterId` 默认 `lan`，`presetId` 默认 `role-lan`。修改它们不迁移已有会话；自定义 preset 时同步声明相应的独立 preset 行。`core` 可显式替换固定角色核心，后台不可修改；默认角色无现实身体或离线生活，关注叙事创作和独立判断。`reflection` 可指定完整 provider/model route，否则使用证据回合记录的 route；无路由则延期，不猜供应商。

预算：`maxEvidenceChars=24000`，`memoryPartChars=8000`（大经历来源分片），`maxBeliefs=24`，`maxHits=5`，`maxResultChars=8000`，`maxResponseBytes=1048576`，`maxTokens=2000`（Hindsight facts），`timeoutMs=120000`、`pollMs=500`、`maxPolls=240`、`maxWorkPerDrain=32`、`maxAttempts=3`。自动预算耗尽后保留任务；同进程诊断可显式调用 `ctx.roleAgent.retry({ resetBudgets: true })` 重试，启动恢复不会重置预算。超预算／索引未确认／模型失败保留未处理来源，不声称成功。`Config` 字段注释是完整配置说明。

## 行为与限制

- 角色局部工具为 `role_recall`、`role_read_sources`、`role_note_feedback`、`role_correct`；更正必须有明确用户消息与精确来源，不能直接修改身份或权限。`role_note_feedback` 必须区分 `review-request` 与 `method-outcome`；后者携带 `polarity`、用户原话 `quote`，可给 `targetSourceId`／`methodId`。省略目标时取本会话此前最近完成回复，未知方法可留空但不能支持升级。
- 请求复盘不生成效果凭据，负面／含糊／未关联方法的效果不能支持升级。晋级必须引用同一方法的实际试用和新的正向效果评价；相关原文进入独立复盘，重复处理不重复计证，更正会使关联效果失效。理解语义仍由模型负责，程序核验出处和晋级边界；见[修复与验证](../docs/companion/role-agent-feedback-fix.md)。
- 旧记录可继续打开；新增 `outcomes`／`methodTrials` 默认为空，旧 `feedbackSources` 只保留兼容读取，不再作正向晋级凭据。历史已提交认识不自动清空，也不宣称已全部重新认证。旧参数 `{}` 调用反馈工具会被拒绝，须采用显式分类。
- Host 只保存角色状态、来源／远端文档映射、修订／回执和失效屏障。Hindsight 承担抽取／embedding／索引／语义查询；不使用其默认 DSH 插件，不逐轮自动 recall。私有 bank 随角色持久 namespace 创建，关闭自动 consolidation／observations。
- `role_read_sources` 可带 `ranges: [{sourceId, start, end}]`，UTF-16坐标基于带归属标签的来源文本；返回实际覆盖范围、`complete`／`partial`，整个JSON默认不超8,000字符。大经历按片保存稳定ID、hash、回执和尝试；重启续传，更正使全部片立即失效并异步删除。复盘 coverage／partialSources 显式记录，片段评价不能支持晋级。只索引日志实际文本，不自动打开溢出文件或持久复制所有读到的完整文件。
- 原生 schedule／tool-jobs／goal 投递属于活动来源，不是用户授权或效果反馈；只有当前未结束回合的真实用户消息能登记反馈／更正。后台 job 注册与完成分开，独立结算保留成功／失败／终止状态及owner。
- 来源采集读取持久会话日志，排除快照、召回内容和分叉继承。源消息与提案分别可追溯；后台审计 Session 无 Agent／无角色绑定，不参与经历采集。
- 单角色后台串行；单 aggregate 提交档案、批次回执和游标。版本冲突／更正先阻止旧提案；失效屏障立即作用，远端删除可稍后完成。原始日志不被删除，已见旧内容只能明确更正。
- 档案复用 DSH runtime-context 去重／重建；更新会留下旧历史，最新快照声明替代。语义结果属于不可信材料，不是新权限。
- 数据／账本当前随经历增长，未提供无限期容量保证、管理 UI、多用户身份映射或完整物理遗忘。长材料已支持分片索引、回执恢复与按范围展开；单次复盘只读有界片段，来源过多无法容纳最低证据时仍延期，不能称审阅全文；未做通用实体关系图。
- 固定 Hindsight 的内部请求 trace、中文有界召回、操作完成／来源、在途恢复及备份还原已有真实证据；服务升级和桌面运行未测。不能把短轨迹或契约测试当作长期体验成立。

独立实现、结果与未验项见 [M3 验收](../docs/companion/role-agent-m3-acceptance.md)和[落地记录](../docs/companion/role-agent-initial-plan.md)；仓库内部测试使用受管／一次性 profile，不读取日常环境。
