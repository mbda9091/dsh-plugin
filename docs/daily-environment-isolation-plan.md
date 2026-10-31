# 日常环境独立运行方案与迭代记录（v0.2）

> 状态：S1、S2、S3 已实现并通过 Windows 完整 CI；S4 本机切换未执行。
> 更新日期：2026-10-31（Asia/Shanghai）。
> 当前结论：独立启动器与外部固定来源已实现，夹具验证与完整 Windows CI 结果见 §9.2。实际日常环境仍使用旧入口及源码 link，须另行完成 S4。
> 验收基线：`f27f0e4` 加已有入口分流与本轮未提交源码；最终报告 `.tmp/ci/run-sqzDtl/report.json`。未向实际日常环境部署发行件或迁移插件。
> 关联文档：[方案模板](plan-template.md)、[开发环境统一与隔离方案](development-environment-plan.md)、[当前配置协议](configuration-v2.md)、[测试计划](testing-plan.md)、[仓库约定](../AGENTS.md)。

## 1. 结论摘要

- **要解决的问题**：选择系统 DSH 只隔离了宿主来源。当前 `dshweb` 仍先编译仓库脚本，日常 `notify-web` 仍链接开发源码；仓库编译失败、依赖缺失或插件构建变化都可能影响日常使用。
- **采用的方案**：日常环境使用系统普通 Node 版 DSH、已有日常 home/profile、独立部署的启动器和经过验收的固定插件包。启动器配置、管理记录及持久包来源全部放到仓库之外。
- **本轮边界**：先交付并验收 Windows 日常 Web；开发与测试继续使用仓库锁定的 DSH。保持系统包管理配置、cache/store/state 共享，不承诺操作系统安全隔离，不改变桌面 Electron 的启动方式。
- **当前进展**：独立 ESM 启动器、不可变配置快照/发行件、部署事务、外部归档与持久逐包报告已落地；新增 DLY 快速/真实隔离测试。实际日常环境未改动。
- **下一步**：按 S4 处理本机运行记录、工具路径和配置引用清单，再部署、迁移日常插件并切换入口。

## 2. 范围

### 2.1 目标

- G1：默认 `dshweb` 从任意工作目录启动同一日常环境，不运行仓库编译器，不要求仓库依赖、源码或本机配置文件存在。
- G2：开发源码编辑、构建、依赖重装及开发/测试环境重置，不改变日常安装的插件字节、DSH 入口或数据目的地。
- G3：日常插件使用经过适用平台/宿主验收的固定 tarball；仓库及其 `dist` 不可用时，已安装插件仍可加载，安装来源和交付证据仍可追溯。
- G4：沿用原日常 home/profile，保留历史和凭据；开发与测试继续有独立 home、配置、进程及端口，不向日常数据回退。
- G5：启动、停止、异常恢复和升级都有明确身份及诊断；失败不误停其他进程、不静默改用另一个宿主或新建空历史。

### 2.2 非目标与延期项

| 事项 | 本轮处理 | 原因或后续触发条件 |
|---|---|---|
| 复制/维护一套 DSH 或 Node 发行版 | 不做 | 使用用户已安装的系统程序；仓库仍只交付插件和管理工具 |
| 隔离 npm/pnpm 配置、store、cache、代理和证书 | 不做 | 延续既定系统包管理策略；测试清理不得触及共享数据 |
| 自动安装/升级系统 Node、DSH、pnpm | 不做 | 更新系统工具是独立维护动作；只校验并明确报告不匹配 |
| 操作系统权限隔离、限制任意插件磁盘访问 | 不做 | Host 插件仍具有当前用户权限，本方案保证受管工作流的路径和依赖隔离 |
| 自动同步个人 YAML、会话或凭据到开发环境 | 不做 | 日常原地使用；测试使用独立 fixture |
| macOS 日常启动器交付、桌面 Electron 能力 | 本轮不验收 | 设计保留跨平台边界；需要时单独执行对应平台验收，不继承 Windows Web 通过状态 |
| 历史版本一键自动回滚、后台自更新 | 延期 | 首次交付明确恢复步骤；旧产物不自动绕过现有源码/验收门禁 |

### 2.3 适用场景与协作边界

- “日常环境”表示实际使用的稳定环境；“系统 DSH”只描述宿主安装来源。端口、同版本号或同一个 Node 可执行文件都不代表环境身份相同。
- 本轮基线为 Windows、普通 Node 24、DSH `0.2.1-rc.2`、Web profile；开发/测试仍遵守根 `packageManager` 和锁文件。日常工具版本独立记录，不能被仓库后续版本声明自动改变。
- 原开发环境方案继续负责 M1–M6、开发生命周期和一次性测试；本方案负责日常启动和日常交付对仓库的运行时依赖。拆分是因为新增了独立部署、迁移和“仓库离线”验收目标。
- 完成定义：第 8 节 A1–A9 的 Windows 必需项全部通过，实际日常入口及插件完成迁移，并提供版本、哈希、环境及实际能力证据。模拟测试或 HTTP 200 不能替代真实插件能力验收。

## 3. 现状与问题

