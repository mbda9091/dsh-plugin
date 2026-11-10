# 脚本职责收敛与 Profile 一键安装配置方案（v0.6）

> 本文使命：记录删除仓库日常启动职责、scope 改名、直接 tarball 安装与命名空间默认配置建设，并对账后续有效调整。
> 状态：已实现，当前 macOS 自动化证据已核对；原轮次完整平台验收尚未关闭。完成：否（历史验收范围待收尾，不表示缺少核心实现）。完成日期：—。归档：未归档。
> 更新日期：2026-11-07（Asia/Shanghai）。
> 实现 commit：原建设主分支落点 `be2043ef973eb78d0d79c613c1f97a3e92a9ef16`；后续配置简化、宿主升级及入口分离见 §9.9。原 PR 短 SHA 保留各轮历史证据，不冒充最终合并提交验收。
> 当前源码核对及真实沙箱验证基线：`a88d7ac5e8ecc288ab22242592feca00df2d2a1b`（仅本文有未提交修改）。已有 macOS 完整 CI 基线：`4049f6fa5e57802c64ff0b6fd5cee9bfa99d42a9`，相关代码树一致。本次新增 workspace-write 沙箱实测：基础回归与 L4 通过；外部安装完成磁盘交付，但 pnpm store 回退警告导致退出 1 / needs-attention，不能记为完整通过。见 §8.3、§9.10。
> 当前结论：外部仅使用 `node scripts/install.mjs install|status --profile NAME`；安装负责匹配产物、必要时构建打包、安装和默认配置，不自动启动宿主或执行功能验收。内部开发测试使用 `dev.mjs`。`stable-install`、命名目标和本机配置前置已在后续明确取消。
> 阅读边界：§1–§4 描述当前有效行为；§5 保留原阶段并补当前对账，§6 保留决定演进，§8.1 与 §9.1–§9.8 保留历史验收。原始调研基线 `10e42df0ac08360cc6d31177795d40dd33b30639` 不作为当前实现验收基线。
> 关联文档：[模板](plan-template.md)、[配置协议](configuration-v2.md)、[开发环境方案](development-environment-plan.md)、[入口分离轮次](development-delivery-separation-plan.md)、[插件概念](dsh-concepts.md)、[平台声明](plugin-targets.md)。

## 1. 结论摘要

- **要解决的问题**：仓库同时承担日常启动、开发调试、测试和交付，入口职责混杂；安装插件后仍需手工准备 profile 配置。
- **采用的方案**：删除 `web`、无参数自动启动和 `daily-launcher`；新增 `install`，对当前插件生成 tarball、安装到显式目标，将插件包名前缀从 `@local/` 改为 `@mbda9091/`，并在该 profile 的 `mbda9091/cordis.patch.yml` 生成随包默认配置，不修改根目录的 `cordis.patch.yml`。
- **配置策略**：命名空间目录内缺失的插件配置行首次写入；该文件已有同 ID 行完整保留，profile 根 patch 始终不改。升级不自动覆盖用户配置，不创建审批授权规则，不修改模型、账号或全局 home 配置。
- **产物策略**：优先复用与当前源码及工具链匹配、内容校验通过的 tarball；没有可复用包时，再判断是否可复用编译输出，仅执行缺失的构建或打包阶段。不能仅凭版本号或文件时间判断“最新”。
- **本轮边界**：保留 `dev-web`、`dev-install`、构建、打包、测试、CI 和状态查询；固定包验收归内部，外部不再提供目标登记或 `stable-install`。日常启动、停止、重启、浏览器和服务托管均交还用户。
- **当前进展**：日常入口删除、scope 改名、独立 install、命名空间配置和分级缓存已实现。macOS 完整 CI 已有可回读成功报告；本次真实沙箱基础回归与 L4 通过，直接安装完成落盘但因 pnpm store 回退警告返回 needs-attention，见 §8.3。
- **下一步**：真实沙箱安装警告已定位为系统 pnpm 目录探测写入 EPERM 触发回退，见 §9.11；后续需在合适权限环境复验，并独立决定是否优化警告呈现。原轮次验收范围与完成状态仍需收尾；Windows/Linux 和个人环境专项按需验证，不自动恢复已取消机制，见 §10。

## 2. 范围

### 2.1 目标

- G1：仓库不再提供或部署日常启动入口，无参数调用仅显示帮助。
- G2：用户用一条命令，将当前仓库中适用的插件以 tarball 形式安装到指定的已有 profile，同时在 `<profile>/mbda9091/cordis.patch.yml` 获得默认配置文件；由用户在日常启动中显式加载。
- G3：已有个人配置不被默认值覆盖；重复安装可安全执行，失败能看出安装和配置分别完成到哪一步。
- G4：开发 profile 仍为 `<repo>/.local/dsh-dev/home/profiles/web`；测试仍使用 `.tmp` 下各次运行独立的 `web` profile；开发与测试隔离语义保留，后续入口统一调整为 `dev.mjs`。

### 2.2 非目标与延期项

| 事项 | 本轮处理 | 原因或后续触发条件 |
|---|---|---|
| 创建、克隆、删除日常 profile 或 home | 不做 | 用户提供已有 profile；本仓库只安装插件和写入相关默认配置 |
| 启动、停止、重启、托管用户 DSH | 删除仓库入口，不新增替代入口 | 日常运行由用户负责 |
| 修改已有日常数据、清理用户已部署启动器或 shell 配置 | 不做 | 删除仓库能力不等于删除用户环境 |
| 全面重命名或合并开发测试命令 | 不做 | 本轮要求其余功能保持不变 |
| 自动覆盖配置、自动迁移旧版插件配置、自动卸载插件 | 不做 | 用户已有配置优先，后续可单独设计显式迁移 |
| Windows Desktop 的新安装入口、默认配置生成和真实宿主适配 | 本轮不做 | 用户明确排除；已有 Desktop 插件与原开发测试流程保留 |
| 自动生成凭据、模型配置、白名单 grants | 不做 | 不属于插件通用默认值 |

### 2.3 适用场景与协作边界

- 新安装入口按各插件 `dsh.targets` 筛选，原轮次覆盖 Web/macOS、Web/Windows；当前代码另支持 Linux Web，支持声明不等于各平台已验收；不适配 Windows Desktop。已有 Desktop 插件仍保留源码、构建和原测试，不因本轮范围收敛而删除。
- `install` 验证安装文件、bundle 和配置落盘，不宣称插件实际通知或审批行为已通过验收。
- `pack` / `verify-artifacts` / L4/L5 保留内部固定包验收；外部 `install` 不要求验收记录，安装结果不能当成功能通过。`stable-install` 已明确移除。
- 原轮次完成定义：A1–A11 必要项通过，并分别记录 macOS Web 与 Windows Web 结果；必要的 Web 平台验证未完成时保持待验收，Windows Desktop 不计入本轮欠项。

## 3. 现状与问题

以下表格保留原实施前问题，旧命令/文件不代表当前仍存在。当前实现入口为 `dev-cli.ts`、`install-cli.ts`；安装编排与配置写入分别在 `profile-install.ts`、`profile-patch.ts`，具体见 §4。

