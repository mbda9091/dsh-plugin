# 本机配置初始化与读取方案

> 状态：第一、二阶段已实现；第三阶段未实施。更新日期：2026-10-30（Asia/Shanghai）。
> Web、构建、打包、安装、状态和测试已统一读取本机 JSON；L4/L5 不读取个人 Web patch。验收范围见下文。

采用“版本化模板 → 本机初始化 → 读取本机配置”的流程，把个人路径和机器差异从公共源码中分离。仓库提交 example 模板；初始化程序根据本机环境生成被 Git 忽略的配置；日常命令读取这些本机文件。

模板只用于初始化和显式升级，不在每次运行时与本机配置合并。更新模板不会静默改变已有的个人设置。

## 1. 问题与目标

实施前，Web patch 包含固定的仓库绝对路径和个人审批命令示例。工具定位逻辑分散在 PowerShell 与 TypeScript 中，部分查找顺序不一致。单纯将路径换成环境变量，仍缺少首次配置、重复初始化、校验和升级的统一流程。

本方案需要满足：

- 新机器可以通过初始化命令得到可检查、可编辑的本机配置。
- 公共文件包含格式、通用初始值和占位符，不包含具体机器的用户名、安装路径或个人授权规则。
- 配置的读取位置、优先级、错误行为明确，所有接入的仓库命令复用同一套逻辑。
- 初始化生成的文件直接用于运行，不需要每次启动再生成 patch。
- 插件包保持自包含，单独安装后不依赖仓库配置。

本方案不改 Git 历史，不读取 DSH 凭据或会话数据，不自动修改用户已有的 DSH profile，也不重新实现 DSH 的配置合成机制。

## 2. 文件归属

配置相关目录结构：

```text
scripts/
├── config/
│   ├── example.json              # 脚本配置模板，入库
│   ├── schema.json               # 格式定义与编辑器提示，入库
│   └── local.json                # 初始化生成，本机编辑，不入库
├── config.ps1                    # 初始化、检查的 PowerShell 入口
└── src/
    ├── commands/config.ts        # 初始化与检查命令
    ├── commands/web.ts           # Web 启动逻辑
    └── core/config.ts            # 统一配置读取与校验

profiles/web/
├── cordis.patch.example.yml      # Web patch 模板，入库
├── cordis.local.patch.yml        # 初始化生成，本机编辑，不入库
└── start.ps1                     # 兼容的 PowerShell 薄壳
```

| 内容 | 归属 | 读取方 |
|---|---|---|
| DSH CLI、pnpm、浏览器位置，启动和测试参数 | `scripts/config/local.json` | 仓库脚本 |
| HMR 监听路径、Web 通知参数、个人插件覆盖项 | `profiles/web/cordis.local.patch.yml` | DSH |
| 插件支持哪些配置字段及默认行为 | 各插件的 `Config` 与默认值 | 插件 Host |
| 插件安装、启用记录 | 实际 DSH profile，由插件管理器维护 | DSH |

脚本配置不再复制插件参数；Web patch 不负责寻找 Node、pnpm 或浏览器。桌面插件继续使用实际 desktop profile 的配置，本方案不会引入第二套桌面配置来源。

原 `profiles/web/cordis.patch.yml` 已迁为无个人信息的 example；启动入口和 Web README 已同步切换到本机 patch。插件包内同名的 `cordis.patch.yml` 继续作为 bundle patch 使用，不参与此次文件改名。

## 3. 脚本配置模板

第一阶段使用以下字段；模板另外提供可选的 `"$schema": "./schema.json"` 以关联编辑器提示：

```json
{
  "version": 1,
  "tools": {
    "dshCli": null,
    "pnpmScript": null
  },
  "web": {
    "browser": "edge",
    "browserPath": null,
    "openBrowser": true,
    "startupTimeoutMs": 30000
  },
  "test": {
    "browser": "chrome",
    "browserPath": null,
    "timeoutMs": 120000
  }
}
```

