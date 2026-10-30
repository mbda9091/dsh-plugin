# 本机配置初始化与读取方案

> 状态：第一、二阶段已实现，Windows/macOS 远端 CI 已通过（§12）；第三阶段具体设计已完成（§14），命令与测试尚未实现。更新日期：2026-10-30（Asia/Shanghai）。
> Web、构建、打包、安装、状态和测试已统一读取本机 JSON；L4/L5 不读取个人 Web patch。验收范围见下文。
> 入口已统一为 Node 启动的 TypeScript CLI；PowerShell 兼容脚本已移除（§5.1、§14.10）。本轮只完成 P0 脚本收尾，第三阶段维护命令仍未实现。
> 实施优先级已调整：先完成 TS 脚本，再按[开发环境规划](development-environment-plan.md)建设环境统一与隔离。§14 的维护机制设计保留，字段与迁移需适配后续开发/正式目标分离的配置结构。

采用“版本化模板 → 本机初始化 → 读取本机配置”的流程，把个人路径和机器差异从公共源码中分离。仓库提交 example 模板；初始化程序根据本机环境生成被 Git 忽略的配置；日常命令读取这些本机文件。

模板只用于初始化和显式升级，不在每次运行时与本机配置合并。更新模板不会静默改变已有的个人设置。

## 1. 问题与目标

实施前，Web patch 包含固定的仓库绝对路径和个人审批命令示例。工具定位逻辑分散在 PowerShell 与 TypeScript 中，部分查找顺序不一致。单纯将路径换成环境变量，仍缺少首次配置、重复初始化、校验和升级的统一流程。

本方案需要满足：

- 新机器可以通过初始化命令得到可检查、可编辑的本机配置。
- 公共文件包含格式、通用初始值和占位符，不包含具体机器的用户名、安装路径或个人授权规则。
- 配置的读取位置、优先级、错误行为明确，所有接入的仓库命令复用同一套逻辑。
- 命令、业务逻辑和测试统一基于 TypeScript；文档以 Node CLI 为主入口，不再保留 PowerShell 兼容层。
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
├── bootstrap.mjs                 # Node 启动入口，仅编译并加载 TS CLI
└── src/
    ├── cli.ts                   # 唯一命令分发与参数解析入口
    ├── commands/config.ts        # 初始化与检查命令
    ├── commands/web.ts           # Web 启动逻辑
    └── core/config.ts            # 统一配置读取与校验

profiles/web/
├── cordis.patch.example.yml      # Web patch 模板，入库
└── cordis.local.patch.yml        # 初始化生成，本机编辑，不入库；通过 Node CLI web 加载
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

已实现命令（先准备 Node 和 workspace 依赖，见 §5.1）：