| 对象 | 当前行为或已有能力 | 问题与影响 | 依据 |
|---|---|---|---|
| CLI 默认分发 | 无参数或仅启动参数时执行 `web` | 仓库默认承担日常使用 | `scripts/src/cli.ts` |
| `web` | 指定既有目标，前台启动 DSH，默认端口 3080 | 与本轮职责边界冲突 | `commands/daily-web.ts` |
| `daily-launcher` | prepare/deploy Windows 独立启动器 | 包含另一套日常启动交付机制 | `commands/daily-launcher.ts`、`packages/daily-launcher/` |
| `dev-web` / `dev-install` | 独立开发 home、归属标记、开发 link、HMR | 应完整保留，不能因名称含 web 被误删 | `commands/web.ts`、`commands/install.ts`、`core/development.ts` |
| `pack` / `stable-install` | 固定 tarball 批次、哈希、目标筛选、逐包报告及安装校验 | 可复用安装底层，但当前没有默认配置补入功能 | `commands/pack.ts`、`commands/install-artifacts.ts` |
| bundle patch | 注册插件行，部分包含默认 config | 不能直接复制为 profile patch，否则可能重复 insert | 各插件 `cordis.patch.yml` |
| 用户 patch | profile patch 晚于 bundle，单行 config 整体替换 | 直接覆盖或字段补齐可能改变既有语义 | `docs/dsh-concepts.md`、DSH 当前实现 |
| 测试与 CI | 既有 L1–L5、环境测试、固定产物测试 | 删除日常功能时需要调整专属用例，其他覆盖不得一起移除 | `commands/ci.ts`、`test/src/environment/` |

- 已有可复用能力：平台过滤、普通 Node/DSH 解析、目标身份检查、系统 pnpm 配置、tarball 内容校验和安装报告。
- 已确认约束：profile 名必须显式提供；home 与宿主由当前环境解析或显式覆盖，不再要求全量手填；Desktop 的运行状态和实际效果不能通过 Web 启动方式代验。
- 现有本机日常 profile 中包含 link 安装；新入口执行后选中插件应成为实际 tarball 安装，而不只修改 manifest 字符串。

## 4. 具体方案

### 4.1 总体设计与职责

已实现流程：

```text
显式选择已有 profile
  → 校验目标、插件兼容性与 mbda9091/cordis.patch.yml
  → 检查可复用 tarball；未命中再检查编译输出，按需构建/打包
  → 从 tarball 读取默认配置，生成完整变更计划
  → 持久保存选中 tarball
  → 安装并验证选中插件
  → 创建 mbda9091 目录，备份并原子补入其 cordis.patch.yml
  → 输出逐包结果、配置路径和备份路径
```

| 部分 | 职责 | 本轮改动 |
|---|---|---|
| `scripts/src/dev-cli.ts`、`install-cli.ts`、根 `package.json` | 命令分发 | 开发/安装分离，默认帮助；直接安装使用 install.mjs，保留 install-plugins 快捷脚本 |
| `commands/daily-web.ts`、`commands/daily-launcher.ts`、`packages/daily-launcher/` | 日常启动与启动器交付 | 删除；同步清理专属测试、文档、workspace/锁文件中的对应引用 |
| `commands/profile-install.ts`（已实现） | 当前源码到 profile 的一键编排 | 目标预检、pack、tarball 安装、默认 patch 写入、报告 |
| `core/profile-patch.ts`（已实现） | 默认 patch 验证与命名空间配置文件写入 | 解析、冲突检查、只补命名空间文件缺失行、备份、并发检查与原子写入 |
| Web 插件 `profile.defaults.patch.yml`（已实现） | 可安装的配置默认值 | 随 tarball 发布，声明在包内文件清单及仓库专用元数据中 |
| 既有 tarball 安装底层 | add/update、包内容与依赖校验 | 复用公共安装原语；外部直接安装和内部固定包验收分别执行，不保留外部严格安装入口 |
| `install/status` | 安装及只读检查 | 每次按参数和当前 Node/DSH 环境解析；不读取 local.json，不维护 target 绑定 |
| `dev-web`、`dev-install`、L1–L5、CI | 开发与测试 | 保留隔离环境与能力，统一使用 dev.mjs |

删除日常专属实现前按引用检查公共依赖：`daily-archive` 中产物持久归档、收据，以及 `daily-contract` 中被正式安装复用的路径检查继续保留，不按文件名前缀整批删除。可移除只服务启动器的逻辑，但不强制重命名公共文件。

### 4.2 关键行为与异常路径

#### 目标与插件选择

1. 仅要求 `--profile NAME`；DSH 从当前 Node 对应的外部安装解析，home 按显式 `--home` > `DSH_HOME` > `~/.dsh`。可选 `--dsh-cli`、`--home`、`--platform` 覆盖；platform 必须匹配当前系统，固定 Web，不接受 `--target` / `--surface`。宿主发现歧义时失败，要求显式指定，不猜 profile。
2. profile 必须已有 `package.json` 且可解析；目录不存在时在写入前失败，提示用户自行准备。拒绝将新入口指向受管开发或测试目录。
3. 默认安装当前仓库中与目标兼容的全部插件；`--only` 为精确包名子集，未知、重复或不兼容名称均在安装前报错。没有适用插件时明确失败，不输出成功。
4. 新 install 仅接受 surface=web；显式选择 Desktop 目标时在构建、打包或目标写入前报不支持。默认筛选跳过 Desktop 专属插件，--only 指定这些插件时失败。沿用宿主和平台检查，不能在 macOS 上将 Windows Web 目标标记为已验证。

#### 默认配置来源与格式

- 本轮适用的 Web 插件新增 `profile.defaults.patch.yml`，使用针对已有 loader 行的 `id` / `name` / `config`，不允许 `insert`、跨插件行或强制 `disabled: false`。
- 插件 `package.json` 已增加仓库专用字段 `dshPlugin.profileDefaults: "./profile.defaults.patch.yml"`；不扩展 DSH 自身协议。将该文件加入 `files`，校验包内相对路径不得越界。
- 安装阶段从本次 tarball 读取模板，不能安装 A 版本的包却使用工作区 B 版本模板。模板参与既有产物内容及哈希校验。
- 默认文件仅使用普通 YAML 数据，不执行表达式。现有用户 patch 中的 `!!js` 等内容须原样保留，不能通过不支持标签的解析后序列化破坏它。
- 模板以当前插件运行时默认值为准；构建/契约测试验证二者一致。无配置插件提供空数组模板，并报告 `not-needed`。

| 插件 | 当前默认 patch |
|---|---|
| `notify-web` | 仅四项用户配置：三个通知开关与 300ms 审批延迟；SSE 参数使用运行时默认值。安装命令不申请权限，Client 加载时会申请尚未决定的权限 |
| `desktop-notify` | Desktop 专属，本轮不新增默认文件；原 bundle 默认值、代码与测试保留 |
| `app-restart` | Desktop 专属，本轮不新增默认文件；代码与测试保留 |

当前 `notify-web` 随包默认文件为（`b554760` 已移除通道参数）：

```yaml
- id: notify-web
  name: '@mbda9091/notify-web'
  config:
    notifyOnApproval: true
    approvalDelayMs: 300
    notifyOnTurnEnd: true
    notifyOnTurnError: true
```

#### 包名与目录命名

- 当前三个对外插件包为 `@mbda9091/app-restart`、`@mbda9091/desktop-notify`、`@mbda9091/notify-web`。
- profile 下目录使用 `mbda9091`，不带 `@`。npm scope 与文件目录分别按各自约定命名。
- loader 行 `id` 和源码目录仍使用 `notify-web` 等短名；行的 `name`、包清单、类型引用、测试、示例和目录文档同步更新 scope。
- 仓库内部 `@local/notify-core`、`@local/notify-host` 等私有共享包也同步改为 `@mbda9091/`，避免保留两套自有命名；它们仍为构建期依赖，不作为插件安装或生成默认配置。
- 移除 `name.slice(7)` 等对 `@local/` 长度的假设，统一通过包名解析取得短名。同步更新能力验证适配器中的精确包名、workspace 依赖和锁文件；不把旧包验收报告改名冒用。

