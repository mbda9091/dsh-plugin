# 角色 Agent 显式真实验收（M3／M5）

这些入口不属于默认 `test`，需要本机已运行的 Hindsight 和收费 DeepSeek API。使用合成材料、独立 bank、受管测试 home；不读日常聊天，不重启日常 DSH 或记忆服务。真实服务故障测试另建 Compose project，只共享只读模型卷，结束后删除自己的数据库卷。

先按仓库要求准备 Node 24／pnpm／workspace DSH，并执行 `node scripts/dev.mjs build`。密钥来自 `role-agent/deploy/hindsight/.env`，格式与[部署说明](../../../role-agent/deploy/hindsight/README.md)一致，不把密钥作为命令参数。网络需要代理时由启动环境提供；本机地址须加入 NO_PROXY。不要给验收驱动进程加 `--use-env-proxy`，否则可能把本地测试 API 发往代理。

```sh
node test/acceptance/role-agent/run-memory.mjs --live
NO_PROXY=127.0.0.1,localhost node test/acceptance/role-agent/run-dsh.mjs --live --mode B2 --scenario S --context
NO_PROXY=127.0.0.1,localhost node test/acceptance/role-agent/run-dsh.mjs --live --mode B2 --scenario R
NO_PROXY=127.0.0.1,localhost node test/acceptance/role-agent/run-dsh.mjs --live --mode B2 --scenario I
node test/acceptance/role-agent/run-service.mjs --live --load
```

- `run-memory.mjs`：冻结的 `semantic-cases.json`，40 项、topK=5／2000 facts token，真实抽取、语义查询、更正、原文展开和持久重放。使用真实领域存储／Session，完整 DSH Agent 由下一入口验证。fixture SHA 随报告记录；不从问题生成索引文本。
- `run-dsh.mjs`：真实 DSH Web／官方 DeepSeek provider。`--mode B0|B1|B2` 分别关闭长期记忆、关闭成长、完整机制；`--scenario S|R|I` 为方法、角色判断／兴趣、注入。B1 的空提案适配器是测试控制，不作为收费模型调用。`--analysis-first` 改变记录在案的初始方法倾向；`--silent-feedback` 独立替换正反馈；`--two-trials` 验证候选→试用→新反馈支持；`--context` 原生压缩并重启恢复；`--interrupt-reflection` 中断测试延迟适配器，再用真实模型恢复同一任务，不宣称杀死了远端请求。
- `--scenario F` 是反馈修复的10轮真实回归：明确正负评价、请求建议、更正、含糊评价、只请求复盘及第三方引用。检查正负评价实际登记、其他情境没有正向误登记；与 `S --two-trials` 分开验证正常晋级，不能靠把所有评价忽略来通过。
- `run-service.mjs`：Linux/WSL host-network 环境；需 Docker、已缓存固定镜像和模型卷。观察真实抽取子任务 processing 后 SIGKILL 自己的服务，核对恢复、同 operation ID 重放、pg_dump/restore。`--load` 在 chunks 模式装入 1k／10k 文档并测查询；`--load-only --load` 仅跑容量。该容量测试不包含 10k 次 LLM 抽取，不替代成长质量实验。
- `summarize.mjs RUNS.json OUTPUT.json`：从选定运行目录导出脱敏摘要、证据哈希、逐用途 usage／耗时、回复及档案；保留探索期失败报告清单。费用只对已知 usage 按记录的单价估算，缺项不能当 0。固定模型别名仍可能由供应商更新，不是模型权重锁定。

原始报告、合法会话、模型请求／内部 trace 在 `.tmp/m3/`。其中测试 Web 日志可能含临时认证 URL，不能整体提交或上传。驱动 finally 移除临时 `.env`／凭据文件并删除 bank；异常退出后应核对自己的临时目录／project，不能清理主服务或共享模型卷。阶段结果与边界见 [M3 验收记录](../../../docs/companion/role-agent-m3-acceptance.md)。


## M5 增量入口

```sh
NO_PROXY=127.0.0.1,localhost node test/acceptance/role-agent/run-dsh.mjs --live --mode B2 --scenario W
NO_PROXY=127.0.0.1,localhost node test/acceptance/role-agent/run-dsh.mjs --live --mode B2 --scenario V
node test/acceptance/role-agent/run-long-memory.mjs --live
```

W 使用真实 DeepSeek 决策和真实搜索／网页 provider，验证联网及临时文件写入回读；V 使用自有文件／终端反例检验来源与人格权限边界，自动工具检查与人工语义审阅分开。二者开放角色标准工具，放宽权限仅限一次性 fixture，不改产品默认权限。

`run-long-memory.mjs` 使用真实 Session 日志与 Hindsight，P3关闭，以大于24,000字符的自有材料验证分片索引、首片确认后重启续传、头中尾语义查询及范围展开、整来源更正和远端全片删除。报告在 `.tmp/m5/long-memory-*`，finally清理bank和凭据；不代表成长质量验证。

固定包／L4 的 `role-agent-contract/m5.js` 另外比较同条件 standard／role-lan 的工具名及schema，脚本模型驱动原生工具和异步事件，web provider 为明确测试替身，询问自动回答与权限仅fixture内生效；不能将其称真实联网。真实网络证据单列 W。图片只验证原生读取附件路径，不评估视觉理解。结果及未测矩阵见 [M5 记录](../../../docs/companion/role-agent-m5-plan.md#8-实现与验收记录2026-11-16)。
