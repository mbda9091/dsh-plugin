# 内部开发测试与外部交付分离方案

> 状态：待验收（实现已提交，本机主要回归通过，完整 CI、Windows/Linux 与真实 DSH 沙箱待验）。完成：否。更新日期：2026-11-07（Asia/Shanghai）。完成日期：—。
> 本轮使命：拆分内部开发测试与外部交付的入口、输入和执行职责，取消共享本机配置的强制前置条件。
> 实现 commit：`fafaab2838b9d796f997d5d1e7d9e134aea45b5b`（入口、输入、测试与文档）；`a5210df82747f491cdfe583dd8a15a781e3d914e`（合并远端 Linux Web 支持并适配新入口）。
> 当前验收基线：`a5210df82747f491cdfe583dd8a15a781e3d914e`；合并复验在提交前相同代码树执行，随后仅回写文档。此前基于 `4fec7b318839b3ce38ce857fc0afa246b6da605e` 的执行记录保留，不能冒充合并版本的全量验收。
> 归档：未归档。关联：[现行配置协议](configuration-v2.md)、[现行安装指南](profile-install.md)、[旧方案历史](archive/local-configuration-design.md)。

## 1. 目标与边界

内部环境能够独立完成开发、构建、测试、打包和固定包验收；最终使用时，用户准备好当前 Node/DSH 环境并指定 profile，仓库读取该环境、校验兼容性后安装。不猜 profile，不自动修复或切换用户环境。

本文的“外部交付”指将插件安装到用户指定的 DSH profile；install 可以复用包，也可以按原有规则先构建打包。它区别于仓库内部开发环境的安装。该 profile 可以用于日常使用或试用，不表示生产发布，也不表示插件已经通过功能验收。

本轮调整入口与配置职责，复用已有工具链、受管开发环境、测试 harness、固定产物与安装实现。保留 TypeScript 业务实现和共享底层库，不重写插件。

不做：自动修复配置、HMR 接管、通用配置迁移框架、个人 YAML 模板升级、日常 DSH 启停、自动创建用户指定的 profile、远程机器部署。本轮不扩展已有平台支持。固定包功能验收归内部开发测试，外部安装沿用 install 的兼容性与完整性检查。

完成条件：第 5 节必要验收全部通过、实现提交与证据可核对，且开发测试不依赖用户指定的安装目标，安装保留现有缓存复用、必要时构建打包的行为。

## 2. 实施前能力与问题

| 当前事实 | 本轮处理 |
|---|---|
| 开发/测试已有独立 home、workspace DSH、环境清理和报告 | 复用，不重做隔离机制 |
| `bootstrap.mjs` 与 `cli.ts` 分发开发和安装到用户指定 profile 的命令 | 拆成开发测试和安装两个脚本入口，保留各自现有子命令名称；通用工具函数可复用；install 保留必要时构建、打包的行为，不自动执行完整功能验收 |
| `loadCommandContext` 强制读取完整 `local.json` | 开发测试与安装分别处理自己的参数，互不依赖对方的配置 |
| `config init` 从 example 生成 JSON，发现工具和浏览器 | 移除强制初始化要求；默认值显式定义，工具按需解析和检查 |
| `install` 可根据缓存决定构建、打包 | 保持原有行为：复用有效 tarball 或构建结果，必要时构建、打包，不在本轮修改缓存策略 |
| `stable-install` 当前也是外部安装命令，并非测试命令 | 外部安装命令只保留 install；固定包验收由内部 verify-artifacts 等流程负责，不保留第二套外部安装模式 |
| 命名目标与开发设置同存 JSON | 取消命名目标配置；install 必填 profile，其余安装环境按明确规则读取或显式覆盖 |

依据：[命令上下文](../scripts/src/core/command-context.ts)、[配置读取](../scripts/src/core/config.ts)、[CLI](../scripts/src/cli.ts)、[直接安装](../scripts/src/commands/profile-install.ts)、[目标校验](../scripts/src/core/formal-target.ts)。