- `version` 是脚本配置格式版本，用于检查与后续迁移。
- 模板中的工具路径为 `null`，初始化时根据环境填写；模板不记录机器安装路径。
- `pnpmScript` 明确表示 `pnpm.cjs` 路径，与现有 `DSH_PNPM` 的语义对齐，不混用可执行文件路径和脚本路径。
- `web.browser` 支持 `edge`、`default`；`test.browser` 支持 `chrome`、`chromium`。是否扩展其他浏览器留待字段清单确认。
- `browserPath` 用于指定浏览器可执行文件；系统默认浏览器或由 Playwright 管理的 Chromium 可以不填写，具体约束由 schema 和命令校验明确。
- 超时必须是正整数，单位为毫秒；布尔值必须是 JSON 布尔值，不能用字符串代替。
- 本机文件由初始化程序生成完整结构，用户随后直接编辑它。运行时不会再从 example 补齐缺失字段。

schema 为脚本配置提供结构校验和编辑器提示，不给所有插件另建一套配置类型。原有插件 `Config` 的约定保持不变。

## 4. 初始化流程

已实现命令：

```powershell
# 预览环境发现结果和待生成配置
pwsh -File scripts/config.ps1 init --dry-run

# 生成本机配置
pwsh -File scripts/config.ps1 init

# 检查配置和所需工具
pwsh -File scripts/config.ps1 check
```

初始化顺序：

1. 从脚本位置确定仓库根目录，不使用终端当前目录作为定位依据。
2. 读取两份 example，检查模板格式和版本。
3. 根据显式参数、已有环境变量、PATH 和已知安装位置发现工具。
4. 将发现的机器路径填入脚本配置，保留模板中的通用参数。
5. 解析 Web 模板允许的路径占位符，生成本机 patch。
6. 校验两份候选结果；预览模式只显示计划，实际模式才写入目标文件。

环境发现应报告选中来源，例如显式参数、环境变量、PATH 或已知安装位置。Web 优先普通 Node 版 DSH；只发现 Electron 版或发现无法判定的候选时，明确显示问题，不静默把不兼容的工具作为成功结果。

找不到当前初始化目标必需的工具时，提示如何显式指定。可选工具缺失可以保留允许的空值并报告；运行对应命令前仍需完成校验。显式指定但无效的路径必须报错，不能悄悄退回自动发现。

Web 模板只允许预先定义的占位符，例如 `${repoRoot}`。替换范围限定在声明为路径的字段，输出按 YAML 字符串规则编码，确保空格、反斜杠和引号不会破坏配置。初始化不执行任意模板表达式，也不展开任意环境变量字符串。

### 4.1 重复初始化与失败处理

- 两份本机文件都不存在时，生成完整配置。
- 已有本机文件保持原样，重复 `init` 不覆盖用户设置。
- 只有一份文件存在时，报告不完整状态，不擅自重建或覆盖另一份；第一阶段由用户检查、备份后处理。
- 写入前先完成两份候选配置的校验；若写入中途失败，明确报告实际写入情况，不声称初始化成功。
- `--dry-run` 不写本机配置，不更改实际 profile，不启动服务或安装插件。
- 初始化不导入用户的凭据、会话或既有审批规则。个人审批规则由用户之后明确填写。

初始化命令自身不依赖 `local.json`，否则无法完成首次初始化。

## 5. 运行时如何读取

```text
命令入口
  → 定位仓库并读取 local.json
  → 检查格式与版本
  → 应用已支持的环境变量和显式命令行覆盖
  → 解析路径并校验当前命令必需的字段
  → 返回内存中的配置对象
  → 执行命令
```

优先级固定为：

```text
显式命令行参数 > 已支持的环境变量 > 本机配置
```

约定如下：