以下为 2026-10-31 本机核查结果，路径以占位符表示，完整个人配置不入库。

| 对象 | 当前行为或已有能力 | 问题与影响 | 依据 |
|---|---|---|---|
| 默认命令分流 | `web` 调用 `runDailyWeb`；`dev-web` 调用开发入口 | 分流已经存在于未提交工作区，不能按 HEAD 单独复现 | [cli.ts](../scripts/src/cli.ts) |
| 日常宿主 | 本机 `daily` 绑定系统全局普通 Node DSH，home 为原用户日常目录，profile 为 `web` | 本体来源正确，但并不证明插件和启动依赖已隔离 | 本机 `scripts/config/local.json` 只读核查；[目标校验](../scripts/src/core/formal-target.ts) |
| 日常快捷入口 | PowerShell `dshweb` 调用 `<repo>/scripts/bootstrap.mjs web` | 每次先编译脚本层；源码错误、仓库依赖缺失或仓库不可用会阻断启动 | 本机 shell 函数；[bootstrap.mjs](../scripts/bootstrap.mjs) |
| 日常管理配置与状态 | 读取仓库 `local.json`，管理文件在 `.local/dsh-daily/<name>`，pnpm 对照仓库根版本 | 日常启动、状态和恢复仍受开发仓库变化影响 | [daily-web.ts](../scripts/src/commands/daily-web.ts)、[工具校验](../scripts/src/core/toolchain.ts) |
| 日常插件 | `@local/notify-web` 的 spec 是 `link:<repo>/notify-web`，实际也是源码 junction，bundle 已启用 | 构建改变日常随后加载的代码；删除源码可使插件失效 | `status --target daily` 输出 `link (dev)`；profile manifest 与 junction 只读核查 |
| 固定包安装来源 | 当前正式安装从 `dist/consumption/run-*/inputs` 的固定副本安装 | 已安装文件可独立，但仓库清理后再次解析/维护依赖可能找不到 tarball；必须保留外部来源 | [当前 M5/M6 协议](configuration-v2.md) |
| 开发/测试隔离 | 开发 `.local/dsh-dev/home`；测试 `.tmp` 新目录；清理 DSH 变量并检查路径交叠 | 可复用，当前无需重做生命周期和测试框架 | [命令上下文](../scripts/src/core/command-context.ts)、[测试隔离](../scripts/src/core/test-isolation.ts) |
| 日常运行记录 | `web status` 返回进程身份无法验证，磁盘记录标记 `running` | 无法凭记录确认实例仍存活或已停止；可能有残留记录，原因未确认 | 本轮命令输出，未删除记录、未发送停止信号 |

已有可复用能力包括外部 DSH 识别、真实路径校验、认证控制接口、端口冲突检查、token 脱敏、固定 tarball 哈希与能力门禁，以及 add/update 后核对实际安装路径。需要提取明确参数的公共逻辑，不能直接把依赖 `repoRoot`、仓库配置和插件发现的整个 CLI 搬到外部。

尚待验证：系统 DSH 在独立启动器选择的 pnpm 下实际启动的兼容性、日常 profile 是否还引用其他仓库资源、当前运行记录失联的原因。验收前必须完成清单化检查，不把“未发现”写成“已证明不存在”。

## 4. 具体方案

### 4.1 总体设计与职责

日常环境的运行输入仅包括：系统 Node/DSH/pnpm、独立启动器发行目录、日常配置、原日常 home/profile，以及外部固定包归档。开发仓库只参与显式构建、验收、发布和维护。

| 部分 | 职责 | 输入与输出 | 本轮改动 |
|---|---|---|---|
| `packages/daily-launcher/` | 独立启动器的 TypeScript 源码，非插件，不声明 `dsh.bundle`，不进 CATALOG | 构建出自包含 Node ESM 入口及哈希清单 | 已实现；仅 Node 内置运行时依赖，不包含 DSH/Node/pnpm |
| 仓库 `daily-launcher` 管理命令 | 准备、检查和显式部署启动器发行件及配置快照 | 读取选定 target；输出可审查部署计划/固定文件 | 已实现；业务逻辑仍在 TS，不新增手写 shell 业务层 |
| 外部 `dshweb` | 默认启动及 `status/stop/check` | 读取独立日常配置，启动绑定宿主，管理自身进程 | 拟部署；不调用 bootstrap、tsc、pnpm install 或仓库 CLI |
| 仓库 `web` | 保留便利入口 | 读取已部署启动器的位置并委托执行 | 已实现；仍需仓库可用，不作为独立运行的保证入口 |
| `dev-web`、`dev-install`、L4/L5 | 开发与测试 | 继续使用 workspace DSH 和独立 home | 复用，增加与日常同时运行的回归 |
| `stable-install` | 将已验收的同一固定包交付到目标 | 新增显式外部归档位置，核对哈希、安装来源和报告 | 已实现；保留原有安装门禁与非日常目标流程 |

外部布局如下；`<daily-root>` 必须在仓库和 DSH home 之外。Windows 推荐 `%LOCALAPPDATA%/dsh-daily`；macOS 后续可使用用户 Application Support 目录，当前不宣称已支持。