2026-11-07 本机未发现 `scripts/config/local.json`；此前 CFG 测试在 fixture 中生成配置，不证明工作区已完成初始化。

## 3. 具体方案

### 3.1 拆成两个脚本入口，保留继续使用的子命令

原 `scripts/bootstrap.mjs` 已拆为两个面向用户的脚本入口，当前实现如下：

| 脚本入口 | 子命令 | 职责与写入范围 |
|---|---|---|
| `node scripts/dev.mjs <命令>` | build、test、ci、l4、l5、test-env、dev-web、dev-install、pack、verify-artifacts、元数据检查 | 开发与测试，包括内部 tarball 安装测试；插件与 DSH 数据仅写入仓库产物和受管开发/测试目录；包管理沿用系统缓存/store |
| `node scripts/install.mjs <命令>` | install、status | 安装到用户指定的外部 profile 或查看安装状态；install 保留缓存和必要时构建打包 |

不新增 repo-dev/repo-delivery 命令，也不新增 inspect；预览仍使用 `install --dry-run`。继续使用的 package scripts 名称保留，只修改其指向：build/test/ci 等指向 dev.mjs，install-plugins/status 指向 install.mjs。各脚本无子命令只显示自己的帮助。

两个入口各自加载独立的 TS 命令分发器，分别解析参数；开发入口不提供外部 install/status，安装入口不提供开发测试命令。内部验收可以在受管 fixture 中测试外部安装行为，但不得使用用户日常 profile。不保留可同时执行两类操作的总入口。

通用工具函数、编译命令工具自身 TypeScript 的逻辑可以共用；两个 mjs 文件仅负责启动，不承载业务。实施时同步调整“bootstrap 是唯一手写 JS”的仓库约定，避免新入口与旧规则冲突。install 可以调用共享构建/打包函数准备产物，但不得通过开发 CLI 转发，也不得把外部 DSH/home/profile 传给内部构建环境。

开发命令不接受外部安装目标参数。测试已有 `l4 --home` 继续只允许仓库 `.tmp` 内新目录，不作为外部 profile 输入，不因拆入口额外改名。

### 3.2 内部配置以仓库声明与默认值为主

- Node、pnpm、DSH 版本继续由仓库声明并校验。调用者准备工具与冻结依赖；缺失时报告准备方式，不自动下载、升级或回退宿主。
- 开发路径固定为受管 `.local/dsh-dev`，测试使用 `.tmp`；沿用目录归属、清理边界和进程管理。
- 默认值从原 example/init 的行为迁入内部设置解析器：开发 Web 默认 Edge、打开浏览器、启动超时 30000 ms；测试默认 Chrome、操作超时 120000 ms。保留现有枚举及参数覆盖，默认值不再依赖 JSON 文件。
- 浏览器发现仅在消费浏览器的命令执行：未指定路径时沿用现有发现函数；开发 Edge 不存在则使用系统默认浏览器，测试 Chrome 不存在则提示显式路径或选择 Chromium。显式无效路径报错，不静默回退；不开浏览器时不要求浏览器存在。Chromium 仍由调用者预先准备。
- pnpm 默认自动发现 PATH 上的 npm/Corepack 安装；可选 `--pnpm-script`、`DSH_PNPM` 按此优先级覆盖。Corepack 通过离线 `pnpm exec` 返回实际入口，所有来源必须匹配声明版本。不扫描私有 runtime，不自动下载或切换版本。只在需要 pnpm 的命令解析它。
- 测试浏览器仅在测试入口允许现有 `CHROME_PATH` / `DSH_E2E_BROWSER` 覆盖。日常 DSH 目的地变量继续清理，不影响内部上下文。
- 首版不新增开发 JSON；高频偏好可通过现有参数表达。以后若确认重复输入负担，再独立设计可选开发配置，不恢复共享配置中心。

`build` 不要求浏览器、用户指定的安装目标或本机 JSON。测试依赖真实浏览器的阶段才检查浏览器；未安装必需工具应明确失败，不能把“不依赖个人配置”误解为“不需要工具”。