生成目录（以安装 Web 插件为例）：

```text
<home>/profiles/<profile>/
├── package.json                    # dependencies / bundles 使用 @mbda9091/*
├── cordis.patch.yml                # 原用户配置，安装命令不改
└── mbda9091/
    └── cordis.patch.yml            # 合并本次选中插件的默认配置行
```

#### 写入规则与重复执行

- 只向 `<home>/profiles/<profile>/mbda9091/cordis.patch.yml` 写配置；不在根 patch 中补行、插入 include 或覆盖已有内容。
- 目录不存在时创建；文件不存在时生成；已有有效数组时只追加缺失 ID。已有同 ID 行完整保留，不补 config 字段、不恢复用户禁用状态。无配置插件不贡献配置行；若选中插件均无配置，也生成 `[]` 以维持一致的文件布局。
- 命名空间文件中的重复 ID、name 不匹配、跨插件行、非法 YAML 或复杂嵌套冲突均在安装前拒绝。保留原文件注释、标签和表达式，不执行用户表达式。
- 无配置变化时不重写、不备份；有变化时备份为同目录 `cordis.patch.yml.bak`，已有备份先保留到带操作 ID 的历史副本。
- 校验 `mbda9091` 目录及文件真实路径，拒绝链接逃逸；提交前复核原文件存在性与哈希，使用 profile 范围安装锁协调本仓库写入。外部并发改动导致冲突时退出，不覆盖。
- 候选文件在同目录写入并原子替换，保留原文件权限；新文件仅用户可读写。成功后回读校验，根 patch 在整个操作前后必须字节一致。
- 生成后配置归用户管理，升级仍只补缺失行；不将用户修改过的值恢复为模板值。

#### 配置加载边界

- 已核对当前 DSH：自动层序仅包含 bundle、profile 根 patch、home patch 和显式 overlays；不会自动扫描 `mbda9091/`。安装完成表示包和配置文件已准备好，不能报告该文件已自动加载。
- 日常启动由用户负责。支持 `--patch` 的 Web CLI 可显式传入 `--patch <profile绝对路径>/mbda9091/cordis.patch.yml`；仓库只输出文件路径及提示，不生成或修改日常启动器。
- 显式 `--patch` 晚于 profile 根 patch 和 home patch，可能覆盖它们的同 ID config；其 config 仍为整体替换。用户应决定是否加载及多个 patch 的顺序，不能承诺原根配置永远优先。
- 本轮不适配 Desktop 配置接入，新 install 不对 Desktop 执行安装或生成配置；不修改 Desktop 启动链。
- 原方案“补入根 patch、自动读取”的决定已撤回；本版的一键范围为安装包并生成配置，配置加载属于用户日常运行职责。

#### 安装、持久化与失败处理

- 默认按下节复用策略选择匹配当前源码的固定批次，仅安装该批次的选中包；不自动采用只有版本号相同但无法证明来源一致的旧产物。
- tarball 保存在独立于 worktree 的持久归档中；复用现有归档位置解析规则，可显式传 `--archive-root`。安装依赖的 `file:` 地址不得指向将清理的临时目录；归档与安装收据都报告真实路径。
- 新入口是普通安装配置入口，不自动执行整套 L4/L5，也不伪造固定产物验收记录。检查包内容、锁文件、真实安装路径与 bundle 注册；报告功能验证为 `unverified`。
- 内部 `verify-artifacts --manifest ...` 核验固定包及对应证据，不成为外部 install 的前置条件。开发 link 安装不写这些个人默认 patch。
- 在第一笔目标安装前完成所有选中包的模板与 patch 预检。全部选中包安装验证成功后再一次性提交默认配置。
- pnpm/DSH 安装跨多个文件与包，不承诺全事务回滚。中途失败时保留已经完成的包、原用户 patch 和逐包报告；不自动卸载、不删除 link 源码、不回退用户依赖。
- 若包已安装但 patch 提交失败，退出非零并明确标记“安装完成、配置未完成”；保留恢复点，支持修正后重跑。
- 命名空间默认 patch 只有被用户显式接入后才可能生效；命令不启动或重启用户宿主。需要退出或重启时由用户处理，报告不把磁盘写入等同于运行时生效。

#### 避免重复编译和打包

按以下顺序自动判断，不要求用户自行传 `--skip-build`：

| 当前状态 | install 的处理 |
|---|---|
| 当前固定批次与源码、工具链匹配，tarball 完整且哈希正确 | 直接复用 tarball，跳过插件编译和打包 |
| 没有匹配 tarball，但有成功且仍有效的编译记录，输出文件完整且哈希正确 | 复用编译输出，仅执行打包 |
| 源码或工具链变化、编译记录失效、编译失败过、输出缺失或被修改 | 构建一次，再打包一次 |
| 当前批次声称有效，但 tarball 或清单损坏、哈希不符 | 明确报错，不静默安装或以重新打包掩盖异常；可显式 --rebuild 生成新批次 |

- 复用现有 `sourceState`、`dist/build-record.json`、`dist/current.json`、批次 manifest 和 tarball 内容校验；原机制已有源码哈希、构建代次和输出哈希。当前记录尚不足以完整判断工具链匹配，实施时补充 Node、pnpm、TypeScript/esbuild 实际版本、OS/架构及锁文件/构建配置指纹；旧记录缺少新字段时视为不可复用。
- 初期采用现有仓库级源码快照，包含 tracked 与未忽略的 untracked 文件内容、删除记录、commit/dirty 状态及构建代次。源码未提交也可复用，但修改后必须失效。版本号未变而源码、共享库、默认 patch、包清单或锁文件变化时，不能命中旧批次。
- 这是保守的整批复用：文档或 Git 状态变化也可能触发重建；本轮不引入按插件依赖图的增量构建。`--only` 控制安装范围，不改变现有整批构建/打包模型。
- tarball 已命中时，不要求当前 `lib/` 仍存在；安装消费的是校验后的 tarball。只有走“复用编译输出再打包”路径时，才要求 `assertCurrentBuild` 验证成功记录和实际输出。
- 从 `dist/current.json` 指向的已发布批次开始校验，不按 mtime 或文件名挑包，也不遍历历史批次猜测。源码或工具链不匹配属于正常未命中；格式非法、路径越界、内容损坏属于错误。
- 增加 `install --rebuild` 强制重新构建和打包；创建新批次，不改写已有 tarball 或验收报告。正常安装无需此参数。
- 缓存判断、构建、打包和产物选择共享既有锁生命周期；抽取不重复加锁的内部操作，避免编排层调用已加锁命令造成自锁。选定后到安装消费前仍复核源快照、manifest 和包哈希；并发变化时中止，不混用不同代次产物。
- 日志明确输出 `reuse-tarball`、`reuse-build`、`rebuild` 及原因和批次；复用构建产物不等于复用功能验收结论，内部固定包验收仍检查证据匹配。
- 优化范围为新 `install` 的插件构建/打包编排；现有显式 `build`、`pack`、开发测试命令保持原语义。`dev.mjs` / `install.mjs` 共用 `launch.mjs` 编译脚本自身的步骤仍保留，因此“跳过插件编译”不等于本轮同时实现 CLI 自身的增量编译。

### 4.3 接口、配置与使用方式

当前入口职责如下：