```text
<daily-root>/
  bin/                     # 生成的薄入口，调用绑定的普通 Node
  releases/<release-id>/   # 固定启动器 JS、版本与文件哈希
  active.json              # 当前启动器版本及配置选择
  config/daily-<uuid>.json  # 不可变日常配置快照；active 同时选择配置和 release
  state/<instanceId>/      # 跨 release 稳定的运行记录、锁、日志、pnpm shim
  artifacts/<batch-id>/    # tarball、原清单、验收记录；按哈希检查
  receipts/<run-id>/       # 部署/安装前后身份与逐包结果
```

不向 `$DSH_HOME` 下放包或工具。薄入口只转交参数、退出码和前台生命周期，不能嵌入另一套参数解析、宿主发现或业务逻辑。日常工具源码可以在仓库中，但部署副本不得是源码、`lib` 或仓库 `node_modules` 的链接。

### 4.2 独立配置、工具与启动行为

独立配置 `daily-<uuid>.json` 格式版本 1 已实现，与仓库配置 v2 分开演进：

| 字段 | 约束与来源 |
|---|---|
| `version`、`instanceId` | 格式版本与独立实例 UUID；进程归属不再由仓库路径推导 |
| `host` | 普通 Node 绝对路径、DSH CLI/解析入口、DSH 版本及真实路径绑定；从已选择目标导出并复核 |
| `target` | home/profile/surface/platform 及真实路径；本轮必须为 Web 和当前平台 |
| `packageManager` | 明确选择的 pnpm 包脚本和经验证版本；不扫描私有 runtime、不跟随仓库 `packageManager` 更新 |
| `web` | 默认 `127.0.0.1:3080`、浏览器偏好和就绪超时；沿用当前可用的安全参数范围 |
| `isolation` | 禁止作为运行依赖的仓库、开发及测试根路径快照；核查时不要求这些目录仍存在 |

部署时从仓库配置生成一次快照；之后独立配置是日常启动的事实来源，仓库 target 是正式交付选择的事实来源。两者只在显式部署/更新时对齐；更新目标身份时必须比较完整 home/profile/CLI/引擎，显示差异，不自动双向同步。普通仓库 build、config init、target bind 不得重写日常配置。

启动流程：

1. 只读取已部署发行件和日常配置，验证格式、路径、普通 Node 和宿主身份；拒绝源码链接、Electron、开发/测试数据目录及未初始化 profile。
2. 子进程清理继承的 DSH 目的地变量和 Electron 标志，填入日常 home/profile；保留系统包管理配置、代理、证书及正常用户环境。DSH 内部 pnpm 通过外部 state 下的 shim 使用已绑定脚本。
3. 工作目录固定到日常 home，使用原 home/profile 层配置，不传入仓库开发 patch，不安装/升级插件，不调用开发初始化。
4. 绑定 loopback 和请求端口；冲突时明确失败，不选另一个环境、不停止端口占用者。完成 URL 和 HTTP 就绪检查后才显示 ready，认证 URL 不写入报告。
5. `status/stop` 只依赖独立状态及认证控制通道，不因仓库损坏或 pnpm 不可用而无法管理已经启动的实例；只有 start 或显式 check 才检查启动工具。
6. 宿主/Node 路径或版本变化时报告需显式重绑并复验，不按 PATH 自动换工具。仓库 Node/pnpm 声明变化不会改变日常绑定。

`check` 为只读预检，报告启动器版本、目标身份、插件 spec 与真实路径、仓库引用以及运行记录状态，输出不得包含凭据或会话内容。检查正常 pnpm store 内部链接与源码 junction 的区别，不一概禁止所有符号链接。未知链接、`link:`、指向仓库的 `file:`、插件运行时资源或配置引用均列为待处理；自动检查无法确定的动态 YAML 表达式单列人工复核。不能仅靠文本不含 `<repo>` 判定通过。

### 4.3 固定插件交付与外部归档

本轮迁移首先覆盖已发现的 `@local/notify-web`，迁移前清点日常实际启用的全部本仓库插件和其他本地依赖。

1. 复用 `pack`、`verify-artifacts`、真实 L4/L5 和能力适配器，获得与 Windows/Web/目标宿主版本匹配的成功记录。不以现有源码 link 的运行情况代替 tarball 验收。
2. `stable-install --archive-root <daily-root>/artifacts` 在任何 profile 写入前，验证目标 home 和归档路径位于仓库之外、无危险链接，再按批次复制所选 tarball、原 manifest 和成功证据，复核每个哈希。复制失败则不安装；已有同批次不同字节则拒绝覆盖。
3. 安装仍重新检查当前源码/构建/批次、目标身份及成功证据；归档不能绕过门禁。DSH `add` 的来源改为已验证的外部副本，而不是 `dist/consumption`；随后按现有流程 `update` 强制重解析。
4. 安装后同时核对 manifest spec、lockfile 解析、实际 `node_modules` 目标和包内文件哈希。正常 pnpm store 链接允许；spec 已变但仍指向源码则判失败，不宣称迁移成功。
5. 逐包报告与来源映射在仓库报告之外持久保存在 `<daily-root>/receipts`；明确 files、bundle/row、loaded、capability 各自状态。归档拷贝不是新的验收结果，只保存已核验原证据。
6. 日常启动检查插件来源已经稳定，但不要求当前开发源码与旧包一致，也不每次重验收。日常显式升级仍走新的构建、验收和交付流程。