### 3.3 安装保留现有产物准备行为

当前安装接口如下：

```sh
node scripts/install.mjs install --profile my-web --dry-run
node scripts/install.mjs install --profile my-web
# 现有 package script 继续可用
pnpm run install-plugins --profile my-web
```

用户先自行安装符合要求的 Node、pnpm、外部 DSH，冻结安装仓库依赖，并准备好目标 profile。只填 profile 指不需要其他目标参数，不表示免除工具和依赖准备。安装无需 `local.json` 或新的目标配置文件，也无需 `target bind`。

| 参数 | 读取规则 |
|---|---|
| `--profile` | 唯一必填的目标参数；不从 DSH_PROFILE 或当前会话补齐 |
| `--dsh-cli` | 可选覆盖；未传时解析当前 Node 环境中安装的外部 DSH，验证其来源和入口 |
| `--home` | 可选覆盖；未传时遵循选中 DSH 自身的 home 环境变量/默认规则，不从 CLI 安装目录猜测 |
| `--surface` | 移除，固定 Web；不新增 Desktop 支持 |
| `--platform` | 可选，默认当前操作系统；显式值与实际系统不符时报错，不作为跨平台安装开关 |
| `--only`、`--dry-run`、`--rebuild`、`--archive-root`、`--pnpm-script` | 保留现有用途与默认行为 |

环境解析已按锁定 DSH 实现核对：home 使用显式参数 > DSH_HOME > ~/.dsh。外部 DSH 从当前 Node 的 npm 包布局和配套 npm 的 global prefix 定位；不得因为从仓库启动而选中 workspace 开发 DSH，也不扫描私人 runtime 或静默切换其他安装。发现规则无法唯一确定时失败，并提示 `--dsh-cli`。Corepack 和 npm 前缀探测使用仓库临时文件捕获输出，不使用管道。

解析后展示 DSH CLI、home、profile、platform 及来源；检查版本、路径、平台和 profile 是否可用，再写入。内部开发测试继续忽略日常 DSH 目的地变量；只有安装/status 按上述规则消费外部环境。`DSH_PROFILE_DIR` 不覆盖由选定 home/profile 计算出的目录。

`status` 复用相同目标解析规则，不写入目标、不构建打包；仅做查看所需的检查，不强制执行 install 专属的版本门禁。保留现有 `status --manifest` 包内容核对能力；它不等于功能验收，也不要求浏览器。现有目标路径身份的写前复查继续保留，但不再维护跨次执行的命名目标绑定文件。

安装与验收分别处理：

- `install`：指定目标后，检查当前缓存；有效 tarball 直接复用，仅构建结果有效则打包，否则构建并打包。保留 `--only`、`--rebuild` 和 `--dry-run`，不新增必须提供 manifest 的要求。
- 内部 `pack` 负责构建打包、输出固定 tarball 清单；`verify-artifacts` 负责对指定固定包在一次性测试 profile 中安装和验证，并记录匹配证据。L4/L5 继续保留原有 tarball 与 Web 行为测试；pack 成功本身不算验收通过。
- 外部写入安装只提供 `install`，另保留只读 `status`；不保留 `stable-install` 安装模式，也不把它改名后搬进测试入口。内部测试复用所需的底层安装和校验能力，不调用外部目标入口。

两个脚本入口用于明确用户操作和目标边界，不禁止 install 复用底层构建、打包函数。内部开发测试仍独立完成，不依赖外部 profile。

不新增 `targets.local.json`，不保留 `--target` 和 target 书签管理；每次从参数与当前环境解析安装目标。

`install` 按现有缓存策略准备当前 tarball，检查包完整性、平台适用范围及目标 DSH 与仓库声明的精确版本匹配，保持现有本机 Web 范围。它不要求功能验收记录，也不自动执行完整验收，安装成功不能写成“功能已验收”。