| 入口 | 输入与行为 | 验收边界 |
|---|---|---|
| `install.mjs install` | 当前源码 → 复用有效产物或构建打包 → 已有 profile → 命名空间配置 | 不要求功能验收记录，不自动运行 L4/L5/CI |
| `install.mjs status` | 相同目标解析，只读查询；可选 --manifest 比对安装文件 | 不构建、不安装，不等于能力验收 |
| `dev.mjs pack/verify-artifacts/l4/l5` | 内部固定包构建与独立环境验收 | 匹配具体包及报告；不提供外部 stable-install 模式 |

以下为当前可执行入口，需提前准备工具链、冻结依赖及外部 DSH/profile：

```bash
node scripts/install.mjs install --profile my-web
node scripts/install.mjs install --profile my-web --rebuild
node scripts/install.mjs install --profile my-web --only @mbda9091/notify-web
node scripts/install.mjs install --profile custom-web \
  --dsh-cli /path/to/dsh/lib/bin.js --home /path/to/dsh-home
node scripts/install.mjs install --profile my-web --dry-run
node scripts/install.mjs status --profile my-web
```

- `--dry-run` 预览复用/构建及配置计划，不构建、打包或写目标；命中 tarball 时读包内模板，否则读源码模板用于预览。实际安装重新核验并以包内模板为准。宿主版本探测可使用受管临时目录。
- install 不提供 `--all` / `--skip-build`；`--rebuild` 强制新批次。status 不接受安装专属参数，不强制安装专属版本门禁。
- 输出逐包安装状态、配置路径及新增/保留项、归档和报告；配置加载由用户负责，磁盘成功不等于运行时加载或能力通过。
- 无参数或帮助仅显示用法；旧 bootstrap、web、daily-launcher、stable-install 不执行原业务，不自动转发或启动用户服务。

### 4.4 兼容、迁移与回退

- 删除仓库内日常入口与指导，不修改用户已有 home/profile、已部署启动器或 shell alias。任务根目录中的旧 `start-macos-web.sh` 属于仓库外历史产物，本轮不自动删除或维护。
- 开发浏览器、启动超时等设置保留，来源为运行时默认值、参数及支持的环境值，不读取旧本机 JSON。
- `targets` 及 `targets[].patch` 不再参与运行；不创建目标书签，不自动删除旧配置或备份。
- `profiles/web` 中开发模板和其他非日常功能需要的文件保留；只删除明确属于日常启动的说明与调用路径。
- 文档同步更新根 README、AGENTS、Web README、配置协议与开发环境方案中的当前描述；历史实施记录保留并注明由本方案替代。说明显式 profile 与可选覆盖的安装步骤。
- 测试删除或替换被移除的日常入口专属场景；保留共享归档、路径隔离、目标检查与开发测试场景。更新测试 ID/结果数量契约，禁止通过跳过来伪造原 CI 全通过。
- scope 改名覆盖当前三个插件及内部共享包的声明、import、bundle loader name、模板、脚本硬编码、测试 fixture、CATALOG 与锁文件；源码目录与 loader ID 保持不变。旧批次的包名、哈希和报告仍按历史事实保留，新 scope 必须重新构建验证。
- 已有目标和开发环境中的旧 `@local/*` 包、bundle 及个人引用不再检测或拦截，由用户手动清理；命令不自动卸载、搬迁或改写根 patch。
- 配置恢复可使用本次备份；包回退继续使用明确的旧批次与既有交付入口，不新增自动回退。用户独立日常启动不依赖本仓库版本回退。

### 4.5 验证设计

| 验收项 | 对应目标 | 场景与预期行为 | 验证方式 | 覆盖边界 |
|---|---|---|---|---|
| A1 | G1 | 默认帮助；旧日常命令不启动进程；包脚本和文档无有效日常入口 | CLI 契约与引用检查 | 不删除用户已部署文件 |
| A2 | G2 | profile 必填、当前环境及显式覆盖正确解析；不存在 profile、参数缺失、平台不兼容、目标 DSH 版本不匹配均在安装写入前失败（含 dry-run） | L3 / 环境测试 | 使用隔离目标 |
| A3 | G2 | 模板随 tarball 发布，安装只消费相同包中的模板；缺模板、非法模板、哈希变化拒绝 | 打包契约和安装测试 | 不靠源码目录模板代验 |
| A4 | G3 | mbda9091 目录及文件首次生成；同 ID 保留；无配置时生成 []；重复执行字节不变；根 patch 始终不变 | patch 单元测试 | 覆盖注释、!!js、禁用行、复杂冲突及路径逃逸 |
| A5 | G3 | 非法 YAML、并发修改、写入失败、第二包安装失败均非零；原配置保留、报告可恢复 | 故障注入测试 | 不承诺 pnpm 全事务回滚 |
| A6 | G2/G3 | link → tarball、tarball → tarball 后真实文件和锁一致；移走源码后安装依赖不依赖 worktree | 真实临时目标集成测试 | 不改用户日常 profile |
| A7 | G4 | dev-web init/start/status/stop/reset、dev-install 链接与 HMR 维持原行为 | 原开发环境测试回归 | 同名 web、不同 home 的隔离不变 |
| A8 | G4 | install 无验收记录也可安装且不调用 L4/L5/CI；旧 stable-install 不执行业务；内部固定包验收缺少匹配证据仍拒绝 | 编排契约、既有测试入口及新回归 | 日常专属用例移除需列明；Windows/macOS 分别记录 |
| A9 | G2/G3 | macOS Web 与 Windows Web 在 mbda9091 下生成文件；显式 --patch 后组合正确，不传参数时不自动加载；Desktop 目标及显式选择 Desktop 插件均写入前拒绝 | Web 双平台真实隔离 profile 与参数边界测试 | 不启动用户宿主；Windows Desktop 适配和真实验收不适用 |
| A10 | G2/G4 | @mbda9091 包名、默认 patch name、安装过滤、适配器和锁文件一致；旧 @local 包及引用保留且不拦截 | 契约、开发/测试回归与隔离目标安装 | 不自动删除旧包或用户配置 |
| A11 | G2/G4 | 相同输入第二次安装不调用插件编译或 pack；仅缺 tarball 时复用有效编译输出；同版本源码/模板/依赖/工具链变化触发重建；损坏包拒绝；--rebuild 强制新批次 | 编排调用计数、哈希/文件变更及并发故障测试 | 含 lib 缺失但 tarball 有效、旧记录缺字段和 dry-run；不改变显式 build/pack 语义 |

测试报告沿用原 `.tmp`/`dist` 输出体系。实施时记录提交、包哈希、Node/DSH/pnpm 版本和平台；配置文件使用无凭据 fixture。Windows Desktop 不属于本轮新增能力验收对象；原有 Desktop 测试保留，不为此新增真实 Desktop 环境要求。

## 5. 里程碑

保留原阶段拆分；当前入口与职责按后续决定更新，历史双平台结果不由当前 macOS 结果反向补齐。

| 阶段 | 交付内容 | 前置依赖 | 出口条件 | 当前状态与证据 |
|---|---|---|---|---|
| M1 | 删除日常入口，保留公共依赖；更新帮助、包脚本与专属测试 | 本方案范围 | A1 通过；开发测试入口仍完整 | 已实现并验证 |
| M2 | scope 改名、包内默认模板、命名空间配置、新安装编排和失败报告 | M1；复用既有打包与安装原语 | A2–A6、A10/A11；外部安装与内部验收边界明确 | 已实现，主要验证通过 |
| M3 | macOS/Windows Web 回归，文档同步与真实安装验证 | M2 | A7–A9 及全量必要项通过，分别记录平台覆盖 | 历史平台验收未关闭；当前 macOS 完整 CI 已通过，见 §8.2 |