外部归档在 profile 仍引用时不得删除，不随 `.tmp`、`dist` 或开发 reset 清理。本轮不新增自动 GC。验证仓库离线场景时分别证明“已安装插件可运行”和“固定来源仍存在且可解析”，不把二者混为同一结果。

### 4.4 接口、配置与使用方式

以下已有命令保持当前语义，实施前仍以 [配置 v2](configuration-v2.md) 为准：

```text
node scripts/bootstrap.mjs web status
node scripts/bootstrap.mjs status --target daily
node scripts/bootstrap.mjs dev-web
node scripts/bootstrap.mjs pack
node scripts/bootstrap.mjs verify-artifacts --manifest <manifest>
```

以下接口已实现。部署和归档都要求显式目标及外部绝对目的地，不从日常环境变量猜测；实际日常迁移仍按 S4 的预检和停止窗口执行：

```text
# 在仓库执行：构建部署候选并显示文件、身份、版本和配置差异
node scripts/bootstrap.mjs daily-launcher prepare --target daily --destination <daily-root>
node scripts/bootstrap.mjs daily-launcher deploy --target daily --destination <daily-root> --dry-run
node scripts/bootstrap.mjs daily-launcher deploy --target daily --destination <daily-root>

# 在仓库执行：既有门禁通过后，把来源和证据保存在仓库外
node scripts/bootstrap.mjs stable-install --target daily --manifest <manifest> --only @local/notify-web --archive-root <daily-root>/artifacts --dry-run
node scripts/bootstrap.mjs stable-install --target daily --manifest <manifest> --only @local/notify-web --archive-root <daily-root>/artifacts

# 部署并切换入口后，在任意目录使用
dshweb --no-open
dshweb status
dshweb stop
dshweb check
```

`prepare` 只写仓库构建/候选目录；`deploy --dry-run` 只读目标并打印计划；`deploy` 把候选复制为新的固定 release，复核后原子更新 active 指针，保留旧版。不会自动启动/停止宿主或写 profile。生成的 shell 接入片段供迁移时替换已有 `dshweb` 函数；只改相关函数并保留本机备份，不覆盖整份 shell profile。Windows 函数优先于 PATH 命令，必须验证最终解析结果，不能只把新入口放进 PATH 就认为完成。

首版独立 `dshweb` 只管理导出的一个 daily 实例，不复刻仓库多目标管理。旧的 `web --target NAME` 可以继续作为仓库内管理入口，但不能被宣传为独立运行入口。后续修改帮助文本、AGENTS 和 Web README 时同步注明这一边界。

### 4.5 迁移、异常恢复与回退

迁移按以下顺序执行，每步保留可核对结果，任一步失败不自动进入下一步：

1. 只读清点系统宿主、原 home/profile、插件 spec/实际路径、配置引用、命令解析及运行实例，生成不含秘密的清单。备份本机 shell 入口和将修改的管理配置；如确需改个人 patch，按约定先备份为同目录 `.bak`。
2. 在独立 fixture 中完成新启动器及固定插件验收，再部署启动器；先保持原日常入口不变。实际日常 profile 不能被用作自动化测试夹具。
3. 核实运行实例状态，安排迁移停止窗口。若旧控制接口可认证，正常停止自己的实例；失联时先确认 supervisor 与子进程都已退出，才允许人工归档/移除旧运行记录。PID 不作为强制结束陌生进程的依据。无法证明退出则停在诊断阶段。
4. 通过受管正式安装流程将源码 link 覆盖为固定包，核对实际解析；禁止 `pnpm remove`、`dsh plugin remove` 和直接改写 profile manifest。若个人 patch/HMR 还引用仓库，独立列出并按备份规则处理，不能清空整份 patch。
5. 执行独立 `check`，切换 shell `dshweb` 到外部入口，确认新终端实际命令解析，启动原日常 home/profile；验收通过后归档旧管理记录。旧 state 不直接复制为新启动器的活跃状态。
6. 人工确认原历史列表可见及 `notify-web` 实际能力；仅查看列表不能宣称全部历史可重放。默认不读取会话正文或凭据。

回退与失败边界：

- 启动器部署失败时 active 指针保持旧版；切换后新版本无法启动，可显式恢复旧 release/配置指针，不动日常数据。恢复原 shell 函数只能作为临时应急，会重新引入仓库依赖，不能据此关闭隔离任务。
- 第一轮从 link 迁移前若没有已验收的旧固定包，就不存在可信的插件稳定回退点；必须在预检中明确。迁移失败保留文件和报告，修复后以同一已验收包 add/update 重试；不要自动恢复开发 link。
- 已有上一版固定包时，回退仍需匹配宿主和能力证据。当前 M5 要求 current/source 匹配，不能直接把旧 manifest 交给现有命令假定可用；本轮采用在隔离源码检出中重新走构建/验收/交付的恢复方式，一键历史包回滚另行设计。
- 多包交付前包成功、后包失败时保留逐包结果；不声称事务性回滚。需要重启、warnings、加载失败及能力未验证分别呈现。
- 开发/测试清理仅作用于其受管目录，不删除外部 release、归档、原日常 home 或共享包管理数据。