内部固定包验收仍保留包哈希、测试结果和报告匹配检查。之后 install 若重新构建了不同字节的包，不得沿用先前包的通过记录。验收证据属于内部测试结果，不作为外部 install 的新增前置条件。

产物选择、源码快照、缓存有效性沿用现有 install 规则。本轮明确取消第二套外部严格安装模式，这是职责调整，不宣称 install 具备旧 stable-install 的验收保证。

保留 install 的缓存复用及自动构建打包路径。目标 profile 必须已存在；用户负责创建和启停。继续支持持久归档及 receipt，不删除仍被 profile 引用的包。

直接安装原有命名空间默认 patch 行为保留：默认值来自包，已有行保留，仅补缺行，写前备份；不改根 patch，不生成凭据或授权规则，用户自行加载。

### 3.4 校验按操作执行

| 保留的检查 | 目的 |
|---|---|
| 参数合法、必填字段完整 | 不忽略拼写错误，不猜缺失目标 |
| 工具/宿主版本、插件 platform/surface | 拒绝不支持的运行组合 |
| install 的包/清单完整性；内部验收的包/报告匹配 | 安装拒绝损坏包；内部验收不冒用其他包的结果，install 不新增验收证据前置 |
| 用户指定的安装目标与内部目录分离、链接真实位置 | 防止写入源码、开发或测试数据 |
| 写前目标身份和配置变化检查 | 避免检查之后目的地改变、覆盖并发编辑 |

兼容性和缺项必须在修改 profile 前失败。`install --dry-run` 不修改 profile，不构建；可使用受管临时目录探测宿主版本。安装中途发生 I/O 或宿主失败时，报告逐包实际结果与已产生的改动，不宣称“任何失败都零写入”，不自动卸载或回滚。

### 3.5 旧配置和命令收尾

- 保留表中继续使用的 build/test/ci/install 等子命令和 package scripts 名称，分别接入 dev.mjs/install.mjs；同步更新直接调用 bootstrap 的文档、CI 和测试。旧 bootstrap 停止业务分发，仅给出两个新入口的迁移说明，不自动转发。
- 不再自动读取旧 `local.json`、`legacy`、旧配置锁或 pending。旧文件与备份不自动删除；旧未完成事务仍由用户按原说明处理，不迁入新协议。
- pnpm/浏览器偏好改用参数或支持的环境值；旧目标信息由用户核对后用作显式覆盖，无需重新绑定或迁移到新文件。
- 移除 `stable-install`、target 管理、`config init/check/migrate` 的业务路径，对应旧 package scripts 不再执行原业务，仅保留迁移说明或移除后给出明确用法；旧命令不能静默转发或代为操作。固定包验收继续由内部命令完成。
- 同步 AGENTS.md、配置/安装指南、CI 和测试：保留继续使用的子命令名称，更新对应脚本路径，删除对 config init/target bind 的强制准备步骤；新实现前，现行指南仍描述实际可用行为。
- 回退实现不删除用户 profile、旧配置、备份或外部归档；不扩展旧配置维护系统。

## 4. 实施顺序

| 阶段 | 内容 | 出口条件 | 状态 / commit |
|---|---|---|---|
| M1 | 拆分 dev.mjs/install.mjs 及参数读取；去掉本机 JSON 前置；实现安装环境解析 | 无目标配置可开发测试，profile 必填且环境解析可核验；A1–A3 | 已提交（见文首），macOS 回归通过；Windows/Linux 未执行 |
| M2 | 调整现有 install/status，保留现有缓存策略、install 既有检查和写入保护 | 缓存复用/必要时构建打包行为不变，目标预检有效，真实交付可用；A4–A7 | 已提交（见文首），预检/缓存与此前 L4 通过；独立外部宿主套件受阻 |
| M3 | 更新 CI/文档/测试，移除多余命令和旧初始化机制 | macOS/Windows 必要检查通过，旧调用无自动转发；A8–A9 | 已提交（见文首）；完整 CI 与 Windows/Linux 待验 |

先复用已有能力完成边界拆分，再删除旧路径；不为拆分而重写工具链、harness 或插件。

