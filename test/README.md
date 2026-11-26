# 测试目录

先按归属找目录，再按测试层级找文件。

| 目录 | 测什么 |
|---|---|
| `src/common/l1/` | 脚本、配置、宿主复用、清理、Git hook 等通用逻辑 |
| `src/common/l2/` | 独立发现全部活跃插件，逐包检查打包契约 |
| `src/common/l3/` | 构建、安装、报告与测试生命周期的集成行为 |
| `src/common/environment/` | fast/real 环境套件，含真实冷安装和目标隔离 |
| `src/common/harness/` | 共用的 fixture、模拟 Context、打包和进程辅助工具 |
| `src/plugins/notify-web/` | 通知插件及通知共享库；内部为 l1、l3、e2e |
| `src/plugins/role-agent/` | 角色插件；内部为 l3、acceptance |
| `fixtures/common/` | Web 基线和场景不匹配等通用素材，不是正式插件 |
| `fixtures/plugins/role-agent/contract/` | 角色插件真实能力契约素材 |

停更插件的旧测试留在 `archive-plugins/<id>/tests/`，不进入当前测试集合。

在仓库根执行，命令不因目录整理而改变：

```sh
node scripts/dev.mjs test                     # 全部 L1–L3
node scripts/dev.mjs test --only l1           # 通用和插件专属的全部 L1
node scripts/dev.mjs test --only l2,l3
node scripts/dev.mjs test-env --suite fast
node scripts/dev.mjs ci                      # 环境 all → 类型 → L1–L3 → L4 → L5
```

L4 的通用验收由 scripts 编排，并调用各插件登记的能力适配器；L5 的浏览器实现位于通知插件 e2e 目录。角色插件 acceptance 是需相应服务/凭据的独立验收脚本，不随 node:test 自动执行，见该目录 README。

编译产物统一进入 `.build/`、`.build-env/`，不手改、不提交。报告与临时环境仍按原规则存入仓库 `.tmp/`；测试归属目录不承担运行时数据存储。
