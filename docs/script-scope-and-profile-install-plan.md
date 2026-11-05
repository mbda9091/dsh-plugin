# 脚本职责收敛与 Profile 一键安装配置方案（v0.6）

> 状态：代码已实现；macOS 主要验证通过，完整平台验收未完成。
> 更新日期：2026-11-05（Asia/Shanghai）。
> 当前结论：删除仓库负责的日常启动入口；确定新增独立的直接安装命令 `install`，负责当前插件打包、安装到指定 profile、生成默认配置，不执行完整功能验收。`stable-install` 继续独立承担已验收产物的严格安装。新增安装能力仅覆盖 macOS/Windows Web，不适配 Windows Desktop；保留 YAML 的 !!js 与复杂注释处理要求。开发与测试流程保持不变。实现与验证结果见第 8、9 节。
> 验收基线：源码 `10e42df0ac08360cc6d31177795d40dd33b30639`；调研开始时 Git 工作区干净；本轮实现与验证结果见第 8、9 节。
> 关联文档：[模板](plan-template.md)、[配置协议](configuration-v2.md)、[开发环境方案](development-environment-plan.md)、[插件概念](dsh-concepts.md)、[平台声明](plugin-targets.md)。本文实施后替代关联文档中的日常启动职责描述，不替代开发、测试和严格产物交付约定。

> 2026-11-06 后续决定：按用户要求取消旧 `@local/` 包及引用的拦截，由用户手动清理；此决定替代本文旧 scope 冲突预检相关设计及历史验收结论。直接 `install`（含 dry-run）新增目标 DSH 精确版本检查，要求匹配根 `package.json` 声明，实际交付前再次核验；严格交付仍匹配验收记录。

## 1. 结论摘要

- **要解决的问题**：仓库同时承担日常启动、开发调试、测试和交付，入口职责混杂；安装插件后仍需手工准备 profile 配置。
- **采用的方案**：删除 `web`、无参数自动启动和 `daily-launcher`；新增 `install`，对当前插件生成 tarball、安装到显式目标，将插件包名前缀从 `@local/` 改为 `@mbda9091/`，并在该 profile 的 `mbda9091/cordis.patch.yml` 生成随包默认配置，不修改根目录的 `cordis.patch.yml`。
- **配置策略**：命名空间目录内缺失的插件配置行首次写入；该文件已有同 ID 行完整保留，profile 根 patch 始终不改。升级不自动覆盖用户配置，不创建审批授权规则，不修改模型、账号或全局 home 配置。
- **产物策略**：优先复用与当前源码及工具链匹配、内容校验通过的 tarball；没有可复用包时，再判断是否可复用编译输出，仅执行缺失的构建或打包阶段。不能仅凭版本号或文件时间判断“最新”。
- **本轮边界**：保留 `dev-web`、`dev-install`、构建、打包、测试、CI、目标登记、状态查询和现有 `stable-install`。日常启动、停止、重启、浏览器和服务托管均交还用户。
- **当前进展**：日常入口删除、插件 scope 改名、配置子目录布局，以及独立提供直接安装命令已由用户确定；独立 install、配置协议和分级产物复用已实现；真实环境回归仍有两项超时，Windows Web 尚未验证。
- **下一步**：按 M1–M3 实施，验证默认配置写入与原开发测试链路均符合预期。

## 2. 范围

### 2.1 目标

- G1：仓库不再提供或部署日常启动入口，无参数调用仅显示帮助。
- G2：用户用一条命令，将当前仓库中适用的插件以 tarball 形式安装到指定的已有 profile，同时在 `<profile>/mbda9091/cordis.patch.yml` 获得默认配置文件；由用户在日常启动中显式加载。
- G3：已有个人配置不被默认值覆盖；重复安装可安全执行，失败能看出安装和配置分别完成到哪一步。
- G4：开发 profile 仍为 `<repo>/.local/dsh-dev/home/profiles/web`；测试仍使用 `.tmp` 下各次运行独立的 `web` profile；既有开发与测试操作方式保持不变。

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