## 5. 验收项

以下均为新方案的必要验收。结果列按本次 macOS 执行记录，Windows 全部未执行，不能据此关闭跨平台验收。使用独立 fixture 与一次性 profile，不修改用户日常环境。

| 编号 | 可观察结果 | 验证方式 | 当前结果 |
|---|---|---|---|
| A1 | 删除/损坏旧 local.json 或放入非法 target，不影响内部 build/ci；无用户指定的安装目标也可完成完整流程 | fixture 拒绝依赖检查 + 两平台真实内部 CI，保留 L4/L5 报告 | 部分通过：CFG-01、类型检查、L1–L5；完整 CI 受阻 |
| A2 | dev.mjs 拒绝外部 install/status，install.mjs 拒绝开发测试命令；各自拒绝不适用参数，外部 DSH 环境不影响内部开发测试 | CLI 测试，检查调用和目录变更 | 通过：CFG-02/04、L3 物理入口测试 |
| A3 | 只填 profile 可解析准备好的 Node/DSH 环境，无需 JSON；覆盖有效，缺 profile/宿主歧义/平台冲突报错；status 不写入、不构建 | 两平台 Node/DSH 布局与 home 规则测试，含 workspace .bin 干扰、多安装、显式覆盖和缺项 | macOS 通过：CFG-03/05、L3 status；Windows 未执行 |
| A4 | 缺目标、版本/平台不符或损坏包时 profile 字节不变；install 缺可复用产物时按原流程准备 | 预检故障测试及目标前后快照 | 通过：L3 profile-install、ART/TGT fast 预检 |
| A5 | install 的 reuse-tarball / reuse-build / rebuild、--rebuild 行为保持；dry-run 不构建或安装；不自动执行功能验收 | 缓存命中/失效和调用监测测试，复用现有缓存测试 | 通过：L1 缓存与 L3 install/pack/profile-install |
| A6 | 外部写入只提供 install，status 只读；旧 stable-install 不自动转发；内部固定包验收缺包或报告不完整不能通过，install 不要求或冒用验收记录 | 入口拒绝测试、固定包验收正反例和报告断言 | 通过：CFG-04、L3、ART fast 与已执行真实 ART 用例 |
| A7 | 两平台一次性 Web profile 可真实安装固定包，spec/包字节/配置保留正确；中途失败报告实际部分结果 | 复用真实目标套件；隔离安装和故障注入，不将安装成功冒充插件能力验收 | 受阻：TGT 独立宿主依赖安装超时；L4 tarball 通过不能代替本项 |
| A8 | 两平台 dev.mjs 完整 CI 通过，报告不缺失；外部目录不被清理 | 环境测试、L1–L5 与目录保留断言 | 未通过：环境套件受阻；单独 L1–L5 通过，Windows 未执行 |
| A9 | 继续使用的子命令/package scripts 保留名称并指向对应脚本；被移除项不再执行业务；CI 无 config init/target bind 前置；旧 bootstrap 不执行业务，被移除命令只输出说明，旧配置不删除或自动迁移 | 引用检查、CLI 回归与文件快照 | 通过：CFG-01/04/06、L3 入口、ISO-05 定向复验 |

## 6. 决策、风险与实施记录

以下按时间保留设计、实施与提交前的历史状态；当前提交和验收状态以文首及本节最后的提交记录为准。

2026-11-07 用户确认：内部开发测试独立，外部由用户明确提供目标；校验匹配即可，不预测或修复输入；授权本次编写方案并废弃旧文档，未授权代码实施。

本轮保留继续使用的子命令名称，拆成 dev.mjs 与 install.mjs 两个脚本入口并独立处理参数；不新增开发 JSON 或目标书签。安装必填 profile，默认读取已准备好的当前 Node/DSH 环境，可显式覆盖；install 缓存与构建打包行为保持，外部安装只保留 install。