### 4.6 验证设计

| 验收项 | 对应目标 | 场景与预期行为 | 验证方式 | 覆盖边界 |
|---|---|---|---|---|
| A1 默认身份 | G1/G4 | 从任意 cwd、新终端、受污染 DSH 变量启动，始终使用绑定系统 DSH 和原日常 profile | L3 参数/环境契约；隔离真实 Web；最终本机人工核对 | 本机默认入口需单独验证，模拟入口不替代 shell 解析 |
| A2 启动独立 | G1 | 仓库源码不存在、TS 编译失败、仓库 node_modules/配置缺失或 packageManager 改变时，外部入口仍可 start/status/stop | 用可破坏的 fixture 检出构建并部署，移开 fixture 仓库后执行真实启动 | 不删除或破坏用户实际仓库；不保证系统工具损坏后还能运行 |
| A3 插件独立 | G2 | 改源码、重新构建、移开 fixture 源码后，日常包哈希不变，重启后实际能力正常 | L3 哈希/解析检查；固定 notify-web L4/L5 | 必须重启以排除仅旧模块留在内存的假通过 |
| A4 来源与门禁 | G3 | 外部归档完整；仓库 dist 消失不影响固定来源；缺证据/错哈希/错平台/错宿主在写目标前拒绝 | ART/TGT 扩展与真实 fixture 安装；独立 probe profile 从外部副本解析 | 不对日常 profile 做故障注入或删除共享 store |
| A5 开发测试共存 | G2/G4 | 日常 fixture 与 dev/L4/L5 同时运行；停止、reset、测试失败清理只影响各自实例 | DEV/ISO 扩展，真实 Web 并发及哨兵/哈希校验 | 不以端口不同替代 home/CLI/插件身份核验 |
| A6 故障管理 | G5 | 端口冲突、控制认证失败、残留记录、工具路径变化均明确失败，不误杀、不另建历史 | L3/环境 fixture，覆盖中断和重启诊断 | 强杀/断电不承诺自动恢复；手工恢复过程须验证 |
| A7 迁移正确 | G2/G3/G4 | add/update 后 manifest、lockfile、真实路径和文件哈希一致；保留已有数据哨兵 | TGT fixture + 本机逐包交付报告 | 原日常数据不复制到测试；人工历史检查不读取正文 |
| A8 发布与恢复 | G1/G5 | 部署中断或新 release 无法启动时可恢复已部署旧版；仅自身文件改变 | 临时外部根的失败注入、release/hash/active 校验 | 插件历史版本自动回滚不在本项范围 |
| A9 本机实际能力 | G1–G5 | 新终端默认 dshweb 启动原日常环境，原列表可见、通知可触发；日常无仓库运行依赖 | Windows 人工验收与实际通知；保存脱敏版本/哈希/检查摘要 | 不替代 macOS、桌面、全部会话重放或安全沙箱验收 |

自动化在仓库 `.tmp` 下创建“测试仓库”和与之平级的“外部日常根”，两者相对于 fixture 必须真实独立。使用临时数据和测试插件，不读取个人凭据，不修改实际日常 home。发布件、报告记录 commit/dirty、逐文件哈希、Node/DSH/pnpm 版本及 platform/surface；截图和日志按既有策略脱敏并留本地。

实施时运行 `build --check`、`test` 及受影响环境套件；安装/加载/服务变更执行 L4，Client 实际能力执行 L5，并完成当前 Windows 完整 `ci` 回归。只改文档时不启动这些会改动测试环境的流程。

## 5. 里程碑

本方案使用 S 编号，避免与原方案 M1–M6 混淆。

| 阶段 | 交付内容 | 前置依赖 | 出口条件 | 当前状态与证据 |
|---|---|---|---|---|
| S1 独立启动器 | TS 源码、固定构建、独立配置、deploy/check、外部进程状态和薄入口 | 现有分流及工具/进程控制能力 | A1/A2/A6/A8 fixture 通过，仓库不可用仍可启停 | 已实现并验收；DLY-01/02/03/06 及最终 CI 通过，见 §9.2 |
| S2 外部固定包交付 | archive-root、固定来源及持久证据、源码 link 检查、迁移报告 | M5/M6；S1 接口 | A3/A4/A7 fixture 通过，打包后实际能力通过 | 已实现并验收；DLY-04/05、ART-06/07 及最终 CI 通过 |
| S3 共存与回归 | 故障注入、开发/测试并发、Windows 全量回归 | S1/S2 | A1–A8 Windows 必需项通过 | 已验收；Windows 49 项环境、262 项 L1–L3、类型检查和 L4/L5 全部通过 |
| S4 本机切换 | 部署、原环境迁移、shell 入口切换、实际体验及恢复说明 | S3；完成实际迁移预检 | A9 通过，真实配置/插件无仓库运行依赖，遗留记录有明确处置结果 | 待实施；只读核查见 §9.1 |