## 6. 决策记录

D1–D9 为原轮次决定；D10/D11 记录已包含的后续调整，冲突处按后续决定执行。

| ID | 决策与理由 | 考虑过的替代方案 | 日期 | 状态与关联 |
|---|---|---|---|---|
| D1 | 删除日常使用职责，保留开发测试 | 继续维护多套启动器，不符合用户要求 | 2026-11-05 | 已定，用户要求；G1/G4 |
| D2 | 新增独立 install 编排，保留现有 stable-install 语义 | 合并入口或增加跳过验收开关会混淆直接安装与严格交付 | 2026-11-05 | 已定，用户明确要求；4.3、9.2 |
| D3 | 模板随 tarball 交付，在命名空间文件按 ID 只补缺行 | 复制 bundle patch 会重复 insert；覆盖已有 config 会改变用户行为 | 2026-11-05 | 已实现；4.2 |
| D4 | 原提案：默认 patch 直接进入 profile 根用户层 | 原目标为自动读取 | 2026-11-05 | 已被 D7 替代；见 9.1 |
| D7 | scope 改为 @mbda9091/，默认 patch 存在 profile/mbda9091/，不改根 patch | 用户明确要求按前缀独立存放；加载由用户负责 | 2026-11-05 | 命名与目录已定，用户要求；加载边界见 4.2 |
| D5 | 新入口验证安装与配置，不要求功能验收记录、不自动执行完整功能验收 | 自动串联全量 L4/L5 会放大普通安装成本，且当前 Desktop 验收覆盖不同 | 2026-11-05 | 已定，直接安装职责；严格交付入口保留 |
| D6 | 必须显式指定已有目标，归档脱离 worktree | 默认猜测日常环境或保存临时 tarball 会产生错误目的地或悬空依赖 | 2026-11-05 | 已实现；4.2/4.3 |
| D8 | install 自动复用与当前输入匹配的 tarball，其次复用编译输出；只重做必要阶段 | 每次重新编译打包浪费时间；仅按版本号复用无法识别同版本源码变化 | 2026-11-05 | 已定，用户要求；4.2、A11 |
| D9 | 保留 YAML 对 !!js 与复杂注释的处理要求；本轮新增安装能力不适配 Windows Desktop | 不扩展 Desktop 安装、配置接入及真实宿主验收 | 2026-11-05 | 已定，用户要求；Q1 已通过本轮 fixture 验证，Q2 关闭 |
| D10 | 外部仅 install/status；profile 必填，其余按当前环境解析；移除 target/config/stable-install 运行路径 | 简化开发与外部安装边界，固定包验收归内部 | 2026-11-07 | 已实现：fafaab2 / a5210df，见 §9.9 |
| D11 | 通知生成配置仅四项用户选项；安装不申请权限，Client 按既有流程申请 | 通道参数保留运行时默认值 | 2026-11-06 | 已实现：b554760，模板与测试一致 |

## 7. 风险与开放问题

### 7.1 风险

| ID | 风险与触发条件 | 影响 | 应对与验证办法 | 当前状态 |
|---|---|---|---|---|
| R1 | 新模板与运行时默认值漂移 | 安装前后行为不一致 | 契约校验、模板随包版本化；A3 | 已有专项/回归证据，见 §8；本次未新增实测 |
| R2 | YAML 标签、注释或嵌套结构被重写 | 用户配置损坏 | 保留原文、只追加安全行；复杂冲突拒绝；A4/A5 | 已有专项/回归证据，见 §8；本次未新增实测 |
| R3 | 安装已成功但配置写入失败 | 仅部分完成 | 阶段报告、非零退出、重跑补配置；A5 | 已有专项/回归证据，见 §8；本次未新增实测 |
| R4 | 删除 daily 文件时误删公共归档/隔离逻辑 | 正式安装或测试退化 | 先查引用，保留公共原语；A6/A8 | 已有专项/回归证据，见 §8；本次未新增实测 |
| R5 | 新目录不自动加载，显式 --patch 后优先级又高于根配置 | 文件未生效或覆盖用户同 ID 配置 | 明确提示用户接入方式及层序；A9 | 已识别 |
| R7 | 旧 @local 和新 @mbda9091 同时安装，仍使用同一 loader ID | 重复注册或 name 校验失败 | 用户明确选择手动清理；命令不做旧 scope 预检、不自动卸载；A10 | 已接受此边界 |
| R6 | 原 CI 依赖日常专项测试 ID 或计数 | 表面通过但缺少必要测试 | 更新清单与结果契约，记录删除范围；A8 | 已有专项/回归证据，见 §8；本次未新增实测 |

### 7.2 开放问题

| ID | 尚待回答的问题 | 影响的决定或阶段 | 解决方式与时点 | 当前结论 |
|---|---|---|---|---|
| Q1 | YAML 库能否在现有 fixture 中可靠保留 !!js 与复杂注释 | M2 写入实现 | 只针对 mbda9091 文件完成 A4 原型；根 patch 完全不改；无法无损处理的结构拒绝修改，禁止降级重写 | 已验证 !!js、CRLF 和复杂注释原文保留；不支持的结构拒绝修改 |
| Q2 | Windows Desktop 真实安装验证环境是否可用 | 已不影响本轮 | 用户排除 Windows Desktop 适配，撤回新增环境要求 | 已关闭：本轮不适用；见 D9、9.4 |

## 8. 验收状态

### 8.1 原轮次历史验收

> 截至：2026-11-06。下表保留本机专项证据；远端 CI 按提交分别记录，最新状态见 §9.8。

| 验收项 | 实现状态 | 验收结果 | 证据与日期 | 尚未覆盖或失败原因 |
|---|---|---|---|---|
| A1：移除日常入口 | 已实现 | 通过 | node-entrypoints / fast 环境测试 | 无 |
| A2：目标与选择 | 已实现 | 单测通过 | profile-install / target-environment | Windows Web 未实机验证 |
| A3：tarball 模板契约 | 已实现 | 通过 | profile-install / profile-patch，真实安装 | 无 |
| A4：默认配置与幂等 | 已实现 | 通过 | profile-patch；真实重复安装原文哈希一致 | 无 |
| A5：失败与并发 | 已实现 | 单测及真实部分失败场景通过 | profile-patch、artifact-install、TGT-06-real | 无全量事务回滚 |
| A6：真实 tarball 安装 | 已实现 | macOS 通过 | run-4LA0dg / run-JAmpXz | 独立宿主 TGT-04/05 定向重跑通过 |
| A7：开发流程回归 | 保持 | 通过 | fast、DEV-03、L4；双平台 CI 见 §9.8 | 个人日常环境不由 CI 代验 |
| A8：测试与严格交付回归 | 已实现 | 部分通过 | L1–L3、fast、L4/L5、ART 重试通过 | TGT-04 / TGT-05-real 定向重跑通过；后续远端完整回归见 §9.8 |
| A9：平台安装配置与显式加载 | 已实现 | macOS 通过 | 真实 --patch dump-config 保留用户 false 值 | Windows Web 未执行；Desktop 不适用 |
| A10：scope 改名与手动清理 | 已实现 | 通过 | 包契约及 profile-install 保留旧包回归 | 不自动迁移旧 profile |
| A11：构建与打包复用 | 已实现 | 通过 | install-cache；真实重复安装 reuse-tarball | bootstrap 自身编译保留 |