- 文件读取使用 Node 的文件接口和 `JSON.parse`，业务入口统一调用 `scripts/src/core/config.ts`。
- 缺少本机文件时提示运行 `init`；文件损坏、版本不支持、未知字段或类型错误时报告文件与字段。
- example 不参与运行时合并，也不作为配置错误后的回退来源。
- 环境变量仅支持明确列出的映射，例如 `DSH_CLI`、`DSH_PNPM`、`CHROME_PATH`、`DSH_E2E_BROWSER`；不引入任意键名映射。
- 临时覆盖只影响本次执行，不写回本机文件。
- 相对配置路径统一相对于仓库根目录；绝对路径原样使用。空字符串、`null` 和缺失字段的含义按字段定义，不混同处理。
- 配置读取发生在命令执行时，不在模块 import 时进行；修改配置在下次执行命令时生效。
- 构建等命令不应因为未使用的浏览器缺失而失败；所需工具可用性按命令检查。
- 已有 `DSH_HOME`、`DSH_PROFILE`、`DSH_PROFILE_DIR` 的职责保留，特别是不能把当前会话的 profile 目录误用于另一个目标 profile。

`check` 显示字段来源和可操作的错误信息，不整份输出个人 patch 或含认证信息的 URL。运行时的诊断不自动修复、覆盖用户配置。

### 5.1 Node 启动与 PowerShell 入口

必须先找到 Node，才能执行 TypeScript 配置读取器。Node 定位继续使用 `DSH_NODE` 和现有自动发现逻辑；不在 `local.json` 增加一个需要 Node 才能读取的 Node 路径字段。

PowerShell 入口逐步收敛为“找 Node → 转发参数 → 调用 TypeScript 命令”。现有 `bootstrap.mjs` 仍只负责编译与加载，不承载配置业务，不增加 `tsx` 或 `ts-node`。

Web、打包和安装业务分别位于 `scripts/src/commands/web.ts`、`pack.ts` 和 `install.ts`。PowerShell 只找 Node 并转发参数，不再定位 DSH/pnpm 或解析插件。初始化依赖现有脚本编译工具链，必须先安装 workspace 开发依赖。

## 6. Web patch 与插件配置

初始化完成后，启动器直接加载已存在的本机 patch：

```text
dsh web --patch <仓库>/profiles/web/cordis.local.patch.yml --no-open
```

HMR 的绝对路径在初始化时生成并保存在本机 patch 中。保留现有明确列举插件 `lib/` 的监听范围和 Windows 排除规则，不因配置迁移扩大到整个仓库或用户目录。

DSH 继续按自身顺序合成：

```text
bundle → profile → home → 本机 --patch
```

同一行的 `config` 整体替换，不深合并。仓库不实现另一套插件配置合并规则，也不让 JSON 配置重复持有通知和审批参数。插件仍使用自己导出的 `Config` 和默认值。

通知配置所引用的插件需要由插件管理器安装。`init` 和启动器都不隐式安装插件；默认模板包含通知配置，使用前需安装 `@local/notify-web`，或在本地 patch 中移除该行。

本机制不使用 `.tmp/web` 保存运行时生成的 patch，也不需要内部 HMR 环境变量。已有 L4/L5 在 `.tmp` 中保存一次性 profile 和测试产物的用途不受影响。

## 7. 本机文件与仓库发布

已先添加精确的忽略规则，再生成机器文件：

```gitignore
/scripts/config/local.json
/profiles/web/cordis.local.patch.yml
```

本地备份和凭据的忽略规则同时补齐；example 与 schema 必须可正常跟踪。忽略规则不会自动取消已跟踪文件，迁移时需要检查 Git 跟踪清单。

本机配置位于插件目录之外，不能加入插件的 `files` 或打包内容。公共文档只保留占位符和可移植命令，不展示初始化后真实的工具位置或用户审批策略。

环境变量和值的管理不通过自动加载 `.env` 扩展；第一阶段不增加秘密管理系统。DSH 认证继续使用已有机制。

## 8. 换机器、移动仓库与升级

| 场景 | 行为 |
|---|---|
| 新机器 clone | 执行 `init`，生成该机器自己的配置 |
| 重复执行初始化 | 保留已有文件并报告状态 |
| 修改个人偏好 | 直接编辑本机文件，下次执行生效 |
| 仓库移动、工具升级 | `check` 提示失效或与当前仓库不一致的路径，用户先备份再调整 |
| example 内容更新 | 不自动改变已有本机文件 |
| 配置格式升级 | 按 `version` 进行显式迁移，不通过静默模板合并补齐 |