- 新安装入口按各插件 `dsh.targets` 筛选，本轮仅覆盖 Web/macOS、Web/Windows；不适配 Windows Desktop。已有 Desktop 插件仍保留源码、构建和原测试，不因本轮范围收敛而删除。
- `install` 验证安装文件、bundle 和配置落盘，不宣称插件实际通知或审批行为已通过验收。
- `stable-install` 保留既有固定产物验收门禁；原有平台约束与验收覆盖保持不变，不扩展 Desktop 能力。
- 完成定义：A1–A11 必要项通过，并分别记录 macOS Web 与 Windows Web 结果；必要的 Web 平台验证未完成时保持待验收，Windows Desktop 不计入本轮欠项。

## 3. 现状与问题

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
- 已确认约束：仅 profile 名不足以定位环境，必须明确 home 与宿主；Desktop 的运行状态和实际效果不能通过 Web 启动方式代验。
- 现有本机日常 profile 中包含 link 安装；新入口执行后选中插件应成为实际 tarball 安装，而不只修改 manifest 字符串。

## 4. 具体方案

### 4.1 总体设计与职责

拟新增流程：

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
| `scripts/src/cli.ts`、根 `package.json` | 命令分发 | 删除 `web`、`daily-launcher`；默认帮助；拟新增 `install` 和 `pnpm install-plugins` 快捷脚本，避免与依赖安装 `pnpm install` 混淆 |
| `commands/daily-web.ts`、`commands/daily-launcher.ts`、`packages/daily-launcher/` | 日常启动与启动器交付 | 删除；同步清理专属测试、文档、workspace/锁文件中的对应引用 |
| `commands/profile-install.ts`（拟新增） | 当前源码到 profile 的一键编排 | 目标预检、pack、tarball 安装、默认 patch 写入、报告 |
| `core/profile-patch.ts`（拟新增） | 默认 patch 验证与命名空间配置文件写入 | 解析、冲突检查、只补命名空间文件缺失行、备份、并发检查与原子写入 |
| Web 插件 `profile.defaults.patch.yml`（拟新增） | 可安装的配置默认值 | 随 tarball 发布，声明在包内文件清单及仓库专用元数据中 |
| 既有 tarball 安装底层 | add/update、包内容与依赖校验 | 抽取公共原语，供新入口和 `stable-install` 复用；严格门禁继续留在后者入口 |
| `target` / `status` / `config` | 安装目的地配置与只读检查 | 保留；target 表示安装目的地，不负责用户进程生命周期 |
| `dev-web`、`dev-install`、L1–L5、CI | 开发与测试 | 保留环境、默认行为和调用方式 |

删除日常专属实现前按引用检查公共依赖：`daily-archive` 中产物持久归档、收据，以及 `daily-contract` 中被正式安装复用的路径检查继续保留，不按文件名前缀整批删除。可移除只服务启动器的逻辑，但不强制重命名公共文件。

### 4.2 关键行为与异常路径

#### 目标与插件选择

1. 要求 `--target NAME`，或者完整的 `--dsh-cli / --home / --profile / --surface / --platform` 参数组；不默认安装到 `macos-web`，不从日常环境变量推断目的地。
2. profile 必须已有 `package.json` 且可解析；目录不存在时在写入前失败，提示用户自行准备。拒绝将新入口指向受管开发或测试目录。
3. 默认安装当前仓库中与目标兼容的全部插件；`--only` 为精确包名子集，未知、重复或不兼容名称均在安装前报错。没有适用插件时明确失败，不输出成功。
4. 新 install 仅接受 surface=web；显式选择 Desktop 目标时在构建、打包或目标写入前报不支持。默认筛选跳过 Desktop 专属插件，--only 指定这些插件时失败。沿用宿主和平台检查，不能在 macOS 上将 Windows Web 目标标记为已验证。

#### 默认配置来源与格式

