# 插件与测试目录整理

> 完成：否。状态：插件/测试迁移已验收；共享库追加迁移已验收，未提交。更新：2026-11-26。实现 commit：未提交，基线 `968b498`。

## 目标与范围

活跃插件统一放入 `plugins/`，停更插件统一放入 `archive-plugins/`；测试先按归属、再按层级组织。包名、插件 ID、测试命令、测试用例与业务行为不变。原有 Codex 登录方案改动保留，不操作用户日常 DSH，不自动提交或推送。

## 目录约定

```text
plugins/notify-web/、plugins/role-agent/       活跃插件
archive-plugins/app-restart/、desktop-notify/ 停更源码及其专属旧测试
plugins/common/notify-core/、notify-host/  私有共享库，common 不参与插件发现
test/src/common/l1、l2、l3/                  通用工具链与跨插件契约
test/src/common/environment/                fast/real 环境测试
test/src/common/harness/                    共用测试工具
test/src/plugins/notify-web/l1、l3、e2e/     通知插件及其共享通知逻辑
test/src/plugins/role-agent/l3、acceptance/  角色插件自动测试与人工/服务验收脚本
test/fixtures/common/                       通用测试素材
test/fixtures/plugins/role-agent/           角色插件能力契约素材
```

通用 L2 仍独立发现并逐包验证全部活跃插件；不按插件复制通用测试。测试编译结果仍放 `test/.build`、环境测试放 `.build-env`。保留 `--only l1|l2|l3` 的选择语义；移动时同步相对导入、编译路径、固定源码路径、HMR、fixture 生成与文档链接。

## 实施与验证

先记录迁移前插件/测试清单，移动目录并同步发现逻辑、workspace 和编译配置；用包管理器重建 lockfile 的 importer 路径并冻结安装，不手改依赖版本。随后检查类型、测试文件集合与原用例数量，运行完整 CI（环境 all → 类型 → L1–L3 → L4 → L5）及打包内容/运行入口复核。

源目录绝对路径发生变化，曾直接链接旧源码目录的外部 profile 需要重新安装；固定归档安装不迁移、不删除。已有受管开发环境（包括只做过 init、尚未安装插件的环境）仍可能保存旧 HMR 模板；若已链接旧目录也会悬空。需要迁移开发环境时，先停止并按需备份其开发会话，再执行 `node scripts/dev.mjs dev-web reset --yes` 和 `node scripts/dev.mjs dev-install`，重建新路径与 HMR 模板；reset 仅允许解除与 ownership 精确匹配的悬空旧链接，未知目标继续拒绝。共享测试宿主仍沿既有指纹规则判断，workspace/锁路径变化可能使其重建一次。构建产物的 sourcemap 与 README 路径允许随布局变化，不冒充 tgz 全字节不变。

## 验收与结果

对象为 `968b498` 加本轮未提交改动，真实环境为本机 macOS、Node 24.16.0、pnpm 11.28.5、workspace DSH 0.2.2-rc.5；Windows/Linux 和角色独立 Hindsight 服务验收未实机执行。

| 核对 | 结果与证据 |
|---|---|
| 目录与发现 | 仅发现 plugins 下两个活跃包，根旧插件目录和 archive/e2e/acceptance 旧入口均不存在；单元回归排除停更包与根部误放的 bundle |
| 测试集合 | 迁移前后 32 个 L1–L3 文件逐项映射一致；新增一项分组/层级选择回归，环境、浏览器、停更测试不会混入；反转插件选择分支时回归按预期失败，`.tmp/repository-layout-mutation.json` |
| 源码与依赖 | 14 个插件 src 文件字节不变；解析比较锁文件 settings/packages/snapshots 与每个 importer 的依赖完全一致，仅两个 importer 的位置改为 plugins 下；由 pnpm 生成，未手改版本 |
| 冻结安装 | 现有 workspace 的冻结离线安装通过；最终源码在新 checkout 首次冻结安装及 postinstall 通过，`.tmp/repository-layout-fresh-install.log`、`.tmp/repository-layout-fresh.json` |
| fast | 28 项通过，含精确归属的悬空链接 reset、错误目标拒绝、搬迁后源码保全与 HMR 重建；`.tmp/environment-tests/run-cbDJPG/report.json` |
| 最终完整 CI | 五阶段全部通过：环境 all42 → 类型 → L1–L3 331 通过/1 项既有平台跳过，共 332 → L4 → L5；`.tmp/ci/run-IkQVok/report.json`、`.tmp/repository-layout-ci-verified.log` |
| 独立报告 | 环境 `.tmp/environment-tests/run-FLQySW/report.json`；L4 `.tmp/l4/run-BOd6zB/report.json`；L5 `.tmp/l5/run-3wMFFf/report.json`；共同锁正常释放 |
| 打包对比 | 新 checkout 的真实 pack 通过；notify-web 22 文件、role-agent 29 文件清单和包元数据不变，4 个 JS 的完整 token 序列一致；变化为源码路径注释、sourcemap 与 README 链接，未宣称 tgz 字节相同。`.tmp/repository-layout-package-comparison.json`、`.tmp/repository-layout-pack.log` |
| 手动验收脚本 | role-agent acceptance 全部 mjs 通过 node --check；没有调用外部模型、服务或用户凭据，不声称独立服务验收通过 |
| 导航 | 根 README、plugins/README、test/README 与 AGENTS 同步；480 个原有本地链接中仅 3 个指向用户已授权删除的旧报告，未重造历史证据；docs/archive 的文档归档不随 archive-plugins 改名 |