```sh
# 预览环境发现结果和待生成配置
node scripts/bootstrap.mjs config init --dry-run

# 生成本机配置
node scripts/bootstrap.mjs config init

# 检查配置和所需工具
node scripts/bootstrap.mjs config check
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

### 5.1 TypeScript 主入口与 PowerShell 退场

统一主入口为 `node scripts/bootstrap.mjs <command> [options]`。命令分发、参数解析、配置读取及全部业务实现在 `scripts/src/`；`bootstrap.mjs` 继续作为唯一手写 JS，只负责通过 `tsc` 编译并加载 TS CLI，不承载业务，不增加 `tsx` / `ts-node`，也不改用 Node 类型擦除。

调用链固定为：

```text
Node → bootstrap.mjs → tsc → scripts/.build/cli.js（来源：scripts/src/cli.ts）
```

Node 是运行前置条件：当前工具链使用 Node 24，用户将可用 Node 放入 PATH，或直接用其绝对路径启动 bootstrap；CI 显式准备 Node。初始化前仍需安装 workspace 开发依赖。Node 不可用时由安装说明指导准备环境，不再新建另一套 PowerShell、cmd 或 shell 自动发现脚本，也不在 `local.json` 增加一个需要 Node 才能读取的 Node 字段。

仓库 `.ps1` 与原 `DSH_NODE` 自动发现代码已删除；调用方通过 PATH 或 Node 绝对路径选择运行时。后续新功能只设计 TS 命令和参数，不新增 shell 转发层。

文档、报错提示、package scripts 和自动化统一指向 Node CLI；兼容专属测试已换为真实 bootstrap 入口测试。Web、打包和安装业务仍位于 `commands/web.ts`、`pack.ts` 和 `install.ts`。退场记录见 §14.10；此前章节中的 PowerShell 验收命令仅保留为历史证据。

### 5.2 单一 Node 工具链与 DSH 宿主边界

详细方案已集中到[插件开发环境统一与隔离规划](development-environment-plan.md)，本节只保留边界，避免维护两份不同的工具链方案：

- 先完成 TS 脚本收尾与 PS 退场，后续才做环境统一与开发隔离，不把新增环境工程并入当前脚本收尾。
- 仓库工具及开发 Web 使用一套 Node 24、指定 pnpm；编译工具、类型包和固定版本开发 DSH 由 workspace 管理。开发 DSH 仅用于隔离调试和验收，不进入插件交付物。
- 开发使用持久的独立 home/profile 和 link；验收使用一次性 home/profile 安装 tarball；正式安装把同一份已验收 tarball 装到用户明确选择的 DSH/profile。
- 开发宿主与正式安装目标分别配置，不再用一个通用 `tools.dshCli` 同时承担两种职责。正式安装不能因 PATH 被 workspace `.bin` 覆盖而误选开发 DSH，也不能替换用户宿主。
- 构建环境与正式宿主需要 API/运行时兼容，不要求相同 Node 文件或精确小版本；桌面 Electron 保持应用自身管理。ES2022 编译目标和类型检查不能替代真实宿主验收。

当前仍是单一 DSH 入口配置，pnpm 发现和现有 CI 也尚未按新规划改造。完整建设顺序、配置迁移边界与验收标准见新规划 §5、§8、§9；本轮未修改运行时代码。

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

第三阶段计划提供 `repair --dry-run` / `repair`，只修复工具位置和 HMR 路径，并在写入前备份。字段归属、旧配置接管、预览和失败恢复的具体规则见 §14；这些命令当前尚不可用。

当前实现不支持自动修复或跨版本迁移，不支持的版本明确报错。第三阶段将通过独立的 `migrate` 命令处理格式与模板升级，不在日常运行或 `repair` 中隐式升级。

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

- [x] 设计修复字段归属、预览和备份规则（§14，2026-10-30）。
- [ ] 提供仓库搬迁和工具升级后的显式修复。
- [ ] 实现按版本迁移，以及 Web 模板升级的记录机制。
- [ ] 完成旧配置兼容、写入失败恢复和 Windows/macOS 验收（§14.9）。

跨阶段建设顺序单独遵循[开发环境规划 §8](development-environment-plan.md#8-建设顺序与阶段出口)：先完成 §14.10 的 TS 收尾与 PS 退场，再实施 §5.2 所述环境统一/隔离。repair/migrate 依据后续配置结构落地，不作为 TS 收尾的前置。

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

```sh
# 统一使用 Node/TS CLI
node scripts/bootstrap.mjs pack --skip-build --pnpm-script '<pnpm.cjs绝对路径>'
node scripts/bootstrap.mjs dev-install --profile web --surface web --dry-run
node scripts/bootstrap.mjs ci --test-browser chromium --timeout 180000
node scripts/bootstrap.mjs stable-install --profile web --surface web --dry-run
node scripts/bootstrap.mjs l5 --test-browser chromium --timeout 180000
```

安装先完成目标过滤和全部 tarball 存在性检查，再逐个执行 `dsh plugin add` 和 `pnpm update`；任何一步失败都会停止并返回原退出码，不执行 `remove`。`--dry-run` 不构建、不生成 shim、不修改 profile。开发安装默认先构建，`--skip-build` 仍要求已有构建入口。打包检查所有插件构建入口后，才向 `dist/` 写入。

`DSH_PROFILE_DIR` 仅用于当前会话对应的 profile，切换目标时重新从 home 计算路径。L4/L5 会清除继承的 profile 目录和 Web 地址，强制使用 `.tmp` 内一次性 home 及 pnpm store；不会读取个人 YAML。大小写不同的 Windows 环境变量会在子进程中规范化，避免 `Path` / `PATH` 冲突。

CI 的顺序为：安装工具链 → 安装 workspace 依赖 → `config init --browser default --test-browser chromium` → 安装 Playwright Chromium → `ci`。生成配置与测试现场留在 runner，不提交或上传。指定提交的远端通过记录见下；后续提交仍以各自的 Actions 结果为准。

### 第二阶段验收记录（Windows，2026-10-30）

- 类型检查、元数据与 CATALOG 检查通过；L1–L3 共 249 项通过。新增覆盖工具与测试参数优先级、Windows 环境大小写、测试隔离、安装预检和失败停止，以及 PowerShell 参数与退出码转发。
- 真实 L4 的前置检查与七个阶段全部通过；L5 的独立基线、slot/主题/语言交互及三项通知场景通过。
- 通过新 `pack` / `dev-install` / `stable-install` 实现，在同一个一次性 Web profile 中完成 link → tarball → link；断言依赖 spec、实际 junction/拷贝状态及 `status` 输出一致。两个仅桌面插件被跳过。
- 该切换前后本机 JSON 与 Web patch 字节不变，临时 home/store 已清理。测试报告保留在忽略的 `.tmp/` 中，没有修改日常 profile。
- 此次本地验收时尚未确认远端通过；随后 Windows/macOS 远端 CI 已通过，见下一节。第三阶段 repair/版本迁移仍未完成。

### 第二阶段远端验收补充（2026-10-30）

- 基线提交：`d9f2a1253150a147ecd11d533fb333cc3f2cd2f0`；[GitHub Actions run 41061844806](https://github.com/mbda9091/dsh-plugin/actions/runs/41061844806)，`windows-latest`、`macos-latest` 均为 `success`，整体于 21:28:15（Asia/Shanghai）完成。
- 两个平台均完成冻结 lockfile 安装、runner 内 `config init`、Chromium 安装，以及同一 `ci --keep` 入口的类型检查、L1–L3、真实 L4 和 L5。详细修复与边界见 [测试方案 §19.7](testing-plan.md#197-远端-ci-验收2026-10-30)。
- 这确认了 macOS runner 上的配置初始化、普通 Node 版 DSH Web 与浏览器自动化；不代表 macOS 日常 `start.ps1` / 系统默认浏览器启动或原生通知人工验收，也不替代 Windows 本地同一 profile 的 link → tarball → link 切换记录。
- 第一、二阶段及远端 CI 验收完成；第三阶段具体设计见 §14，显式 repair、格式/模板版本迁移及其验收仍待实现。

## 13. 相关文件

- [仓库工作约定](../AGENTS.md)
- [DSH 概念与配置层序](dsh-concepts.md)
- [当前 Web 启动与配置说明](../profiles/web/README.md)
- [测试与 Web L5 方案](testing-plan.md)
- [插件开发环境统一与隔离规划](development-environment-plan.md)

## 14. 第三阶段具体设计：修复与格式升级

本节是待实现的设计，下面的新增命令、文件及退出码均不代表现有功能。目标是让仓库搬迁、工具位置失效和配置格式演进可以显式处理，同时保留个人设置。第三阶段不安装或升级 DSH/pnpm，不修改实际 profile，不启动或重启服务。

以下字段示例基于当前 v1 配置。开发环境规划实施后，需要分别处理开发配置与正式安装目标；单一 `tools.dshCli` 的例子不再是最终字段设计。迁移采用本节的预览/备份原则，具体 schema 与最小迁移在环境统一阶段一起确定，禁止静默将旧入口同时绑定为开发和正式宿主。

### 14.1 命令边界与使用流程

保留 `init`、`check`，新增 `repair` 和 `migrate`，全部通过 `node scripts/bootstrap.mjs config <action>` 调用 TypeScript CLI。两个写命令共用计划、校验和备份流程，不新增 PowerShell 实现或专用入口。

| 命令 | 职责 | 不包含的操作 |
|---|---|---|
| `init` | 新机器生成两份配置及维护记录；已有配置保持不变 | 不补写旧配置的维护记录，不覆盖或升级已有文件 |
| `check` | 检查实际生效配置，额外报告持久配置的失效路径、归属变化、模板版本和未完成事务 | 不发现替代工具，不写配置或维护记录 |
| `repair [--dry-run]` | 修复允许管理的失效工具路径、仓库搬迁后的 HMR 路径；必要时建立维护记录 | 不改变偏好，不迁移格式，不追随新模板 |
| `migrate [--dry-run]` | 执行仓库内已注册的配置版本迁移或 Web 模板升级步骤 | 不重新发现工具，不顺带修复路径，不直接套用最新 example |

推荐先 `check`，再预览对应命令，最后执行同参数的写命令。执行本身就是对该范围的明确请求，不增加交互式确认。若格式已过旧，应先 `migrate`，再 `repair`。

```sh
# 以下为计划接口，尚未实现
node scripts/bootstrap.mjs config repair --dry-run
node scripts/bootstrap.mjs config repair