- 本轮适用的 Web 插件新增 `profile.defaults.patch.yml`，使用针对已有 loader 行的 `id` / `name` / `config`，不允许 `insert`、跨插件行或强制 `disabled: false`。
- 拟在插件 `package.json` 增加仓库专用字段 `dshPlugin.profileDefaults: "./profile.defaults.patch.yml"`；不扩展 DSH 自身协议。将该文件加入 `files`，校验包内相对路径不得越界。
- 安装阶段从本次 tarball 读取模板，不能安装 A 版本的包却使用工作区 B 版本模板。模板参与既有产物内容及哈希校验。
- 默认文件仅使用普通 YAML 数据，不执行表达式。现有用户 patch 中的 `!!js` 等内容须原样保留，不能通过不支持标签的解析后序列化破坏它。
- 模板以当前插件运行时默认值为准；构建/契约测试验证二者一致。无配置插件提供空数组模板，并报告 `not-needed`。

| 插件 | 拟提供的默认 patch |
|---|---|
| `notify-web` | 当前 `DEFAULTS` 的通知开关、300ms 审批延迟、SSE 心跳、重放窗口和队列上限；不自动申请浏览器通知权限 |
| `desktop-notify` | Desktop 专属，本轮不新增默认文件；原 bundle 默认值、代码与测试保留 |
| `app-restart` | Desktop 专属，本轮不新增默认文件；代码与测试保留 |

例如拟新增 `notify-web` 默认文件包含：

```yaml
- id: notify-web
  name: '@mbda9091/notify-web'
  config:
    notifyOnApproval: true
    approvalDelayMs: 300
    notifyOnTurnEnd: true
    notifyOnTurnError: true
    heartbeatMs: 15000
    replayWindowMs: 120000
    maxReplayEntries: 256
    maxQueuedUpdates: 256
```

#### 包名与目录命名

- 当前三个对外插件包为 `@mbda9091/app-restart`、`@mbda9091/desktop-notify`、`@mbda9091/notify-web`。
- profile 下目录使用 `mbda9091`，不带 `@`。npm scope 与文件目录分别按各自约定命名。
- loader 行 `id` 和源码目录仍使用 `notify-web` 等短名；行的 `name`、包清单、类型引用、测试、示例和目录文档同步更新 scope。
- 仓库内部 `@local/notify-core`、`@local/notify-host` 等私有共享包也同步改为 `@mbda9091/`，避免保留两套自有命名；它们仍为构建期依赖，不作为插件安装或生成默认配置。
- 移除 `name.slice(7)` 等对 `@local/` 长度的假设，统一通过包名解析取得短名。同步更新能力验证适配器中的精确包名、workspace 依赖和锁文件；不把旧包验收报告改名冒用。

拟生成目录（以安装 Web 插件为例）：

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
- 现有 `stable-install --manifest ...` 仍要求原验收证据，不通过本次重构绕过门禁，也不默认新增写 patch 行为。开发 link 安装同样不写这些个人默认 patch。
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
- 日志明确输出 `reuse-tarball`、`reuse-build`、`rebuild` 及原因和批次；复用构建产物不等于复用功能验收结论，`stable-install` 原证据门禁不变。
- 优化范围为新 `install` 的插件构建/打包编排；现有显式 `build`、`pack`、开发测试命令保持原语义。`bootstrap.mjs` 编译脚本自身的步骤仍保留，因此“跳过插件编译”不等于本轮同时实现 CLI 自身的增量编译。

### 4.3 接口、配置与使用方式

安装入口职责如下，不通过给 `stable-install` 增加跳过验收参数来合并两条流程：

| 入口 | 输入与行为 | 验收要求 | 默认配置 |
|---|---|---|---|
| `install`（拟新增） | 当前源码 → 匹配并复用产物，必要时构建/打包 → 指定 profile | 不要求已有功能验收记录，不自动运行 `verify-artifacts`、L4/L5 或 CI；保留平台、包内容、安装结果及配置检查 | 生成或补齐 `<profile>/mbda9091/cordis.patch.yml`，保留已有同 ID 配置 |
| `stable-install`（已有） | 指定 `--manifest` 固定批次 → 指定 profile | 保留已有匹配的验收记录门禁；安装时检查记录，不重新执行整套验收 | 保持原行为，不新增配置生成 |

以下均为**拟新增接口，当前不可执行**。执行位置为仓库根目录，前提是依赖与工具链已准备好、目标 profile 已存在。