macOS/桌面为独立后续范围，不作为本轮 Windows Web 的隐含欠项，也不能标为已验收。

## 6. 决策记录

| ID | 决策与理由 | 考虑过的替代方案 | 日期 | 状态与关联 |
|---|---|---|---|---|
| D1 | 日常用系统 DSH，开发/测试用仓库 DSH，数据分别管理 | 仅靠端口区分不能隔离数据或代码 | 2026-10-31 | 用户目标已明确；G1–G4 |
| D2 | 独立部署小型 Node 启动器，业务源码仍用 TS，运行时只依赖 Node 内置模块 | 继续 bootstrap 会受编译影响；只包一条 shell 命令难以统一状态/身份检查；打包整套 DSH 违反仓库边界 | 2026-10-31 | 已实现并验收；S1 |
| D3 | 日常配置/状态/固定包来源放仓库和 DSH home 之外，部署生成快照并显式更新 | 仓库 local.json 或实时链接都会保留开发耦合；放 DSH home 下违背包归属规则 | 2026-10-31 | 已实现并验收；S1/S2 |
| D4 | 日常插件只消费已验收固定包，迁移用 add/update，不 remove | link 即使版本相同也会随开发构建变化；Windows remove 有删除源码风险 | 2026-10-31 | 延续既有交付规则，实际迁移待执行 |
| D5 | 系统包管理配置和缓存继续共享，日常工具绑定不随仓库版本声明更新 | 为每个环境建立独立包管理环境与既定约定冲突，也不是本次故障的必要修复 | 2026-10-31 | 已定边界；兼容性待真实验收 |
| D6 | Windows Web 先闭环，初始迭代只写方案 | 同时扩展桌面/跨平台会扩大缺少证据的范围 | 2026-10-31 | 初始范围记录；后续 §9.2 已推进 S1–S3，S4 仍待执行 |

## 7. 风险与开放问题

### 7.1 风险

| ID | 风险与触发条件 | 影响 | 应对与验证办法 | 当前状态 |
|---|---|---|---|---|
| R1 | 复制启动器但仍动态 import 仓库脚本、读取根 manifest 或 realpath 仓库 | 名义独立，仓库缺失仍失败 | 自包含产物检查 + A2 真正移开 fixture 仓库 | DLY-01/05 已验证；S4 仍需检查实际入口 |
| R2 | tarball spec 已更新但 junction/lockfile 仍解析到源码 | 开发修改仍进入日常 | add/update 后同时验证多层解析与字节，A3/A7 | 已确认当前有源码 link，待迁移 |
| R3 | 全局 DSH/Node/pnpm 升级改变路径或兼容性 | 日常启动被明确拒绝或功能退化 | 独立版本/身份诊断，显式重新绑定并验收；不自动下载修复 | DLY-01/02 漂移拒绝已验证；本机长期工具路径留给 S4 |
| R4 | shell 中旧函数遮蔽新入口，或升级启动器覆盖活跃版本 | 用户实际仍调用旧路径，或运行中状态失联 | 命令解析核查；固定 release、原子指针、实例身份独立于 release | DLY-02/06 发布恢复已验证；实际 shell 解析待 S4 |
| R5 | 个人 patch、HMR、其他本地插件仍引用仓库 | 去掉 notify-web link 后仍有隐性依赖 | 清单检查与人工复核，不能只检查一个依赖 | 未完成全面核查 |
| R6 | 外部归档被清理、磁盘写满或权限异常 | 后续维护失去来源，部署半完成 | 预检/哈希/持久报告；引用中的归档不 GC；失败不继续安装 | 已实现；DLY-04/05 验证碰撞拒绝及来源持久性，真实断电/磁盘写满未注入 |

### 7.2 开放问题

| ID | 尚待回答的问题 | 影响的决定或阶段 | 解决方式与时点 | 当前结论 |
|---|---|---|---|---|
| Q1 | 当前日常运行记录为何无法认证，实际是否仍有实例存活？ | S4 停止与迁移窗口 | 正常系统环境复核控制通道与进程身份，不能只凭 PID/磁盘 running 字段处理 | 未决；不在本次文档操作中清理 |
| Q2 | 日常 profile 是否还有动态配置、HMR 或其他依赖引用仓库？ | S2/S4 完整迁移清单 | 不输出秘密的定向配置/依赖检查；动态项由本机人工复核 | 已确认 notify-web link，其余未完成全面审计 |
| Q3 | 现有系统 pnpm 是否适合独立日常启动，路径是否足够稳定？ | S1/S4 工具绑定 | 显式选择现有普通安装，验证 DSH 内部调用；不自动扫描/迁移私有 runtime | 本机当前脚本位于 DSH 管理的 runtime，是否继续使用需兼容性及生命周期核查 |
| Q4 | 首次迁移是否有可用的旧稳定插件包和恢复时间窗口？ | S4 故障恢复准备 | 迁移预检列出已验收固定包与实际可执行恢复方式 | 尚未核实；无旧包时明确不能承诺快速插件回退 |