后续可以提供 `repair --dry-run` / `repair`，只修复工具位置和 HMR 路径，并在写入前备份。用户手动定制的监听路径可能与自动生成路径相似，因此必须先定义字段归属和修复预览，不能仅凭路径不匹配就覆盖。

第一阶段不实现自动修复或跨版本自动迁移；不支持的版本明确报错。YAML 模板版本及其迁移记录的具体方式留待升级阶段设计。

## 9. 分阶段实施

### 第一阶段：初始化与 Web 接入

- [x] 确认脚本字段、空值语义、浏览器枚举及工具发现规则。
- [x] 添加两份 example、脚本 schema 和本机文件忽略规则。
- [x] 实现 `init --dry-run`、`init`、`check`。
- [x] 实现统一配置读取器，不在运行时合并模板。
- [x] Web 启动改为读取本机 JSON 和本机 patch，保留原 PowerShell 入口。
- [x] 将当前机器需要保留的设置迁到本机文件；移除公共文件中的个人路径和授权规则。
- [x] 同步更新 Web README，明确初始化与插件安装前置条件。

### 第二阶段：构建、安装和测试入口统一

- [x] 接入构建、状态、打包、开发安装和稳定安装命令。
- [x] 收敛工具定位逻辑，消除 PowerShell 与 TypeScript 的优先级差异。
- [x] 将需要的 PowerShell 业务逻辑迁入 TypeScript，保留兼容入口。
- [x] 接入测试配置，明确已有环境变量到配置字段的映射。
- [x] CI 在运行时准备机器配置，不提交生成文件。

L4/L5 只使用工具位置和允许的测试参数，继续强制使用一次性 home、profile 与测试 patch，不能加载日常 Web patch 或个人审批规则。测试中的初始化必须在独立 fixture 中执行，不改用户实际本机配置。

### 第三阶段：修复与格式升级

- [ ] 设计修复字段归属、预览和备份规则。
- [ ] 提供仓库搬迁和工具升级后的显式修复。
- [ ] 实现按版本迁移，以及 Web 模板升级的记录机制。

## 10. 验收标准

| 场景 | 预期 |
|---|---|
| 没有本机文件 | `init` 生成配置，已接入的业务命令提示先初始化 |
| 初始化预览 | 展示探测结果与计划，不写目标文件或修改 profile |
| 重复初始化 | 已有文件字节不变，个人设置保留 |
| 配置损坏、字段错误或版本不支持 | 明确报错，不回退到模板 |
| 显式工具路径无效 | 报错，不静默选择其他安装 |
| 参数、环境变量、本机值同时存在 | 按约定优先级生效，不写回文件 |
| 从其他工作目录启动 | 仍定位同一份仓库配置 |
| 路径含空格、引号或中文 | JSON/YAML 正确编码，子进程得到正确参数 |
| 仓库移动后 HMR 仍指向旧位置 | `check` 指出差异，不自动扩大监听范围 |
| 更新 example | 已有本机配置与运行设置不变 |
| 查看 Git 与插件 tarball | 不包含本机配置、备份或凭据 |
| 运行 L4/L5 | 不加载个人 patch，不修改用户已有 profile |

涉及运行行为的实现阶段需通过类型检查和对应 L1–L3；Web 启动、加载与配置变化再跑真实 L4/L5，并单独验证 Web 启动器读取生成配置后的实际加载结果。

### 第一阶段验收记录（Windows）