```bash
# 当前全部适用插件：优先复用产物，tarball 安装并生成命名空间默认配置
node scripts/bootstrap.mjs install --target my-web

# 显式重新构建并打包，不复用旧编译输出或 tarball
node scripts/bootstrap.mjs install --target my-web --rebuild

# 只安装指定插件
node scripts/bootstrap.mjs install --target my-web --only @mbda9091/notify-web

# 无需先登记具名目标，但必须完整提供目的地
node scripts/bootstrap.mjs install \
  --dsh-cli /path/to/dsh/lib/bin.js \
  --home /path/to/dsh-home --profile custom-web \
  --surface web --platform mac

# 只预览目标、插件选择和配置计划，不构建、打包、安装或写目标文件
node scripts/bootstrap.mjs install --target my-web --dry-run
```

- `--dry-run` 同样判定并报告复用/构建/打包计划；命中 tarball 时读取其模板，否则使用源码模板预览并标记“非固定产物计划”，不执行构建或打包。实际执行重新核验，最终始终以 tarball 模板为准。bootstrap 既有脚本编译行为保留。
- 新入口不提供 `--all` 绕过平台过滤、不提供 `--skip-build`；自动校验当前批次后复用，可通过 `--rebuild` 强制生成新批次。
- 输出包含 profile 绝对路径、包名/版本/哈希、安装归档、配置新增/保留/空配置状态、加载方式提示、备份与报告位置；不输出整份个人 patch 或凭据。
- 已有 `pack`、`verify-artifacts`、`stable-install` 继续用于固定产物的严格验收交付；`status --target` 继续查询磁盘安装状态。
- 删除 `web` 后，无参数与 `--help` 显示总帮助；旧 `web` / `daily-launcher` 调用返回明确的移除提示，不跳到开发环境。仅传 `--port` 不再触发日常启动。

### 4.4 兼容、迁移与回退

- 删除仓库内日常入口与指导，不修改用户已有 home/profile、已部署启动器或 shell alias。任务根目录中的旧 `start-macos-web.sh` 属于仓库外历史产物，本轮不自动删除或维护。
- `config.web` 仍服务开发浏览器、启动超时等设置，不能因删除日常 `web` 而整体删除。
- `targets` 继续服务安装与状态查询。已有可选 `targets[].patch` 暂保留读取兼容，标为日常启动遗留字段；新安装入口不加载、改写或应用它，不强制迁移本机 JSON。
- `profiles/web` 中开发模板和其他非日常功能需要的文件保留；只删除明确属于日常启动的说明与调用路径。
- 文档同步更新根 README、AGENTS、Web README、配置协议与开发环境方案中的当前描述；历史实施记录保留并注明由本方案替代。补齐目标登记和新安装的最短步骤。
- 测试删除或替换被移除的日常入口专属场景；保留共享归档、路径隔离、目标检查与开发测试场景。更新测试 ID/结果数量契约，禁止通过跳过来伪造原 CI 全通过。
- scope 改名覆盖当前三个插件及内部共享包的声明、import、bundle loader name、模板、脚本硬编码、测试 fixture、CATALOG 与锁文件；源码目录与 loader ID 保持不变。旧批次的包名、哈希和报告仍按历史事实保留，新 scope 必须重新构建验证。
- 已有目标如果仍安装对应 `@local/*` 插件，或根 patch 中对同 ID 使用旧 `name`，新安装命令预检失败并列出迁移原因，不能直接并存注册。由用户通过宿主支持方式处理旧包及个人引用后重试；本轮不自动卸载、搬迁或改写根 patch。既有开发环境也须检测旧 scope，提示使用原有 reset/init/dev-install 流程重建；不会静默清空。
- 配置恢复可使用本次备份；包回退继续使用明确的旧批次与既有交付入口，不新增自动回退。用户独立日常启动不依赖本仓库版本回退。

### 4.5 验证设计