## 8. 验收状态

> 截至：2026-10-31。对象：`f27f0e4` 加已有入口分流与本轮 S1–S3 未提交改动；启动器/固定包哈希在 DLY 及 CI 本地报告中。
> 环境：Windows、普通 Node 24.19.0、pnpm 11.28.5、DSH `0.2.1-rc.2`；全部功能操作使用隔离夹具。本机日常迁移未执行。

| 验收项 | 实现状态 | 验收结果 | 证据与日期 | 尚未覆盖或失败原因 |
|---|---|---|---|---|
| A1 默认身份 | 独立快照/实例与仓库委托已实现 | DLY-01/06 通过 | §9.2；2026-10-31 | 实际 shell 解析留给 S4 |
| A2 启动独立 | 自包含 ESM 已实现 | DLY-01/05 仓库移走后启停/重启通过 | §9.2 | 只对 fixture 仓库离线；未移动实际仓库 |
| A3 插件独立 | 外部 tarball 迁移能力已实现 | DLY-05 真实 add/update 和离线能力通过 | §9.2 | 实际日常仍是源码 link |
| A4 来源与门禁 | 外部归档及原证据保留已实现 | DLY-04/05、原 ART 门禁回归 | §9.2 | 归档不升级原证据覆盖范围 |
| A5 开发测试共存 | 已实现并纳入必需测试 | DLY-05 三环境并发、reset/失败清理通过 | §9.2 | Windows fixture 范围 |
| A6 故障管理 | 独立认证控制通道及状态已实现 | DLY-01/02/03 通过 | §9.2 | 本机旧记录 Q1 未处理 |
| A7 迁移正确 | 来源/spec/lockfile/路径/字节多层核对已实现 | DLY-05 真实源码 link 覆盖、哨兵保留通过 | §9.2 | 不代表实际日常历史人工验收 |
| A8 发布与恢复 | 不可变 release/config、原子 active、旧指针恢复已实现 | DLY-02/06 中断和坏 release 恢复通过 | §9.2 | 不支持插件历史版本自动回滚 |
| A9 本机实际能力 | 未切换 | 未执行 | 无 | 本轮未启动/停止日常服务或触发插件 |

验收结论：S1–S3 与 A1–A8 Windows 必需项已通过最终完整 CI。A9 未执行，整体日常迁移完成定义仍未满足，不能把夹具验收当成本机已切换。

## 9. 实施结果与修正

### 9.1 隔离现状复核与方案细化（2026-10-31）

#### 本轮目标与落地内容

- 对应 S1–S4 的前置设计；用户要求细化并按模板写入文档，本轮没有实施运行时代码或环境迁移。
- 读取模板、当前分流代码、目标校验、开发/测试隔离代码及现有交付协议，编写本方案，并在原方案及配置说明补充关联和现状边界。
- 比最初两项缺口补充一项交付依赖：固定包当前来源在 `dist/consumption`，需要一并移出仓库，才能支撑仓库不可用后的维护与恢复。

#### 验证结果与证据

- 对象：`f27f0e4` 加未提交工作区；Windows 本机配置与已安装目录。只读配置内容及输出未复制进公共文档。
- `node scripts/bootstrap.mjs status --target daily`：退出 0，报告 `@local/notify-web` 为 `link (dev)`、`bundle=on`；manifest 与 junction 指向 `<repo>/notify-web` 相符。
- `node scripts/bootstrap.mjs web status`：退出 1，返回 `Web process identity cannot be verified`；未向 PID 发信号，未移除 runtime 文件。
- shell 入口核查：`dshweb` 仍调用仓库 bootstrap；bootstrap 每次运行 TypeScript 编译；日常配置选择的是系统全局 DSH，而非 workspace DSH。
- 证据位置：本次聊天工具输出及本机未入库配置；没有生成独立自动化报告。这里保存必要摘要，不将其包装为持久功能验收记录。
- 证据边界：证明当前路径、依赖与状态诊断事实；不证明日常运行实例身份、通知能力、全部历史可用或新方案可执行。

#### 发现的问题与修正

| 问题 | 原因或证据 | 修正 | 复验结果 |
|---|---|---|---|
| 把默认选系统 DSH 等同于完全隔离 | 启动编译和插件 link 仍来自仓库 | 将宿主、启动器、插件及持久来源分别纳入完成定义 | 文档已明确，功能待实施 |
| 固定包来源依附仓库 dist | 当前 M5/M6 文档明确 consumption inputs 是持久来源 | S2 增加外部归档和安装 spec 核对 | 待实施 |
| 运行记录显示 running，但状态查询失联 | 认证控制请求未成功 | 保留为 Q1，迁移前验证，不自动清记录/停进程 | 待诊断 |

#### 本轮结论与遗留