- 类型检查、场景声明与 CATALOG 检查通过。
- L1–L3 共 238 项测试通过，覆盖初始化不覆盖、预览不写文件、配置校验与覆盖优先级、中文/空格/引号路径、YAML 惰性表达式、仓库搬迁提示和启动失败清理。
- 真实 L4 通过 link、tarball 安装及场景不匹配检查；L5 的 baseline 和 fixture 均通过。
- 另以一次性 DSH home/profile 从其他工作目录调用真实 `start.ps1`，确认本机 patch 中的通知配置加载、认证 HTTP 与 SSE 可用，Host 停止后启动器退出，本机两份配置的内容哈希不变。
- 本机 `config check` 通过；生成文件与备份已被 Git 忽略，模板和 schema 未被忽略。旧 `.tmp/web/cordis.patch.yml` 确认无 Host 使用后，已移为 `profiles/web/cordis.legacy-tmp.patch.bak`，空目录已移除。
- 提交前逐个复核仓库内 11 个 `.ps1`：未发现硬编码凭据、个人邮箱或本机绝对路径。`common.ps1` 中的 `.dsh` 和桌面安装目录后缀是工具发现约定，路径前缀来自环境变量或用户目录；它们尚未统一接入本机 JSON，留待第二阶段。脚本执行时可能打印实际路径，运行日志继续保持本地且不入库。
- 当时 macOS 未做真实环境验收，第二、三阶段待实施；第二阶段的更新见 §12。

## 11. 第一阶段实施选择与限制

- 脚本配置使用仓库内的 `schema.json` 校验。运行时校验器只支持本 schema 使用的关键字，遇到未实现的 schema 规则会报错，避免忽略校验约束。可选 `$schema` 只供编辑器识别，不改变读取器加载的 schema。
- 工具路径覆盖参数确定为 `--dsh-cli`、`--pnpm-script`；浏览器参数为 `--browser`、`--browser-path`、`--test-browser`、`--test-browser-path`。
- 初始化会读已有 DSH/npm shim 以识别普通 Node 引擎，不运行 CLI、不创建 profile。PATH 中选取第一个可识别的普通 Node CLI；Electron 或不透明 wrapper 不作为 Web 的成功候选。
- 可选 pnpm/Chrome 缺失时保留允许的空值并提示；Edge 缺失时在生成的本机配置中明确选择 `default`。显式指定的路径无效直接失败。
- Web example 保留原有四个 HMR 目录和八个通知参数。默认要求先安装 `@local/notify-web`；不使用时可删除本地 patch 的通知行。
- YAML 使用脚本层开发依赖 `yaml` 的文档树处理：只在 `hmr.config.root` 中展开 `${repoRoot}`，保留注释和原有排除规则；其他字段的占位符被拒绝。`!!js` 在初始化与检查中保持惰性，不会执行。
- 本机 patch 带生成时的仓库位置注释，用于搬迁提示。检查不会据此自动修复，也不限制用户自行编辑监听范围。
- `check` 对警告返回 1，例如 HMR 路径缺失或动态路径无法静态验证；无警告返回 0。它不确认实际插件安装和激活成功。
- Web 的启动覆盖参数为 `--open` / `--no-open`、`--dsh-cli`、`--browser`、`--browser-path`、`--startup-timeout`；其他参数传给 DSH。修改配置后需重启自己的 Web 服务。
- 运行时仅借用操作系统临时文件捕获进程输出，退出时清理，不生成配置或创建 `.tmp/web`。启动地址可能包含认证 token，勿复制到公共日志。
- 第一阶段已迁移本机配置并保留被忽略的旧 patch 备份；未读取或修改日常 profile 的配置和凭据，未自动重启现有服务。源码文档中的个人路径和实际审批策略已脱敏。
- 以上是第一阶段记录。第二阶段已接入 `test` 字段，保留兼容环境变量，详见 §12。macOS 的真实启动和浏览器交互仍需对应平台验收。

## 12. 第二阶段实现与使用

已有 `version: 1` 文件继续有效，无需重新初始化。`core/command-context.ts` 在命令入口解析一次配置，向嵌套构建、打包和测试传递同一份结果；`core/pnpm.ts` 为 DSH 子进程提供临时 pnpm shim。运行时不再探测另一套 DSH/pnpm，只有 `init` 做发现。CLI 的帮助、`catalog` 与 `check-targets` 不要求本机文件。