| 验收项 | 对应目标 | 场景与预期行为 | 验证方式 | 覆盖边界 |
|---|---|---|---|---|
| A1 | G1 | 默认帮助；旧日常命令不启动进程；包脚本和文档无有效日常入口 | CLI 契约与引用检查 | 不删除用户已部署文件 |
| A2 | G2 | 具名/完整显式目标正确解析；不存在 profile、参数缺失、平台不兼容均写入前失败 | L3 / 环境测试 | 使用隔离目标 |
| A3 | G2 | 模板随 tarball 发布，安装只消费相同包中的模板；缺模板、非法模板、哈希变化拒绝 | 打包契约和安装测试 | 不靠源码目录模板代验 |
| A4 | G3 | mbda9091 目录及文件首次生成；同 ID 保留；无配置时生成 []；重复执行字节不变；根 patch 始终不变 | patch 单元测试 | 覆盖注释、!!js、禁用行、复杂冲突及路径逃逸 |
| A5 | G3 | 非法 YAML、并发修改、写入失败、第二包安装失败均非零；原配置保留、报告可恢复 | 故障注入测试 | 不承诺 pnpm 全事务回滚 |
| A6 | G2/G3 | link → tarball、tarball → tarball 后真实文件和锁一致；移走源码后安装依赖不依赖 worktree | 真实临时目标集成测试 | 不改用户日常 profile |
| A7 | G4 | dev-web init/start/status/stop/reset、dev-install 链接与 HMR 维持原行为 | 原开发环境测试回归 | 同名 web、不同 home 的隔离不变 |
| A8 | G4 | install 无验收记录也可安装且不调用 L4/L5/CI；stable-install 缺少匹配记录仍拒绝；原开发测试和固定产物验收保持有效 | 编排契约、既有测试入口及新回归 | 日常专属用例移除需列明；Windows/macOS 分别记录 |
| A9 | G2/G3 | macOS Web 与 Windows Web 在 mbda9091 下生成文件；显式 --patch 后组合正确，不传参数时不自动加载；Desktop 目标及显式选择 Desktop 插件均写入前拒绝 | Web 双平台真实隔离 profile 与参数边界测试 | 不启动用户宿主；Windows Desktop 适配和真实验收不适用 |
| A10 | G2/G4 | @mbda9091 包名、默认 patch name、安装过滤、适配器和锁文件一致；旧 @local 插件冲突在写入前识别 | 契约、开发/测试回归与隔离目标安装 | 不自动删除旧包或用户配置 |
| A11 | G2/G4 | 相同输入第二次安装不调用插件编译或 pack；仅缺 tarball 时复用有效编译输出；同版本源码/模板/依赖/工具链变化触发重建；损坏包拒绝；--rebuild 强制新批次 | 编排调用计数、哈希/文件变更及并发故障测试 | 含 lib 缺失但 tarball 有效、旧记录缺字段和 dry-run；不改变显式 build/pack 语义 |

测试报告沿用原 `.tmp`/`dist` 输出体系。实施时记录提交、包哈希、Node/DSH/pnpm 版本和平台；配置文件使用无凭据 fixture。Windows Desktop 不属于本轮新增能力验收对象；原有 Desktop 测试保留，不为此新增真实 Desktop 环境要求。

## 5. 里程碑

| 阶段 | 交付内容 | 前置依赖 | 出口条件 | 当前状态与证据 |
|---|---|---|---|---|
| M1 | 删除日常入口，保留公共依赖；更新帮助、包脚本与专属测试 | 本方案范围 | A1 通过；开发测试入口仍完整 | 已实现并验证 |
| M2 | scope 改名、包内默认模板、命名空间配置、新安装编排和失败报告 | M1；复用既有打包与安装原语 | A2–A6、A10/A11 通过，stable-install 门禁不变 | 已实现，主要验证通过 |
| M3 | macOS/Windows Web 回归，文档同步与真实安装验证 | M2 | A7–A9 及全量必要项通过，分别记录平台覆盖 | 部分完成，见第 8 节 |

## 6. 决策记录