主要风险是继续隐式读取共享配置，以及自动解析错选 workspace DSH 或错误 home。通过 A1–A5 验证来源、隔离和缓存规则。DSH home 的实际解析规则、不同 Node 安装布局是 M1 必须查明并测试的实现前置，当前不凭经验填写路径。

本次仅编写方案、标记旧方案废弃并更新相关导航/待办。文档检查：相对文件链接和 `git diff --check` 通过，已核对新方案 9 项验收均为未执行、旧方案剩余事项均不再实施；不执行功能测试，不复用旧 CFG 通过记录作为新方案验收。代码实施尚未开始，所有阶段完成均为否。

本轮设计已按用户澄清统一：拆两个脚本入口；安装只必填 profile，其余从当前环境解析或显式覆盖；无目标配置文件；install 保留缓存及必要时构建打包；固定包验收归内部，取消 stable-install 外部模式。没有代码实施。

2026-11-07 全文复核修正：消除“外部必须已有包”、命令保留范围不清、pack 与验收混写等歧义；补齐去掉 init 后的默认值/浏览器发现位置、工具准备条件、status 只读边界及验收项。DSH 定位与 home 解析的具体算法仍列为 M1 查证项，不将尚未核实的规则写成已实现事实。

### 2026-11-07 实施记录（用户随后授权“实现这个方案”）

以上“未实施”段落为设计阶段历史。当前已拆分 dev.mjs/install.mjs，共享 launch.mjs 编译和底层构建/安装代码；旧 bootstrap 仅提示迁移。运行输入改为内存默认值与参数/环境覆盖，旧 local.json、锁、pending 均不读取或删除。安装保留原缓存策略，构建打包时创建独立工具上下文；去掉命名目标/旧配置快照依赖，保留实际目标身份与 profile 并发修改检查。旧迁移源码和 schema 仅供历史测试与人工恢复参考。

已核对安装版本 DSH 的 `dsh-home-paths` 实现：显式 home > DSH_HOME > ~/.dsh，支持波浪号与 cwd 相对路径。DSH 从当前 Node 的 npm 包布局发现，配套 npm 存在时读取其 global prefix，覆盖 Windows AppData 布局；候选歧义或 workspace 别名拒绝。CFG-05 用独立 Node/npm fixture 验证前缀，不读取用户日常 profile。

本机验证环境：macOS arm64、Node 24.16.0、pnpm 11.28.5、DSH 0.2.2-rc.1。pnpm 显式使用本机已安装的包脚本；代码没有增加私有缓存扫描。执行结果：

- `build --check` 通过；L1–L3 共 227 项，226 通过、1 项平台相关跳过、0 失败。
- 环境 fast 28 项通过：`.tmp/environment-tests/run-G7xBYh/report.json`。
- ISO-05 旧测试仍通过修改 local.json 制造工具错误，已改为实际环境输入并单独复验通过：`.tmp/environment-tests/run-FdFsQa/report.json`。
- L4 通过，包含 link、场景不匹配、tarball 与清理：`.tmp/l4/run-ujZI51/report.json`。
- L5 使用系统 Chrome 通过：`.tmp/l5/run-8WyjJx/report.json`。之前 Chromium 缺失及一次构建期间文档变化导致的失败分别保留在 run-6kBn2p、run-QLW1jR，不算通过；未安装额外浏览器。
- 回归后只清理了旧入口的报错文字与文档表述，再次类型检查、帮助入口和文档相对链接检查通过；未更改执行逻辑。
- 完整 CI 本轮未通过，已结束并保存 `.tmp/ci/run-paLDY2/report.json` 和 `.tmp/environment-tests/run-eYGFIh/report.json`。首次执行真实 ART、开发/隔离用例已有通过结果；TGT-04、TGT-05-real、TGT-06-real 的独立宿主安装以及 TOOL-04 的干净冻结安装均达到 300 秒超时。日志存在低速下载告警，但超时根因尚未确认，完整日志 `/private/tmp/dsh-ci.log`。该首次报告还包含后来已修正并单独复验的 ISO-05 失败；原报告不改写为通过。不得把单独 L1–L5 或固定包验收结果冒充完整 CI。