历史验收结论（2026-11-06）：代码已落地，本机专项及 4355362 的双平台完整 CI 已通过；7e6e72c 的 Windows CI 已通过，macOS 尚未全部完成。不能以既有基线替代最终 PR head；个人环境接入和原生能力不由自动化结果代验。

### 8.2 当前实现与证据（2026-11-07）

- 当前 macOS 完整 CI 汇总 `.tmp/ci/run-4xMM9a/report.json` 为 `ok: true`；环境 all 42 项，类型检查、L1–L3、L4、L5 全阶段成功。基线为 `4049f6f`，与当前源码核对基线的 scripts/test/packages、package.json、pnpm-lock.yaml 无差异。
- A1–A8、A10/A11 对应的现行入口、配置、缓存及内部验收机制已有自动化回归证据；此处不将新机制测试算作旧 target/stable-install 的验收。
- A9 显式加载与用户值保留有 §9.5 的 macOS 历史专项结果；本次未重新操作个人 profile，不把通知人工确认扩大为所有配置接入组合通过。
- Windows/Linux 仍沿用后续轮次的暂缓边界；真实 DSH 沙箱已按本次用户要求执行，结果见 §8.3。本次未查询最新远端 Actions；原 PR 的排队状态只保留为历史，不代表当前仍在运行。
- Desktop 新安装适配本来就不在本轮范围，不列为待办。旧 @local 包仍由用户自行管理。

当前核心功能没有新增实施欠项。原轮次 A1–A11 的完整平台验收与整体完成状态仍需收尾，不以当前 macOS 报告追认全部历史出口通过。

### 8.3 真实 DSH 沙箱实测（2026-11-07）

环境：macOS arm64、普通 Node `v24.16.0`、DSH `0.2.2-rc.1`、pnpm `11.28.5`，当前会话文件策略为 `workspace-write`，全程未提权。使用既有依赖和系统包管理配置，不新增 store 覆盖，不代表冷启动冻结安装已通过。主仓库基线为 `a88d7ac5e8ecc288ab22242592feca00df2d2a1b`；直接安装使用其当前源码副本（无 Git 元数据），180 个代码/配置文件字节一致，见[核对记录](<../.tmp/sandbox-scope-20261107-1821/evidence-check.json>)。

| 验证 | 结果 | 证据与边界 |
|---|---|---|
| dev/install 无参数帮助；build --check | 通过，退出 0 | [命令退出记录](<../.tmp/sandbox-scope-20261107-1821/exits.tsv>)；包含场景、目录与真实类型检查 |
| fast 环境测试 | 通过，28/28 | [环境报告](<../.tmp/environment-tests/run-ELFwVO/report.json>)；含入口分离、目标解析、隔离和失败路径 |
| build + L1–L3 | 通过，230 通过、0 失败、1 平台跳过 | [测试日志](<../.tmp/sandbox-scope-20261107-1821/scripts_dev.mjs_test.log>)；Windows launcher 用例跳过，不算 Windows 验收 |
| L4 真实临时 Web | 通过，退出 0 | [L4 报告](<../.tmp/l4/run-dRWfEq/report.json>)；link/tarball、HTTP 200、SSE sync、平台不匹配拒绝均通过；`--keep` 保留现场 |
| 外部 DSH 自动发现、独立 profile 初始化、install dry-run | 通过 | [首轮探针记录](<../.tmp/sandbox-scope-20261107-1821/direct-report.json>)；dry-run 根配置和 profile manifest 哈希不变，不生成命名空间目录 |
| 首次直接安装及再次安装 | **未达到通过条件**：均退出 1 / needs-attention | [首次交付报告](<../.tmp/sandbox-scope-20261107-1821/checkout/dist/consumption/run-N49YTF/report.json>)、[重复交付报告](<../.tmp/sandbox-scope-20261107-1821/checkout/dist/consumption/run-baxKst/report.json>)；选中包均为 installed、bundle registered，配置已生成，但 warnings 非空 |
| 重复安装缓存、用户值与根配置保留、status、显式配置组合 | 通过（独立断言，不提升安装总状态） | [后续断言记录](<../.tmp/sandbox-scope-20261107-1821/direct-followup-report.json>)；第二次 reuse-tarball、无 pack；手改 false 和注释逐字保留；根 patch 不变；status 退出 0；不传 --patch 为 true，显式加载为 false |

关键发现：pnpm 报告默认系统 store 无法向该项目硬链接，自动使用工作区 `.pnpm-store/v11`。add/update 都完成，但安装器收集到警告，按现行规则返回 needs-attention / 1。首轮日志没有给出底层 errno；19:20 的追加定位已确认系统 pnpm 目录下的临时探测目录创建被拒绝（mkdir EPERM），pnpm 将该探测失败统一表现为硬链接不可用，详见 §9.11。没有通过提权、修改 store 或忽略警告将其变成“通过”。L4 的通过不等价于直接安装的无警告出口通过。

覆盖边界：外部 home、归档、日志均是源码副本同级的隔离 fixture，位于会话可写工作区，不涉及真实日常 profile；“external”表示相对该源码副本隔离，不声称验收了工作区外用户目录写权限。未执行 L5、完整 real/CI、Windows/Linux、冷启动依赖安装、个人原生通知或源码移走场景。保留临时 home 与归档供回读；不可只删除仍被 fixture profile 引用的归档。

## 9. 实施结果与修正

实施结果见 9.5；9.1–9.4 保留方案演变历史。2026-11-05 完成当前 CLI、开发环境初始化、tarball 安装、产物门禁及插件默认配置的源码核对，形成 v0.1 草案；未修改运行代码、用户 profile 或日常入口。

### 9.1 命名空间与配置目录修正（2026-11-05）

- 用户明确要求将插件前缀从 `@local/` 改为 `@mbda9091/`，默认 patch 在 profile 下的 `mbda9091/` 目录生成。
- 已修正文首、目标、命名范围、配置写入规则、示例、兼容策略、决策和验收场景；撤回 v0.1 的根 patch 写入方案（D4），替换为 D7。
- 核对 DSH `readProfilePatches` 后确认子目录不会自动加载。文档明确用户显式加载、优先级变化及 Desktop 边界。
- 本轮仅修改方案；包名前缀、插件代码、用户文件均未实际变更，功能验收未执行。

### 9.2 确定独立直接安装入口（2026-11-05）

- 用户明确选择直接安装命令，与 `stable-install` 分开；D2、D5 从提议更新为已定。
- `install` 构建并安装当前插件 tarball，生成命名空间默认配置；保留安装必要检查，不自动执行功能验收。
- `stable-install` 继续要求指定批次的匹配验收记录，不新增自动打包或跳过验收分支。
- 已补充入口对照与 A8 的两条流程边界回归。本次仅更新方案，尚未实现或执行功能测试。

### 9.3 增加自动产物复用（2026-11-05）

- 用户要求已有最新产物时直接复用，避免重复编译和打包；撤回每次 install 必须重新构建的原提案。
- 核对现有源码快照、构建记录、current 批次指针与哈希校验，确定“复用 tarball → 复用编译输出只打包 → 重新构建打包”的分级策略。
- 增补工具链指纹、强制重建选项、失败/并发处理和 A11 回归；旧记录字段不足时不能误判可复用。
- 仅更新方案，尚未实现，未测量耗时；CLI bootstrap 自身编译不属于本次插件产物复用优化。

### 9.4 保留 YAML 要求并收敛平台范围（2026-11-05）