# 指定工具新位置：明确写回该字段，适用于旧配置或个人固定路径
node scripts/bootstrap.mjs config repair --dsh-cli '<普通 Node 版 dsh 路径>' --dry-run
node scripts/bootstrap.mjs config repair --dsh-cli '<普通 Node 版 dsh 路径>'

# 接管可证明来自旧模板的完整 HMR root 列表，并按当前仓库位置修复
node scripts/bootstrap.mjs config repair --adopt-hmr --dry-run
node scripts/bootstrap.mjs config repair --adopt-hmr

# 指定仓库实际支持的目标版本；可单独迁移一种，也可同时迁移
node scripts/bootstrap.mjs config migrate --config-version <目标版本> --dry-run
node scripts/bootstrap.mjs config migrate --web-template <目标版本> --dry-run
```

`repair` 仅接受 `--dry-run`、`--dsh-cli`、`--pnpm-script`、`--adopt-hmr`；不提供 `--force`、任意字段写入或通配路径替换。`migrate` 必须至少指定一种目标版本，实际写入时去掉 `--dry-run`；禁止降级、未知目标或缺少中间步骤的跳级。CLI 按 action 校验选项，未知或不适用的参数直接报错。

日常读取的“参数 > 环境变量 > 本机文件”优先级不变。维护命令针对**磁盘中的原始配置**制定计划，不把 `DSH_CLI`、`DSH_PNPM`、`CHROME_PATH`、`DSH_E2E_BROWSER` 的临时覆盖写回。`repair` 的工具参数明确表示持久替换；候选发现仍可读取 PATH、用户目录和已知安装位置，但先移除上述配置覆盖变量。Node 由调用方按 §5.1 准备，与 DSH/pnpm 的维护发现分开。

### 14.2 维护记录与版本归属

新增 `scripts/config/local.state.json`，只供维护命令记录来源、基线和升级结果；业务配置仍在原来的 JSON/YAML 中。它不参与运行时配置合成，缺失不会阻止现有 v1 配置运行。这样无需仅为记录来源而升级 `local.json` 的格式。

| 维护记录字段 | 含义 |
|---|---|
| `stateVersion` | 维护记录自身格式版本，初始为 1，与业务 JSON 和 Web 模板独立 |
| `repoRoot`、`platform` | 上次成功维护时的仓库位置与平台，用于解释路径和搬迁诊断 |
| `tools` | 每个工具字段的 `owner: generated/user`、上次写入的原始值、来源；不保存整份环境变量 |
| `hmr` | `owner`、生成根目录、模板版本、相对后缀列表、上次生成的完整 root 列表；用户拥有时不保存其自定义路径副本 |
| `webTemplate` | 初始化时可确认的 `originVersion`、最后处理的 `reviewedVersion`，未知则为 `null` |
| `migrations` | 已执行步骤的 id、前后版本、时间及逐字段的 `applied` / `preserved-local` / `already-satisfied` 结果 |

新 `init` 对自动发现的非空 DSH/pnpm 路径记为 `generated`，命令行或环境变量指定的路径记为 `user`；未发现的 `null` 也记为 `user`，不能日后悄悄填充。模板生成的完整 HMR root 列表记为 `generated`。浏览器位置及所有行为参数始终归用户。

新 init 将 `originVersion` 和 `reviewedVersion` 都设为实际使用的模板版本；后续成功修复或迁移必须同时更新受管字段的基线，保证第二次执行不再提出同一修改。`hmr` 自己保留生成时根目录，不能用工具修复更新后的全局 `repoRoot` 覆盖其旧来源。

维护记录的结构和版本必须校验，未知字段、非法后缀、越界路径均拒绝。它是可丢失的辅助记录，不是配置备份或恢复依据。缺失时按 §14.4 保守处理；损坏或来自更新版本时维护命令停止并提示先备份处理，不能静默重建并扩大自动修改范围。正常业务命令无需加载它；`check` 会报告问题。

提交的内容包括维护记录 schema、不可变的历史模板/迁移描述与测试 fixture。以下本机内容在实现时先加精确忽略规则，再生成，并验证不进入插件 tarball：

```gitignore
/scripts/config/local.state.json
/scripts/config/.local-backups/
/scripts/config/.local-maintenance.lock
/scripts/config/.local-maintenance.pending.json
/scripts/config/.local-maintenance-*.tmp
/profiles/web/.local-maintenance-*.tmp
```

### 14.3 字段归属与修复决策

| 字段 | 默认归属与允许的修改 |
|---|---|
| `tools.dshCli`、`tools.pnpmScript` | 仅来源记录为 generated 且当前值仍等于基线时，允许为失效位置发现替代值；显式工具参数可替换对应字段，替换后归 user |
| `web.browserPath`、`test.browserPath` | 用户拥有；发现失效只提示手动修改，不自动切换浏览器或安装位置 |
| 浏览器选择、打开开关、所有超时 | 用户拥有；repair 不改 |
| 唯一顶层 `id: hmr` 行的 `config.root` | 完整列表仍等于生成基线时，允许按已记录的相对后缀搬迁；不增加或删除监听目录 |
| `hmr.config.ignored`、通知参数、审批规则、其他 YAML 内容 | 用户拥有；repair 不改，也不根据新模板覆盖 |
| `local.json.version` | 仅由已注册的格式迁移步骤改变 |
| 生成位置注释、维护记录 | 仅随对应成功操作更新；注释本身不能授权接管 |

工具原始值发生变化，即使解析后指向同一个文件，也视为用户接管；普通相对路径保持原样，从当前仓库根解析。工具仍有效时不因 PATH 顺序变化或发现新版而替换。需主动切换一个仍有效的工具时必须传显式路径；本功能不判断工具是否为“最新版”。

HMR 采用**整个 root 列表归属**，不猜测其中某一项是否仍可管理。新增、删除、重排或改写任一项后整列归用户；只改注释、引号或换行不改变归属。路径比较使用来源平台的路径规则；Windows 规范化分隔符及大小写，macOS 不假设卷大小写不敏感。跨 Windows/macOS 的配置复制不自动转换 HMR，提示重新初始化或手工处理。

搬迁只计算 `当前仓库 + 已记录后缀`，不全文替换旧路径前缀，不使用当前 example 的目录清单，不根据 `realpath` 扩大监听范围。允许目标 `lib/` 尚未构建，此时报告“先构建”，不能把缺少构建产物误当成工具修复失败。

多个同 id 的 HMR 行、嵌套 insert、alias/merge、动态 `!!js` root 或无法唯一定位的结构不自动修复。未触及的 `!!js` 保持惰性；预览、迁移和检查均不执行表达式。

### 14.4 第一、二阶段配置如何接入

已有两份配置但没有维护记录是正常的 legacy 状态。重复 `init` 仍不写任何文件；第一次成功执行 `repair` 可建立保守记录，JSON/YAML 没有实际修改时保持字节不变。

- 旧工具路径一律按用户拥有处理，即使恰好等于当前自动发现结果，也不能据此推断来源。有效则保留；失效时须用 `--dsh-cli` / `--pnpm-script` 显式替换，或先手工修正。
- 旧 HMR 默认归用户。只有 `--adopt-hmr` 才允许接管：使用仓库内冻结的 v1 模板、旧 `Generated for repository` 注释及来源平台规则重建 root 列表，要求唯一静态 HMR 列表与重建结果完整匹配。模板版本标识必须可识别，缺失或歧义时拒绝。
- 建立 legacy 记录时，可识别的历史模板头注释只用于记录 `originVersion` / 初始 `reviewedVersion`，不授予字段所有权；无法识别则两者为 null。来源平台从旧仓库路径的明确语法判定，无法判断或与当前平台不同则不接管 HMR。
- 接管范围仅为 HMR root，不要求通知配置与旧模板一致，也不接管 ignored、审批规则或其他行。即使旧仓库目录仍存在，显式接管后也可搬迁到当前仓库。
- 自定义 root 列表不支持自动接管。用户手工修复后可继续使用，维护记录保持 user；不提供从当前自定义值直接“认领为生成值”的开关。
- 两份业务配置缺任意一份时停止；`repair` 不重建丢失文件。维护记录丢失不会触发恢复个人设置的行为，需从本地备份恢复或按上述规则重新建立。

在已存在的维护记录中发现用户改动时，预览列出 `preserve-user`，成功写操作才更新归属；只读检查不写状态。若其他字段阻断了本次操作，所有文件仍保持原样，下次重新识别。

### 14.5 修复计划与预览

`repair` 按以下顺序工作：读取原始文件与字节哈希 → 校验格式和维护记录 → 判断归属 → 检查路径/发现候选 → 形成完整计划 → 校验候选内容 → 预览或提交。

每条计划包含文件、字段、`replace` / `preserve-user` / `no-op` / `blocked`、原因、来源及允许显示的旧/新路径。额外列出待写文件、备份位置和剩余警告。不得把整份个人 YAML、审批命令、任意字符串或认证 URL 打印为 diff；格式迁移涉及个人值时只显示字段和动作。

自动发现只针对满足归属条件且已失效的工具，复用 §5.2 所指新规划中的解析规则，不扩大私有运行时目录扫描。开发 DSH 从锁定依赖派生，正式目标只校验用户所选安装，两者不能互相作为 repair 的回退候选；Web 检查普通 Node 场景，桌面目标保留其运行时边界。pnpm 必须是存在的 `pnpm.cjs` 并通过工具链版本检查。显式路径无效、找不到合格替代值、维护记录不合法、需要修改但无法安全定位 HMR 时标记 blocked；不安装/升级 DSH、不清空字段、不留下半份修复。

用户拥有的失效工具或明确指向旧仓库的 HMR 不能自动修复，报告所需手动动作并阻断该范围的提交。尚未绑定正式安装目标不阻断开发环境维护；开发/正式配置的维护范围随新 schema 一起明确，不能借修复开发环境改写日常目标。动态 HMR、未配置的可选 pnpm、用户浏览器失效、未生成的 lib 等检查警告不扩展修复范围，单独列为“本次未处理”；repair 成功不等于整份配置或插件能力已通过验收。

`--dry-run` 不创建维护记录、备份、锁、临时候选文件，不修改 profile 或启动子进程发现工具；允许 bootstrap 自身按既有机制编译脚本。预览与执行使用同一计划器；执行重新读取和验证，打印实际计划，不把前一次预览当作文件快照或授权任意新范围。

新增维护命令统一退出码：`0` 表示计划可执行、提交成功或无变化；`1` 表示输入错误、blocked、目标不支持或 I/O 失败。预览发现需要改动本身不返回失败。现有 `check` 有警告返回 `1` 的约定保留，并分开报告持久配置与环境/参数覆盖后的有效配置，避免临时覆盖掩盖磁盘中的失效路径。

### 14.6 备份、写入与失败恢复

允许写入的业务目标固定为 `local.json`、`cordis.local.patch.yml` 和 `local.state.json`，不能由维护记录或命令行指定任意目标。写入前拒绝这些文件及其仓库内父目录上的 symlink/junction，验证真实目标仍在当前仓库内；仓库本身可先解析为确定的真实根目录。

一次维护按以下步骤提交，`init` 的新建流程也复用此协议；无变化时不创建备份、不刷新时间戳：

1. 以独占创建方式取得维护锁；重新比较计划输入、schema 和迁移描述的哈希。发现并发编辑、输入变化或未完成事务就停止，不继续应用旧计划。
2. 创建 `scripts/config/.local-backups/<UTC时间>-<随机id>/`，对本次将改动的现存文件保存原始字节及 SHA-256，记录不存在的目标。manifest 使用固定相对文件名，记录动作、前后哈希和迁移 id；备份完成前不改任何目标。
3. 在各目标同目录写入独占创建的临时文件，校验候选 JSON/schema、YAML 结构、管理字段及版本；保持未修改文件字节不变。修改 YAML 时使用文档节点定位及源码范围编辑，保留未触及内容、注释和 `!!js`，不把整份 YAML 转成普通对象再输出；不支持安全编辑的结构直接阻断。
4. 写入持久的 pending 记录，随后依次替换业务文件，最后替换维护记录。每次替换前再次检查原目标哈希；单文件采用同目录替换，不以“先删除旧文件”解决 Windows 占用错误。
5. 全部写完并核验哈希后，将备份 manifest 标记为 committed，清除 pending、临时文件和锁，打印备份位置。保留备份，不自动轮转删除。

多文件替换不宣称具备文件系统级原子性。普通异常时，仅当目标仍等于本次写入哈希才从备份恢复；不覆盖并发产生的第三方内容。回滚失败或进程中断时保留 pending、备份和错误记录，并报告哪些文件已写、哪些已恢复。

锁只约束仓库维护命令，不能锁住外部编辑器；哈希检查用于检测并发改动，不能保证检查与替换之间没有竞态。执行期间应暂停对目标文件的手动编辑。备份、临时文件和 pending 同样需要检查父目录与目标类型，不能仅检查三份业务文件；可恢复性以进程异常/中断为范围，不承诺磁盘损坏或断电后的持久性。

发现 pending 后，`init` / `repair` / `migrate` 禁止继续写；配置加载入口也明确阻止日常命令使用可能不一致的文件，`check` 仅输出恢复诊断。这是读取器新增的事务完整性检查，不从维护记录合成配置。已运行的 Web/HMR 进程不受该检查保护，因此实际写入个人 Web patch 前应由用户停止相关服务，完成后自行重启。

首版采用人工恢复：先确认维护进程已退出，按 manifest 核对目标是旧哈希、新哈希还是第三方内容；需要保留的第三方内容先另存，再把该事务涉及的文件全部恢复为备份原始字节，仅删除记录为“原先不存在”且仍匹配本次新哈希的目标。核验后将事务标记为 rolled-back，清除 pending/锁并重新 `check`。不根据 PID 超时擅自清锁，也不提供自动覆盖第三方编辑的恢复模式。

备份可能包含个人规则，始终只存本地、受忽略、不上传 CI artifact；诊断只展示位置和哈希。此机制操作的是仓库内本机文件，不改变实际 DSH profile 的备份与插件管理规则。

### 14.7 JSON 格式迁移与 Web 模板升级

三个版本维度独立：`local.json.version` 表示业务结构；Web template version 表示模板建议的演进；`stateVersion` 表示维护记录格式。第三阶段首版维持业务 JSON `version: 1`，不为增加 sidecar 强行制造 v2。

**JSON 格式迁移：**每个真实版本变化必须随代码提交旧版 schema、新版 schema 和纯函数迁移步骤，使用稳定 id（如 `config-v1-v2`）。`migrate --config-version N` 先按源版本 schema 校验，再连续执行每一步、逐步校验目标结构；新字段的值由步骤明确声明，不运行时读取最新 example 补齐。只改声明的字段，保留不相关个人值；删除、重命名或语义变化必须在预览解释。无法无损确定新值时阻断并列出人工前置操作，不能猜测。

普通业务读取器继续拒绝其不支持的旧版/未来版，并提示可用迁移命令。迁移入口必须能绕过“先加载当前版配置”的启动依赖，直接按源版 schema 读取；它不依赖失效的 DSH/pnpm 来执行迁移。当前没有真实 v2 时，以隔离测试 fixture 验证 v1→v2→v3 的迁移框架，生产中请求未注册的 v2 必须失败。

旧业务 JSON 需要迁移但维护记录缺失时，migrate 可按 §14.4 的保守规则同时建立记录，不能要求先执行只能理解当前格式的 repair。两种迁移一起请求时先在内存完成 JSON 步骤，再完成 Web 步骤，全部校验通过后一次提交；任一步阻断就不写任何文件。

**Web 模板升级：**将当前 v1 模板冻结为历史基线，后续模板每次语义变化必须升版，并提交连续迁移描述。迁移描述列出变更的行/字段、适用前提、旧值/新值及用户需要采取的动作；不能只修改 example 而遗漏升级说明。通过 CI 检查模板版本与迁移描述的一致性。

`migrate --web-template N` 离线处理本机文件，不改变 DSH 的“同 id 整体替换 config”规则，也不在启动时合并模板：

- 对仍受管理且与基线一致的 HMR root，可应用迁移描述中明确列出的目录增删/变更，预览展示完整监听范围差异；repair 只能搬迁，不能做这些增删。仓库位置已变化时先 repair，再执行模板迁移。
- 对用户拥有的字段，包括 ignored、通知参数、审批规则及自定义 HMR，一律保留并记录 `preserved-local`，列出模板建议；即使值恰好等于旧默认值，也不据此接管。用户删除的行不自动补回，新增非 HMR 行只提示手工添加。
- 如果某步明确声明“保留旧值将无法继续工作”，则不能按 preserved-local 完成，必须阻断并给出人工调整要求。用户手工调整后重新运行，满足目标前提可记为 `already-satisfied`。
- legacy 的模板来源未知时，不用当前 example 猜测旧版本；不能完成版本链的升级，需先恢复可验证记录或人工核对。仅接管 v1 HMR 不证明其他字段仍为 v1，故个人字段始终保留。

成功后 `reviewedVersion` 前进到目标版本，逐步记录实际结果；它表示“已按规则处理该版本”，不表示个人 patch 等于该版本模板。`originVersion` 保留来源，不冒充最新版本。没有可执行变更但存在待记录的 preserved-local 步骤时只更新维护记录；重复同一目标且没有新步骤时完全 no-op。发生冲突则整次不写、不推进版本；不在失败前先记成功。

### 14.8 实现拆分与交付顺序

沿用现有 `config.ts`、`config-tools.ts`、`web-patch.ts`；新增逻辑统一在 `scripts/src/`，只扩展 TS CLI，不扩展 PowerShell 兼容层。建议按以下边界拆分，避免命令层同时承载发现、决策和文件写入：

| 模块 | 职责 |
|---|---|
| `core/config-state.ts` | 校验维护记录、比较生成基线、判定字段归属；不写文件 |
| `core/config-maintenance.ts` | 根据输入快照和发现结果生成 repair/migrate 计划；预览和执行共用 |
| `core/config-migrations.ts` | 版本注册表、旧 schema、连续迁移及 Web 模板步骤；不发现工具 |
| `core/config-transaction.ts` | 固定目标集合、锁、哈希、备份、提交和条件回滚 |
| `commands/config.ts`、`cli.ts` | action 专属参数、计划展示、退出码、恢复诊断 |

总顺序以[开发环境规划 §8](development-environment-plan.md#8-建设顺序与阶段出口)为准：先完成 TS 脚本收尾，再统一配置和隔离环境。本节维护功能在配置职责确定后按下面三个小步落地；环境配置迁移需要的最小备份/迁移能力随新 schema 交付，不能反过来阻塞 TS 收尾：

1. **记录与写入基础**：维护 schema/忽略规则、历史 v1 基线、事务写入与恢复诊断；新 init 记录来源，旧文件仍可运行，重复 init 不变。
2. **repair**：工具修复、完整 HMR 搬迁、legacy 显式接管、只读预览和 check 诊断；补全失败与保留个人设置的测试。
3. **migrate**：格式迁移框架、Web 模板步骤与记录、版本链检查；真实新格式或模板版本变化时提交对应生产迁移，不提前虚构升级内容。

每步同步更新 Node CLI 帮助与 Web README，新增用例直接调用 TS 模块或 Node CLI。§14.10 是优先完成的脚本收尾，验收当前已有命令，不等待 repair/migrate 实现。实现维护功能前先落地忽略规则；每步只能把已经实现且验收通过的项目勾选为完成，本节设计完成不等于第三阶段交付。

### 14.9 验收矩阵

所有写入与迁移测试在独立 fixture 中运行，注入仓库根、平台、发现结果及文件操作故障；不读取或修改开发者实际本机配置和日常 profile。

| 场景 | 必须证明的结果 |
|---|---|
| legacy 无维护记录、重复 init | 原两份文件字节不变；运行正常；repair 默认不认领旧工具/HMR |
| 旧模板精确匹配 / 自定义 HMR | 显式 adopt 才接管前者；后者保留或阻断，注释不能单独授权 |
| 仓库搬迁，旧目录仍存在 | 受管 HMR 只替换仓库前缀对应的已知后缀；不加入新模板目录 |
| lib 尚未构建 / 跨平台复制 | 前者保留路径并提示构建；后者不自动改写 HMR |
| 用户修改工具或 root 列表、修改注释 | 语义改动解除生成归属；纯 YAML 格式/注释变化不解除；无关内容字节保留 |
| 工具失效 / 仍有效 / 显式无效 | 只修复允许管理的失效路径；有效路径不追新；无效显式值阻断且无回退 |
| 环境变量覆盖 | 日常优先级不变；维护不把临时覆盖写回，check 仍报告持久配置问题 |
| 工具链与环境分离 | 按开发环境规划 §9 单独验收：开发宿主来自锁定依赖，正式目标不受本地 .bin 干扰；维护不让两者相互回退 |
| dry-run 与 no-op | 目标、记录、备份、锁、候选文件均无新增或字节变化；计划动作与实际执行一致 |
| 动态 YAML、重复 id、alias、含中文/引号路径 | 不执行表达式；无法安全定位则阻断；合法路径正确编码，未触及源码不重排 |
| schema/维护记录损坏、未来版本、缺文件 | 明确失败，原文件不变；不隐式 init 或回退模板 |
| 备份失败、Windows 文件占用、各提交点故障 | 未备份不写目标；条件回滚恢复原字节；失败保留可核对的恢复记录 |
| 并发编辑、两个维护进程、进程中断 | 不覆盖第三方内容；锁防止并发写；pending 阻断后续配置消费并提供恢复步骤 |
| symlink/junction 或篡改备份目标 | 拒绝越界和任意目标写入；只对固定仓库内文件操作 |
| JSON 多步迁移、缺步骤、重复迁移 | 按源/目标 schema 校验，保留个人值；缺链失败；重复执行 no-op |
| Web 模板升级、删除通知行、个人审批规则 | 受管 HMR 按显式步骤升级；个人行保留；记录真实 applied/preserved-local 结果 |
| Git 与包契约 | 模板/schema/迁移描述被跟踪；本机配置、state、备份和 pending 不被跟踪或打包 |

验收顺序为类型检查 → L1–L3 → 真实 L4/L5，并在 Windows/macOS CI 经 Node CLI 执行。另用隔离源码/配置副本模拟搬迁，通过 `node scripts/bootstrap.mjs web` 确认修复后的 patch 被读取、加载成功，停止后确认无残留进程；L4/L5 本身继续使用专属测试 patch。已有通知与 UI 测试复用，不将系统原生通知外观纳入本阶段通过条件。

最终证据应包含 dry-run 前后哈希、用户字段保留断言、故障恢复报告、迁移记录和隔离 Web 启动结果。原始本机内容、备份、截图和 trace 仍不自动上传；完成记录只引用脱敏结论及对应提交的 CI 结果。

### 14.10 PowerShell 兼容层移除计划

本计划已完成代码迁移：仓库 11 个 `.ps1` 入口与兼容专属测试已删除，帮助、报错、文档、package scripts 和本机已知 `dshweb` 调用已改为 Node CLI。Windows 默认浏览器通过系统 URL handler 打开，不再启动 PowerShell。当前验证范围与证据见[测试方案 §7.5](testing-plan.md#75-p0-脚本收尾2026-10-30)。以下保留退场步骤与验收要求；后续环境统一和 repair/migrate 不在此次实现范围内。

1. **冻结兼容层并迁移调用方**：盘点 `scripts/*.ps1`、`profiles/web/start.ps1` 的文档、测试、package scripts、CI 及已知本地启动调用；逐个映射到现有 Node CLI 子命令。新增功能只进入 TS；更新 AGENTS.md、使用说明和报错指引，以 Node CLI 为默认。历史验收记录保留原命令并标明历史性质。
2. **验证完全独立的 Node 路径**：Node 已在 PATH 和以绝对路径调用两种方式均覆盖；从其他工作目录、含空格/中文路径启动仍定位正确仓库。Windows/macOS 验证初始化、检查、构建、打包、安装/状态、测试及 Web 启停；已实现的 repair/migrate 同样走 Node。业务测试不得间接启动 `.ps1`；过渡期只保留独立的兼容参数/退出码测试。
3. **删除兼容文件和专属测试**：移除 `scripts/*.ps1`（包括 `common.ps1`）与 `profiles/web/start.ps1`；删除只验证旧参数映射、Node 自动发现的兼容用例。原来借助 PS 入口验证的配置、加载、退出清理等业务断言迁到 Node CLI 用例，不能随壳脚本一并丢失。清理当前指引与调用引用，不保留假转发文件或另建一套 shell 入口。
4. **独立验收并记录退场完成**：在隔离源码副本中确认删除脚本后完整 Node CLI CI 通过，仓库命令的执行链不依赖 `pwsh`；检查实际调用与当前文档中没有遗留依赖，已知本地调用者已切换。最后更新仓库约定和本节状态；不以移除前的兼容测试通过代替删除后的验收。

删除范围是仓库的构建、配置、安装、测试与 Web 启动脚本。插件实现所需的 Windows 系统调用不属于本次退场范围；CI 选择何种终端 shell 也不等于仓库业务依赖 PowerShell。移除后 `DSH_NODE` 不再承担仓库启动定位职责，用户通过 PATH 或 Node 绝对路径选择运行时；其余 DSH/pnpm/浏览器配置覆盖规则保持原语义。