遗留：排查独立宿主/干净冻结安装环境并重跑完整 CI；在 Windows 执行必要检查；提交后核对实现 commit 与验收基线。当前实现未提交，不自动 commit/push，不标记整体完成。

2026-11-07 浏览器准备补验：按用户要求执行 `node node_modules/playwright-core/cli.js install chromium`，安装匹配 Playwright 1.64.1 的 Chromium 1248、Headless Shell 1248 与 FFmpeg 1013。随后 `l5 --test-browser chromium` 通过，报告 `.tmp/l5/run-Ms9oAV/report.json`；本机缺少 Chromium 的问题已解决。未修改默认浏览器或用户 shell 配置，未据此关闭完整 CI/Windows 待验项。

2026-11-07 pnpm 自动发现优化（用户明确授权）：不再要求 Corepack 用户手传绝对路径。识别 PATH 上的 Corepack pnpm JS 入口，用当前 Node 在仓库 cwd 执行离线 `pnpm exec` 读取 npm_execpath，转换为同包 pnpm.cjs 后继续校验包身份与精确版本；不扫描缓存、不自动下载、不自动修改 packageManager。显式参数/环境覆盖保留为可选项。real 环境测试入口与 CI 同步取消路径前置。

验证：TOOL-02 覆盖 Corepack 返回入口、cwd/当前 Node、禁止下载、非法入口和版本不匹配，报告 `.tmp/environment-tests/run-Q7rPKt/report.json`。本机未传 `--pnpm-script` 运行 `l5 --test-browser chromium` 通过（`.tmp/l5/run-3SjPul/report.json`），`test-env --suite real --only ISO-05` 通过（`.tmp/environment-tests/run-BH1UCh/report.json`），`test` 226 通过、1 项平台跳过、0 失败。回归发现前次报错文案调整遗漏的断言，已同步修正并复跑通过。实现仍未提交；本次没有重跑完整 CI，Windows 仍未执行。

2026-11-07 Review 修复：Corepack 路径发现与 npm global prefix 探测原先使用 execFileSync 管道，违反 DSH 沙箱 stdio 约定。两处改用基于 runToFiles 的临时文件捕获，在仓库 `.tmp/tool-probes` 创建独立目录，并在成功、非零退出、超时及启动异常后清理；保留原版本校验、离线限制与超时。

验证：CFG-05/TOOL-02 使用拒绝管道、检查普通文件描述符的测试替身运行真实 fixture 子进程，两处发现及失败清理通过（`.tmp/environment-tests/run-5APjrE/report.json`）。新增 L1 覆盖输出捕获和各类退出路径清理。`test` 227 通过、1 项平台跳过、0 失败，`build --check` 与 `git diff --check` 通过。此结果验证了模拟的 DSH stdio 限制，未宣称已在真实 DSH 沙箱重新验收；Windows/完整 CI 待验状态不变，实现未提交。

2026-11-07 提交前文档对齐与远端合并：用户授权检查后提交并 push。修正正文“尚未实现”、real 测试必填路径示例和 README 历史 CI 表述，补齐文件捕获说明。拉取远端发现 `6010087` / `d217388` 已新增 Linux Web 与 WSL 工作区配置，因此合并保留这些变更，安装入口改用共用平台解析，Linux 文档同步为新命令，不恢复已废弃配置系统。

实现提交与合并提交见文首。合并后的 macOS 验证：`build --check` 通过，fast 28 项通过（`.tmp/environment-tests/run-0YTObh/report.json`），L1–L3 230 通过、1 项平台跳过、0 失败，Chromium L5 通过（`.tmp/l5/run-SEIiW5/report.json`）；相对链接、冲突标记及 diff 检查通过。提交后仅回写文档，代码树与此次复验一致。完整 CI 未重新执行，Windows/Linux 和真实 DSH 沙箱未执行；继续保持待验收，不将提交或推送当作验收完成。