| ID | 决策与理由 | 考虑过的替代方案 | 日期 | 状态与关联 |
|---|---|---|---|---|
| D1 | 删除日常使用职责，保留开发测试 | 继续维护多套启动器，不符合用户要求 | 2026-11-05 | 已定，用户要求；G1/G4 |
| D2 | 新增独立 install 编排，保留现有 stable-install 语义 | 合并入口或增加跳过验收开关会混淆直接安装与严格交付 | 2026-11-05 | 已定，用户明确要求；4.3、9.2 |
| D3 | 模板随 tarball 交付，在命名空间文件按 ID 只补缺行 | 复制 bundle patch 会重复 insert；覆盖已有 config 会改变用户行为 | 2026-11-05 | 提议中；4.2 |
| D4 | 原提案：默认 patch 直接进入 profile 根用户层 | 原目标为自动读取 | 2026-11-05 | 已被 D7 替代；见 9.1 |
| D7 | scope 改为 @mbda9091/，默认 patch 存在 profile/mbda9091/，不改根 patch | 用户明确要求按前缀独立存放；加载由用户负责 | 2026-11-05 | 命名与目录已定，用户要求；加载边界见 4.2 |
| D5 | 新入口验证安装与配置，不要求功能验收记录、不自动执行完整功能验收 | 自动串联全量 L4/L5 会放大普通安装成本，且当前 Desktop 验收覆盖不同 | 2026-11-05 | 已定，直接安装职责；严格交付入口保留 |
| D6 | 必须显式指定已有目标，归档脱离 worktree | 默认猜测日常环境或保存临时 tarball 会产生错误目的地或悬空依赖 | 2026-11-05 | 提议中；4.2/4.3 |
| D8 | install 自动复用与当前输入匹配的 tarball，其次复用编译输出；只重做必要阶段 | 每次重新编译打包浪费时间；仅按版本号复用无法识别同版本源码变化 | 2026-11-05 | 已定，用户要求；4.2、A11 |
| D9 | 保留 YAML 对 !!js 与复杂注释的处理要求；本轮新增安装能力不适配 Windows Desktop | 不扩展 Desktop 安装、配置接入及真实宿主验收 | 2026-11-05 | 已定，用户要求；Q1 已通过本轮 fixture 验证，Q2 关闭 |

## 7. 风险与开放问题

### 7.1 风险

| ID | 风险与触发条件 | 影响 | 应对与验证办法 | 当前状态 |
|---|---|---|---|---|
| R1 | 新模板与运行时默认值漂移 | 安装前后行为不一致 | 契约校验、模板随包版本化；A3 | 待验证 |
| R2 | YAML 标签、注释或嵌套结构被重写 | 用户配置损坏 | 保留原文、只追加安全行；复杂冲突拒绝；A4/A5 | 待验证 |
| R3 | 安装已成功但配置写入失败 | 仅部分完成 | 阶段报告、非零退出、重跑补配置；A5 | 待验证 |
| R4 | 删除 daily 文件时误删公共归档/隔离逻辑 | 正式安装或测试退化 | 先查引用，保留公共原语；A6/A8 | 待验证 |
| R5 | 新目录不自动加载，显式 --patch 后优先级又高于根配置 | 文件未生效或覆盖用户同 ID 配置 | 明确提示用户接入方式及层序；A9 | 已识别 |
| R7 | 旧 @local 和新 @mbda9091 同时安装，仍使用同一 loader ID | 重复注册或 name 校验失败 | 安装前检测旧包与旧 patch 引用，报告冲突，不自动叠加新包；A10 | 待验证 |
| R6 | 原 CI 依赖日常专项测试 ID 或计数 | 表面通过但缺少必要测试 | 更新清单与结果契约，记录删除范围；A8 | 待验证 |

### 7.2 开放问题

| ID | 尚待回答的问题 | 影响的决定或阶段 | 解决方式与时点 | 当前结论 |
|---|---|---|---|---|
| Q1 | YAML 库能否在现有 fixture 中可靠保留 !!js 与复杂注释 | M2 写入实现 | 只针对 mbda9091 文件完成 A4 原型；根 patch 完全不改；无法无损处理的结构拒绝修改，禁止降级重写 | 已验证 !!js、CRLF 和复杂注释原文保留；不支持的结构拒绝修改 |
| Q2 | Windows Desktop 真实安装验证环境是否可用 | 已不影响本轮 | 用户排除 Windows Desktop 适配，撤回新增环境要求 | 已关闭：本轮不适用；见 D9、9.4 |