- 用户要求保留 YAML 库对现有 fixture 中 !!js 与复杂注释的可靠保留要求；Q1 及 A4 原型验证继续保留，尚未验证通过。
- 用户明确不适配 Windows Desktop。更正此前新增安装能力覆盖 Desktop、生成 Desktop 默认配置及要求真实 Desktop 环境的提案，当前范围调整为 macOS/Windows Web。Q2 关闭为本轮不适用。
- Desktop 插件包名仍随仓库统一改为 @mbda9091/，已有源码、构建和测试不删除；不为新入口新增 Desktop 模板或运行适配。
- 本轮仅更新方案，未修改实现或用户环境。

### 9.5 实现与本轮验证（2026-11-05）

- 删除默认日常启动、web 和 daily-launcher 入口及其专属包/测试，保留公共归档和开发测试能力；默认命令显示帮助。
- 自有包统一使用 @mbda9091；Web 插件随包携带默认模板，独立 install 安装后写入 profile 的 mbda9091/cordis.patch.yml。根 patch 不写入；不会自动启动或加载。
- 默认配置采用 YAML AST 校验、原文追加：保留已有行、!!js、复杂注释、CRLF；只补缺失行。新增备份、并发变更检测和逐阶段报告。
- 实现源码/工具链/内容校验及 reuse-tarball、reuse-build、rebuild 分级选择；stable-install 保持原验收门禁。
- 类型检查通过；L1–L3 共 279 项，277 通过、2 项平台跳过、0 失败。fast 全部通过；L4、L5 全部通过。
- 在任务目录下独立临时 clean-home 做真实直接安装及重复安装，均成功；重复输出 reuse-tarball。手改配置为 false 后再次安装，根 patch 和命名空间 patch 的哈希均不变，显式 --patch 的 dump-config 确认生效。没有修改用户日常 profile。
- real 全套已结束：11 通过、4 失败。ART-04-real / ART-06 因首轮未提供测试浏览器路径失败，补充 Chrome 路径后两项均通过。TGT-04 / TGT-05-real 仍超时；未确认根因，不通过放宽超时掩盖。TGT-06-real 的部分失败交付与 TOOL-04 冷启动冻结安装通过。
- 证据：fast .tmp/environment-tests/run-PgwClU/report.json；real 首轮 run-21sl5z/report.json、浏览器重试 run-fvfd12/report.json（同一 environment-tests 目录）；L4 .tmp/l4/run-K7nsCF/report.json；L5 .tmp/l5/run-hfSVYe/report.json；直接安装 dist/consumption/run-4LA0dg/report.json 和 run-JAmpXz/report.json。这些生成目录可清理，关键结果另存任务根目录验收记录。
- Windows Web 缺少当前实机环境，未执行；不将 macOS 结果视作 Windows 通过。使用步骤见 [指定 profile 安装](profile-install.md)。

### 9.6 超时用例定向重跑（2026-11-06）

TGT-04 / TGT-05-real 均通过，退出码 0，耗时分别为 605.2 秒、78.9 秒。报告为 .tmp/environment-tests/run-WETU67/report.json，并复制至任务根目录 profile-install-acceptance/real-target-retry.json。本次没有改代码或超时门槛；观察到同步读取宿主普通文件出现秒级延迟，具体系统原因未确认。历史失败报告保留，Windows Web 仍未覆盖，未重跑完整 CI。

### 9.7 CR 修正与审批插件移除（2026-11-06）

- YAML 追加只在缺少行结束符时补换行，追加后校验原行解析值完整保留。保留 `|+` / `>+` 的尾部换行语义；无法无损追加时拒绝写入。增加 CRLF、文档结束标记、无末尾换行和重复追加回归。
- 移除审批插件及专属 CLI、持久授权、管理工具、模板、探针与测试；当前默认 Web 安装仅选择 notify-web。L4 link/tarball 测试统一使用 notify-web，通用缺能力适配器拒绝机制保留。
- 历史验收记录保留，不能替代本次改动验证。用户已有 profile 和授权文件未修改。
- 本次 macOS 验证：build --check 通过；L1–L3 226 通过、1 平台跳过；fast 28 项通过（.tmp/environment-tests/run-2pkLkD/report.json）；L4 通过（.tmp/l4/run-poel4q/report.json）；L5 默认 fixture 通过（.tmp/l5/run-TwiySH/report.json）。Windows 与完整 real/CI 未重跑。

### 9.8 合入前文档与版本门禁同步（2026-11-06）