### 发现的问题与修正

独立只读 CR 指出的旧 L2/L4/L5/手动验收 fixture 路径、pre-push 的相对模块说明符及安全规则精确路径均已修正；增量复核无剩余运行代码阻塞。安全 allowlist 只将既有精确路径改为 `plugins/notify-web/src/questions.ts`，AND 条件及行匹配不变。停更插件不升级 DSH 或改业务逻辑。

初版完整 CI 在真实 DEV-03 失败：模拟插件仍建在旧根位置，已改到 plugins；第二次在 profile-install 测试 fixture 创建新父目录时缺少 recursive，已修正并先定向确认 L3 的 176 项通过，再重跑完整 CI。两次失败报告保留为 `.tmp/ci/run-u1LTkz/report.json`、`.tmp/ci/run-k6251P/report.json`；均未冒充通过。最终结果以上表 run-IkQVok 为准。

### 现有工作区安全登记与后续提交

现有安装记录仍登记旧 gitleaks 配置哈希。官方 `.security/setup.sh` 拒绝未提交的路径规则变化，pre-commit 又要求配置与旧安装记录一致，因而不能直接在当前工作区登记这份未提交规则。全局 setup 的只读预览也报告冲突。证据为 `.tmp/repository-layout-security-refresh.log`、`.tmp/repository-layout-security-plan.log`。没有删除/改写安装记录、关闭 hook 或使用 --no-verify。

新 checkout（路径由 `.tmp/repository-layout-fresh.json` 记录）通过官方首次安装并登记新规则。后续用户明确要求提交时，可先同步最终源码和文档到这个 checkout，通过正常 pre-commit 扫描提交；原工作区接收该已扫描提交时须保全无关工作树/暂存改动，再按官方 setup 刷新旧登记。新规则与 HEAD 一致、且该文件无暂存差异时，官方 tracked_update 条件才成立。此路径已做源码复核，但本轮没有执行提交，不把它称为已完成的登记更新。

## 当前未完成事项

代码布局与必要验收已完成，当前未提交，完成标记保持“否”。待用户后续要求提交时，按上述正常安全流程交付并记录实际实现 SHA、刷新原工作区登记；不为关闭本文自动提交或推送。旧绝对路径的外部源码 link 需重新安装，受管开发环境的显式 reset/reinit 步骤见上文；用户日常 DSH 与已有固定归档未修改。

## 追加调整：共享库归入 plugins/common（2026-11-26）

用户进一步要求移除根 packages，将两个共享库整体移到 plugins/common。同步 workspace（plugins/* 与 plugins/common/*）、构建顺序、构建输出哈希、L2 源码新鲜度及文档链接；common 明确保留为非插件容器，构建、CATALOG、安装不将其当作 bundle。包名与业务源码不变。源路径保护扩展到整个 plugins 和 archive-plugins，避免外部安装 home 落入共享源码目录。

前文 run-IkQVok 完整 CI 是追加调整之前的布局证据；本轮按影响补做冻结安装、类型、L1–L3、fast、L5 与打包内容比较，不把旧 CI 冒充追加调整后的完整 CI。现有安全配置登记限制未变，新 checkout 用正常安装流程验证。追加调整已完成，未自动提交或推送。

| 追加核对 | 结果与证据 |
|---|---|
| 输入不变 | 4 个共享库源码文件字节不变；lockfile 解析比较除 workspace importer/link 路径外完全一致，依赖版本未变。`.tmp/common-layout-input-comparison.json` |
| 冻结安装 | 新 checkout 对实际新规则执行冻结离线安装及官方 postinstall 通过，`.tmp/common-layout-fresh-install.log`。原工作区首次安装因既有安全登记不匹配失败，`.tmp/common-layout-install.log`；随后仅在安装期间恢复已登记旧规则，正常安装成功并精确恢复待提交规则，`.tmp/common-layout-registered-install.json`。原工作区新规则仍未登记，不冒称已刷新 |
| 类型和 L1–L3 | build --check 通过；332 项中 331 通过、1 项既有平台跳过。覆盖 common 排除、共享产物变化使构建记录失效。`.tmp/common-layout-types.log`、`.tmp/common-layout-tests-verified.log` |
| fast | 28 项通过，新增输入落入 plugins/common 或 archive-plugins 时拒绝安装的断言。`.tmp/environment-tests/run-HKDnAI/report.json` |
| L5 | 真实浏览器全部阶段与清理通过，`.tmp/l5/run-loIUV2/report.json`、`.tmp/common-layout-l5.log` |
| 打包比较 | 新 checkout pack 通过；notify-web 22 文件、role-agent 29 文件，包元数据及 4 个 JS token 序列完全一致。notify-web 仅 JS 路径注释与 sourcemap 改变，role-agent 全部文件字节一致。`.tmp/common-layout-package-comparison.json`、`.tmp/common-layout-pack.log` |

本追加轮未重跑 real/L4 或完整 CI；完整 CI 的原始证据仍按前文明确属于追加之前的目录布局。