## 8. 验收状态

> 截至：2026-11-05。验收对象：当前 worktree 实现。环境：macOS、Node v24.16.0、仓库锁定 DSH 与 pnpm，真实浏览器 Chrome。

| 验收项 | 实现状态 | 验收结果 | 证据与日期 | 尚未覆盖或失败原因 |
|---|---|---|---|---|
| A1：移除日常入口 | 已实现 | 通过 | node-entrypoints / fast 环境测试 | 无 |
| A2：目标与选择 | 已实现 | 单测通过 | profile-install / target-environment | Windows Web 未实机验证 |
| A3：tarball 模板契约 | 已实现 | 通过 | profile-install / profile-patch，真实安装 | 无 |
| A4：默认配置与幂等 | 已实现 | 通过 | profile-patch；真实重复安装原文哈希一致 | 无 |
| A5：失败与并发 | 已实现 | 单测及真实部分失败场景通过 | profile-patch、artifact-install、TGT-06-real | 无全量事务回滚 |
| A6：真实 tarball 安装 | 已实现 | macOS 通过 | run-4LA0dg / run-JAmpXz | 独立宿主 TGT-04/05 超时另列 |
| A7：开发流程回归 | 保持 | 通过 | fast、DEV-03、L4 | Windows 未运行 |
| A8：测试与严格交付回归 | 已实现 | 部分通过 | L1–L3、fast、L4/L5、ART 重试通过 | TGT-04 / TGT-05-real 超时；整套 real 仍失败 |
| A9：平台安装配置与显式加载 | 已实现 | macOS 通过 | 真实 --patch dump-config 保留用户 false 值 | Windows Web 未执行；Desktop 不适用 |
| A10：scope 改名与旧包冲突 | 已实现 | 通过 | 包契约及 profile-install / 开发预检测试 | 不自动迁移旧 profile |
| A11：构建与打包复用 | 已实现 | 通过 | install-cache；真实重复安装 reuse-tarball | bootstrap 自身编译保留 |

验收结论：代码已落地，主要 macOS 功能验证通过；未满足双 Web 平台及全部真实宿主用例的完成定义，不宣称完整 CI 通过。

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

### 9.7 CR 修正与审批插件移除（2026-11-06）

- YAML 追加只在缺少行结束符时补换行，追加后校验原行解析值完整保留。保留 `|+` / `>+` 的尾部换行语义；无法无损追加时拒绝写入。增加 CRLF、文档结束标记、无末尾换行和重复追加回归。
- 移除审批插件及专属 CLI、持久授权、管理工具、模板、探针与测试；当前默认 Web 安装仅选择 notify-web。L4 link/tarball 测试统一使用 notify-web，通用缺能力适配器拒绝机制保留。
- 历史验收记录保留，不能替代本次改动验证。用户已有 profile 和授权文件未修改。
- 本次 macOS 验证：build --check 通过；L1–L3 226 通过、1 平台跳过；fast 28 项通过（.tmp/environment-tests/run-2pkLkD/report.json）；L4 通过（.tmp/l4/run-poel4q/report.json）；L5 默认 fixture 通过（.tmp/l5/run-TwiySH/report.json）。Windows 与完整 real/CI 未重跑。

## 10. 当前未完成事项与下一步

| 事项 | 分类与当前状态 | 下一步或启动条件 | 依据 |
|---|---|---|---|
| 独立宿主真实测试 TGT-04 / TGT-05-real | 超时，未通过 | 定位独立宿主安装/文件 I/O 耗时并定向复验；不改验收门槛 | M3 / A8 |
| Windows Web 安装与配置加载 | 未验证 | 在 Windows Web 实机运行相关回归 | M3 / A9 |
| 完整 CI 验收 | 尚未闭环 | 上述欠项通过后更新验收状态 | 完成定义 |

实现与使用文档已同步。本轮不推送、不修改日常 profile；Windows Desktop 不属于新增安装范围。