| 字段 | 环境覆盖 | 命令行覆盖 | 使用范围 |
|---|---|---|---|
| `tools.dshCli` | `DSH_CLI` | `--dsh-cli` | Web、安装、L4/L5；Web 必须是普通 Node 版 |
| `tools.pnpmScript` | `DSH_PNPM` | `--pnpm-script` | 打包、安装、L2 包契约、L4/L5 |
| `test.browser` | `DSH_E2E_BROWSER` | `--test-browser` | L5；`chrome` 或 `chromium` |
| `test.browserPath` | `CHROME_PATH` | `--test-browser-path` | L5 的 Chrome；Chromium 由 Playwright 定位 |
| `test.timeoutMs` | 无 | `--timeout` | L4/L5 每次外部操作及浏览器场景的截止时间 |

测试参数可传给 `l4`、`l5`、`ci`；初始化使用 `--test-timeout` 写入初始超时。L1–L3 不受浏览器配置影响。`build` / `status` 只校验配置结构，不要求无关的 DSH、pnpm 或浏览器路径存在；需要这些工具的命令才检查其可用性，显式无效值不回退。`config check` 仍负责检查整份配置。

L5 中基线和 fixture 各自拥有 `test.timeoutMs` 的浏览器总截止时间，父进程另留 30 秒退出宽限；单个交互断言仍保留较短超时。服务终止和端口关闭使用独立、有限的清理时间。`--timeout` 不是整个 CI 的总时长。

```powershell
# 现有 PowerShell 参数继续可用；工具参数也直接传给 TypeScript
pwsh -File scripts/pack.ps1 -SkipBuild -PnpmScript '<pnpm.cjs绝对路径>'
pwsh -File scripts/dev-install.ps1 -Profile web -Surface web -DryRun
pwsh -File scripts/ci.ps1 -TestBrowser chromium -TimeoutMs 180000

# Node 入口提供相同能力
node scripts/bootstrap.mjs stable-install --profile web --surface web --dry-run
node scripts/bootstrap.mjs l5 --test-browser chromium --timeout 180000
```

安装先完成目标过滤和全部 tarball 存在性检查，再逐个执行 `dsh plugin add` 和 `pnpm update`；任何一步失败都会停止并返回原退出码，不执行 `remove`。`--dry-run` 不构建、不生成 shim、不修改 profile。开发安装默认先构建，`--skip-build` 仍要求已有构建入口。打包检查所有插件构建入口后，才向 `dist/` 写入。

`DSH_PROFILE_DIR` 仅用于当前会话对应的 profile，切换目标时重新从 home 计算路径。L4/L5 会清除继承的 profile 目录和 Web 地址，强制使用 `.tmp` 内一次性 home 及 pnpm store；不会读取个人 YAML。大小写不同的 Windows 环境变量会在子进程中规范化，避免 `Path` / `PATH` 冲突。

CI 的顺序为：安装工具链 → 安装 workspace 依赖 → `config init --browser default --test-browser chromium` → 安装 Playwright Chromium → `ci`。生成配置与测试现场留在 runner，不提交或上传。远端实际验收仍需推送后查看 Actions 结果。

### 第二阶段验收记录（Windows，2026-10-30）

- 类型检查、元数据与 CATALOG 检查通过；L1–L3 共 249 项通过。新增覆盖工具与测试参数优先级、Windows 环境大小写、测试隔离、安装预检和失败停止，以及 PowerShell 参数与退出码转发。
- 真实 L4 的前置检查与七个阶段全部通过；L5 的独立基线、slot/主题/语言交互及三项通知场景通过。
- 通过新 `pack` / `dev-install` / `stable-install` 实现，在同一个一次性 Web profile 中完成 link → tarball → link；断言依赖 spec、实际 junction/拷贝状态及 `status` 输出一致。两个仅桌面插件被跳过。
- 该切换前后本机 JSON 与 Web patch 字节不变，临时 home/store 已清理。测试报告保留在忽略的 `.tmp/` 中，没有修改日常 profile。
- CI workflow 已加入 runner 内初始化，但本次未推送或确认远端 Actions 通过。macOS 真机验收、第三阶段 repair/版本迁移仍未完成。

## 13. 相关文件

- [仓库工作约定](../AGENTS.md)
- [DSH 概念与配置层序](dsh-concepts.md)
- [当前 Web 启动与配置说明](../profiles/web/README.md)
- [测试与 Web L5 方案](testing-plan.md)