方案已形成可逐阶段实施的接口、迁移顺序及验收项。S1–S4 均未交付；本轮未修改日常配置、shell 函数、profile 或源码 link，未部署、重启或停止任何实际日常服务。

### 9.2 S1–S3 实现与回归（2026-10-31）

本轮按用户要求实施 S1、S2、S3，未执行 S4。保留原工作区入口分流改动，未修改本机日常 profile、shell 函数、旧运行记录或实际插件 link。

落地内容：

- `packages/daily-launcher/src` 提供独立 dispatcher 与 supervisor；纯配置契约、进程控制、文件式子进程工具在构建时内联。产物门禁检查非 Node 内置外部依赖；运行时不读取仓库、仓库配置或根 packageManager。
- `daily-launcher prepare/deploy` 显式绑定现有 Windows Web 目标、普通 Node 和 pnpm，输出前后配置及逐文件哈希。release 和配置分别不可变，active 原子选择二者；保留部署收据及 previous 指针。部署不启动/停止服务，不接管个人数据。dispatcher 协议或绑定 Node 路径变化需要新部署目录及显式入口切换，避免覆写仍被旧入口使用的启动代码。
- 独立 `check` 检查 spec、真实路径、运行时资源和定向配置引用；只读凭据之外的必要文件，动态表达式单列人工复核。`status/stop` 不依赖 pnpm/DSH 启动工具，不凭 PID 清理未知实例。
- `stable-install --archive-root` 保存原 tarball/manifest/成功证据，保留现有门禁，安装后核对 manifest、lockfile 的 specifier/version/tarball/integrity、实际路径和完整文件哈希。收据保存安装前来源及安装后逐包结果；没有把安装成功标成能力通过。
- 新增 DLY-01/02/03/04/06（快速）和 DLY-05（真实）测试，Windows 环境门禁为 33/16/49 项。完整 CI 仍执行类型检查、L1–L3、L4/L5。

实现中的修正：只忽略 YAML 整行注释，避免将默认 patch 注释中的 `!!js` 当成动态配置；真实安装用例沿用已有模拟系统包管理配置，避免把跨盘 store 警告忽略成成功；新增启动器源码指纹后，同步补齐 ISO-04 最小检出夹具。

最终证据（Windows，普通 Node 24.19.0、pnpm 11.28.5、DSH 0.2.1-rc.2、系统 Chrome）：

- 完整 CI：`.tmp/ci/run-sqzDtl/report.json`，五阶段全部退出 0；环境 49/49、类型检查、L1–L3 262/262、L4、L5 全部通过，未跳过。
- 环境报告：`.tmp/environment-tests/run-TXq6Ry/report.json`；包含 commit/dirty、脚本/测试/启动器源码逐文件指纹和清理证据，结束后核对全部指纹与当前实现一致。
- 外部交付、并发及离线证据：同目录 `DLY-05-details.json`。启动器 SHA-256 为 `3e28b5b2170826dd6b7fbb49fb55c55af4dcc881cf51a57a9fb41ca636e07543`；合成 Host 固定包 SHA-256 为 `7e4fd4d8e1e5d14afd6d85bb70b3dfbdb3f044a608d574a097ee131a0f04229c`。原始来源映射和逐包核对结果保存在该报告，夹具成功后清理。
- 最终 L4/L5 报告由上述 CI 的 `evidence` 字段直接引用；截图、trace、日志继续只保留本地。
- 首次全量回归 `.tmp/ci/run-4ZPJdd/report.json` 为失败：48/49 环境用例通过，ISO-04 最小检出漏拷启动器源码；修正后独立复验通过。随后完整 CI `.tmp/ci/run-66y4NR/report.json` 通过；最终又对外部 home/实际安装路径补充仓库边界检查，并以上述 `run-sqzDtl` 全量复验，不将历史或局部成功替代最终结果。

覆盖边界：DLY 只在 Windows 纳入必需集合；真实外部来源测试使用合成 Host 插件的注册/响应契约，实际 notify-web 固定包能力由 ART-06/L5 验证。真实日常原生通知、历史列表、默认 shell 命令解析、Q1–Q4 和 macOS/桌面均未由本轮替代验收。外部根在测试父目录下，与模拟仓库平级；没有移动或隐藏真实仓库。

## 10. 当前未完成事项与下一步

S1–S3 已完成；下面仅保留实际迁移及后续范围。

| 事项 | 分类与当前状态 | 下一步或启动条件 | 依据 |
|---|---|---|---|
| 当前日常记录和完整依赖清单 | 待诊断 | 在迁移前解决 Q1/Q2/Q3/Q4，准备备份和恢复步骤 | §7.2、S4 |
| 本机部署、插件迁移和入口切换 | 待实施 | S3 通过且预检完成后按 §4.5 执行；明确停止窗口 | S4、A9 |
| macOS、桌面及自动历史回滚 | 本轮非目标/后续按需建设 | 有对应需求时另定适用验收，不能套用本轮结果 | §2.2 |

接下来执行实际迁移预检 → S4。只有补齐 Windows A9 后，才把整体日常环境迁移标记为已验收；本轮 S1–S3 的完成不代表本机入口已切换。