2026-11-06 合入前核对：`4355362` 的 [Windows/macOS CI 六项全部通过](https://github.com/mbda9091/dsh-plugin/actions/runs/42063036525)。新增版本检查的 `7e6e72c` 本机 macOS 类型检查、L1–L3（226 通过、1 跳过）、fast 28 项与 L4 通过；其 [远端 CI](https://github.com/mbda9091/dsh-plugin/actions/runs/42068198590) Windows 三项通过，macOS 三项在本次核对时尚未全部完成（排队/运行中）。后续提交须以自身检查结果为准。Web 自动化不替代真实 Desktop、原生系统通知及个人日常 profile 验收。

- 取消安装与开发初始化中的旧 scope 拦截，由用户手动处理旧插件。正文兼容策略、A10 和风险处置同步更新。
- 直接 install 的预览和实际入口均检查精确宿主版本，交付前复核；stable-install 仍保留独立验收记录门禁。
- 保留 §9.6 已有的本机超时定向重跑证据，不将历史失败改写为成功。

### 9.9 当前代码与后续决定对账（2026-11-07）

本次根据用户要求更新文档，未修改运行时代码或用户环境，未执行新的构建/安装/测试，也不自动提交或归档。

| 提交 | 作用 |
|---|---|
| `be2043ef973eb78d0d79c613c1f97a3e92a9ef16` | 原建设及修正的主分支落点；不据合并 SHA 推断每项历史实测版本 |
| `b5547603c8cdcba59e5ac975abf53d42604ef05c` | 通知生成配置简化为四项，通道参数使用运行时默认值 |
| `7011a6b53a65b62254dc5ad21a16611f88500d41` | 升级宿主至 0.2.2-rc.1 |
| `fafaab2838b9d796f997d5d1e7d9e134aea45b5b` | 开发/安装入口分离，移除本机配置、命名目标及外部严格安装模式 |
| `a5210df82747f491cdfe583dd8a15a781e3d914e` | 合并保留 Linux Web 支持，适配新入口 |
| `4049f6fa5e57802c64ff0b6fd5cee9bfa99d42a9` | 真实 CI 包管理环境修正，当前 macOS 完整 CI 对账基线 |

核对源码：install-cli/install-target 的参数和环境解析、profile-install 的缓存及预检、profile-patch 的包内模板/保留/备份/并发/原子写入、install-artifacts 的逐包报告。模板与 profile-patch 测试均只列四项通知配置。功能已落地，不恢复后续已明确取消的机制。

证据：回读 `.tmp/ci/run-4xMM9a/report.json`，全部阶段退出 0；关联环境 `.tmp/environment-tests/run-WIbK9J/report.json`、L4 `.tmp/l4/run-tlthhX/report.json`、L5 `.tmp/l5/run-vmTlwO/report.json`。这些是本地已有证据，可随清理失效；本次文档修改不代表生成或验收了新 tarball。

本次同步当前入口、默认模板、权限边界、平台声明、阶段说明、风险和待办；保留 §8.1、§9.1–§9.8 的历史成功、失败及未执行记录。源码核对基线 `a88d7ac5e8ecc288ab22242592feca00df2d2a1b` 与上述验收基线的相关代码无差异，未查远端最新运行。

### 9.10 真实沙箱验证补录（2026-11-07）

- 根据用户“验证下真实 dsh 沙箱环境”的要求执行 §8.3，不修改产品代码，也不把验收自动扩大为修复授权。实现 commit 不变；文档与忽略目录中的探针、日志未提交。
- 首轮顺序执行两入口帮助、类型检查、fast、完整构建及 L1–L3；随后执行真实 L4。全部命令退出 0。L4 临时 Web 由 harness 退出并关闭已知端口，未替换或重启当前 GUI。
- 直接安装以当前普通 Node 的全局 DSH 自动发现结果运行，不传 `--dsh-cli`；独立源码副本沿用已准备依赖，home 和归档与副本互相隔离。首次构建打包批次 `8c1fb739-6c70-4a9d-914e-aadd12c92fab`，notify-web tarball SHA-256 为 `26a96eda23afd2c1f798f9509f78351d03980c6dc5b5a3483ec983b32f8243ba`。
- 首轮探针按退出 0 断言，因此在安装命令返回 1 时失败并保存原始记录。回读交付报告确认包和配置已经落盘，再运行独立后续探针检查重复安装与组合语义；保留两次安装的退出 1，不覆盖首次失败。后续断言通过不是安装整体验收通过。
- 安装报告与持久收据一致；配置路径、包实际路径与 file: 归档地址已核对。第二次复用同一 tarball，不重新构建或 pack；不传显式 patch 不加载子目录，传入后用户 false 值生效。
- 新增待核实项为系统 store 硬链接失败及回退警告。当前实现将任何捕获警告置为 needs-attention 并退出 1，见[安装状态判定](<../scripts/src/commands/install-artifacts.ts#L183-L197>)。是否调整策略属于后续决定；本次不修改 store 配置、不降低成功门槛。

### 9.11 store 回退根因定位（2026-11-07 19:20，Asia/Shanghai）

用户要求继续定位。未修改产品代码、pnpm 本体、包管理配置或权限；只对 `pnpm store path` 使用观察型 Node preload，记录原 `fs.promises.mkdir/link` 的参数、调用栈、返回值与错误，原调用和异常均原样透传。没有重新安装插件，也没有重试被拒绝的文件操作来绕过沙箱。

**因果链已确认：**

1. pnpm 11.28.5 默认 store 解析调用 `storePathRelativeToHome → canLinkToSubdir`，首先尝试在系统 pnpm home 下创建 `_tmp_*` 目录；这一步返回 **`EPERM`，syscall 为 `mkdir`**，还未执行该目录内的硬链接。见[原始跟踪第 2 行](<../.tmp/sandbox-scope-20261107-1821/store-fs-trace.jsonl#L2>)。
2. `canLinkToSubdir` 的 catch 将任意错误转换为 false；随后 `rootLinkTarget` 自文件系统根逐级寻找可硬链接位置。工作区外 link 返回 EPERM，工作区根内 link 成功，最终解析出工作区 `.pnpm-store/v11`。见[跟踪第 3–10 行](<../.tmp/sandbox-scope-20261107-1821/store-fs-trace.jsonl#L3-L10>)和[store path 输出](<../.tmp/sandbox-scope-20261107-1821/store-path.out>)。源码位置：本机 pnpm 11.28.5 的 `dist/pnpm.mjs`，189532–189580、189252–189300。
3. pnpm 的 `warnIfHomeStoreIsBypassed` 只检查“默认 store 存在但未选用”，不保留最初失败原因，统一输出 `packages cannot be hard linked`（同文件 197175–197184）。因此该文案不能等同于 EXDEV 或真正执行硬链接后失败。
4. [文件系统核对](<../.tmp/sandbox-scope-20261107-1821/store-filesystems.json>)确认系统 pnpm 目录、store 与工作区均为设备号 `16777234`、当前 UID `501` 所有、权限 `755`；`ls -ldeO` 未列出 ACL 或不可变 flag。实际失败边界与当前 workspace-write 可写范围一致，定位为沙箱外写入探测受限，**不是跨盘 EXDEV**。未执行提权 A/B，对扩大权限后的完整安装仍不宣称已验证。
5. 仓库[诊断收集](<../scripts/src/commands/install-artifacts.ts#L53-L57>)把 WARN 行纳入 warnings；add/update 本身均成功，包内容与锁等验证也完成；最终[状态判定](<../scripts/src/commands/install-artifacts.ts#L183-L197>)因 warnings 非空置 needs-attention 并返回 1。这是“磁盘安装已完成，但命令非零”的直接原因，不是插件构建或默认配置实现失败。

**为何 L4 仍通过：** L4 的[安装日志](<../.tmp/l4/run-dRWfEq/logs/install-tarball.out.log#L1>)也有相同警告；[runDsh](<../scripts/src/core/web-harness.ts#L64-L72>)主要按子进程退出码判定安装步骤，再由 L4 验证行、Web 与 SSE，不使用直接安装器的 warnings 汇总门禁。因此两者并非环境不同，而是成功条件不同，不能以 L4 通过证明无警告或系统 store 已实际复用。

**建议与未执行边界：**

- 保持仓库“系统包管理环境不重定向”的约定，安装及依赖写入应在普通终端运行，或在明确审批后给予本次操作所需权限；其无警告结果仍需另行验证。
- 不建议自动强制仓库 store、删除旧 store/ACL、修改 pnpm 探测逻辑或直接忽略所有警告。显式 `storeDir` 虽会绕过自动选址，但不授予目录写权限，并可能让原先回退成功变为硬失败。
- 若后续要优化脚本，优先区分包管理警告与宿主加载失败，并在控制台明确“包/配置已完成、具体警告、报告位置”，是否允许 installed-with-warnings 返回 0 应独立决定并增加测试。本次只定位，不改变当前验收规则。

## 10. 当前未完成事项与下一步

| 事项 | 当前状态 | 下一步或启动条件 |
|---|---|---|
| 直接安装、命名空间配置、缓存、归档与报告 | 已实现，当前 macOS 完整 CI 有证据 | 无新增核心实施待办；相关代码变化时再回归 |
| 原轮次整体完成与验收范围对账 | 尚未关闭；历史双平台出口不以当前 macOS 追认 | 收尾完成状态与范围，再决定是否归档；本次新增沙箱实测不等于完整平台关闭 |
| 当前 Windows/Linux | 后续轮次暂缓；本次未验证 | 需要相应环境交付时执行必要检查，不把旧 Windows 结果记为当前全部通过 |
| 真实 DSH workspace-write 沙箱 | 基础回归和 L4 通过；直接安装两次均 needs-attention / 1；根因已定位 | 系统 pnpm 目录创建探测子目录被拒绝（mkdir EPERM），触发回退警告与脚本非零门禁；普通终端或明确审批后的无警告复验未执行，见 §9.11 |
| Windows 个人 Web 配置接入 | 按需人工验证 | 验证命名空间 patch 显式加载、用户值保留与实际使用；不以 Web 通知确认代替配置全流程 |
| 原 PR head CI / TGT 超时 | 历史记录保留，不再作为当前排队或故障待办 | 当前 macOS 完整 CI 已成功；如需复核旧轮次，按原 SHA/运行记录追溯 |
| Desktop 安装适配；旧 target/config/stable-install；日常启动器 | 不属于当前建设范围或已明确取消 | 不为关闭本文恢复这些功能，不修改用户日常环境 |

本次更新尚未提交。没有发现新的核心能力缺失；沙箱外 pnpm 探测写入被拒绝、store 回退警告和脚本非零出口的因果链已定位。尚未进行扩大权限复验或警告策略调整，不据磁盘交付成功关闭本轮完整验收。
