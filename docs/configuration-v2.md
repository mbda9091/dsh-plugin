# 本机配置 v2：字段、命令与迁移

M1–M6 实现协议（2026-10-31）。对应[环境计划](development-environment-plan.md)。M5 绑定固定产物与验收记录，M6 提供明确目标管理、安装预览和逐包交付报告；实际平台验收范围见计划中的实施记录。

## 字段归属

配置位置为 `scripts/config/local.json`，相对路径始终以仓库根解析。运行时不补缺字段、不覆盖旧文件；初始化默认值来自 [example](../scripts/config/example.json)，校验依据为 [schema](../scripts/config/schema.json)。

| 字段 | 类型 / 初始值 | 用途与必填条件 |
|---|---|---|
| `version` | `2` | 必填；v1 只能显式迁移，未知版本拒绝 |
| `tools.pnpmScript` | 路径或 `null` | 必填字段；使用时必须指向 pnpm 包的 `bin/pnpm.cjs`，包版本与根 `packageManager` 相同 |
| `web.browser` / `browserPath` | `edge` / 路径或 `null` | 开发 Web 偏好；浏览器还支持 `default`，只在启动浏览器时验证可执行文件 |
| `web.openBrowser` / `startupTimeoutMs` | `true` / `30000` | 开发 Web；超时为 1–2147483647 的整数毫秒 |
| `test.browser` / `browserPath` | `chrome` / 路径或 `null` | 测试偏好；支持 Playwright 管理的 `chromium`，只有 L5/CI 需要浏览器 |
| `test.timeoutMs` | `120000` | 测试操作超时，取值范围同上 |
| `targets` | 完整目标对象数组，默认 `[]` | 必填；空数组是合法开发配置，无默认选中目标 |
| `targets[].name` | 唯一标签 | ASCII 字母或数字开头，后续允许字母、数字、`_`、`-` |
| `targets[].dshCli` / `home` | 非空路径 | 目标 CLI 和数据根；不从环境变量补齐 |
| `targets[].profile` | profile 名 | 同 name 字符规则，不允许目录穿越 |
| `targets[].surface` / `platform` | `desktop` 或 `web` / `windows` 或 `mac` | 必填；目标选择是一组完整字段 |
| `targets[].binding` | 可选真实路径对象 | `target bind` 保存 cli/engine/entry/home/profile；每次使用重验。手写完整目标也执行路径隔离检查，但没有历史路径身份可比较 |
| `legacy.dshCli` | 路径或 `null` | 只保留 v1 待核对信息；任何命令都不将其当作宿主或目标 |

所有对象拒绝未知字段。入口要求普通 Node 24；编译器、pnpm、开发 DSH 都由当前 `process.execPath` 执行。开发 DSH 只解析根 `devDependencies` 精确版本对应的 `node_modules/@deepseek-ai/dsh` 的公开 `bin`（当前为 `lib/bin.js`）。缺失或版本不符提示 `pnpm install --frozen-lockfile`，不查询 PATH、不回退到 `legacy.dshCli`。正式目标拒绝 workspace DSH 及其链接别名；Electron 目标保留自己的引擎。

## 工具准备（M2）

先由调用方准备普通 Node 24 和 `packageManager` 指定的 pnpm `11.28.5`，再冻结安装。仓库不自动下载或切换 Node/pnpm；不扫描 Codex/DSH 私有 runtime。

```text
pnpm install --frozen-lockfile
node scripts/bootstrap.mjs config init --pnpm-script <pnpm包绝对路径>/bin/pnpm.cjs
node scripts/bootstrap.mjs config check
```

通过 `npm install --global pnpm@11.28.5` 准备的 pnpm，其包位于 `npm root -g` 输出目录下的 `pnpm`。init 未指定脚本时仅检查 PATH 上 npm 的 Windows prefix、Unix prefix/lib 和 pnpm 脚本链接布局；Corepack/独立二进制不作为脚本入口，无法发现时保持 null 并提示显式选择。版本不符不自动改装。

`config check` 读取磁盘配置，附加 Node/pnpm/DSH 的版本、实际路径、来源与使用范围；缺少可选工具只显示 unavailable，不阻断结构检查或迁移。pnpm 版本来自所选包清单，DSH 版本来自根声明与安装清单的比对；真实 CLI 和内部 pnpm 执行由 real 套件单独验证。Web/安装/L4/L5 必须配置 pnpm，并通过临时 PATH shim 供 DSH 内部调用；build 不需要浏览器或 pnpm。只有消费某工具的命令才强制检查它。

锁定依赖的安装脚本策略见 `pnpm-workspace.yaml`：允许 esbuild、node-pty、koffi 和 DSH spawn-helper 准备；明确拒绝已发布纯 JS 包的非必需脚本。开启 peer 自动解析并锁定，因为公开 DSH 需要这些宿主服务才能启动。插件交付仍不含 DSH、Node 或 workspace 依赖。

`web` 配置字段只表示开发浏览器偏好，不包含个人 YAML。开发数据固定为 `.local/dsh-dev/home`、`store`、profile `web`；patch 为 `.local/dsh-dev/cordis.patch.yml`。`web init`、首次 `web` 或 `dev-install` 通过锁定 DSH 的公开 `--profile web --dump-config` 初始化，并从独立的 `profiles/web/cordis.dev.patch.yml` 生成开发 patch。重复初始化不覆盖已有设置，不导入个人 patch、模型凭据或审批规则。

## 持久开发环境（M3）

```text
node scripts/bootstrap.mjs web init
node scripts/bootstrap.mjs dev-install
node scripts/bootstrap.mjs web --no-open --port 3000
# 另一个终端
node scripts/bootstrap.mjs web status
node scripts/bootstrap.mjs web stop
node scripts/bootstrap.mjs web reset
node scripts/bootstrap.mjs web reset --yes
```

`web`/`web start` 前台运行，默认 `127.0.0.1:3000`；只允许 loopback，`--port 0` 可选空闲端口。启动须通过 URL 与 HTTP 就绪检查；端口被占或 DSH 改选端口则失败，不停止占用者。运行期间保留 supervisor，另一个终端通过本地、带随机令牌的控制端口请求状态/停止。PID 仅供诊断，不凭 PID 发信号；supervisor 只停止自己持有的子进程。正常停止保留数据，退出清除运行记录。

目录含 `owner.json`（真实仓库根、用途、环境 ID、已知插件链接）、`runtime.json`（运行 ID、supervisor/child PID、控制端口/令牌）、`home/`、`store/`、`logs/`、`bin/`、独立 npm 配置/缓存和开发 patch，全部被 `.local/` 忽略。原始日志可能含启动令牌，保持本地。创建、复用和重置验证祖先路径与 symlink/junction；开发、`.tmp`、所有配置目标 home 不得相等或互为父子。对尚不存在的目标也检查最近已有祖先的真实位置。

`dev-install` 默认先构建，再初始化和 add/update，验证 profile 的 `link:` spec 与实际链接均指向预期插件；不删除依赖。操作锁 `.local/dsh-dev.lock` 防止初始化、安装、启动与重置相互竞争。开发子进程清理继承的 npm/pnpm 配置覆盖，使用受管 user/global config、store 和 cache；不改父环境或全局配置。

`web reset` 默认仅列范围，`--yes` 执行：检查目录归属及整棵树 → 请求自己的实例停止 → 再核对路径和归属 → 按 lstat 逐项清理。已登记插件链接只解除链接本身，不递归到源码；未知外部链接、缺失/错误归属或无法验证的进程身份都阻止清理。不要用 `pnpm remove`。

异常退出后可能保留锁或运行记录。先查看本地日志与记录，人工证明 supervisor **和 child** 均已退出，再移除对应锁/`runtime.json` 后重试；不能仅凭 PID 不存在或端口空闲认定可回收。仓库搬迁导致 owner 的真实根不一致时不自动认领，先在原位置停止/重置；无法回原位置时先保存数据并人工核对归属。外部编辑器不受操作锁约束，管理操作期间不要替换目录或修改管理记录。

## 命令和覆盖矩阵

所有命令通过 `node scripts/bootstrap.mjs`。适用字段的优先级为显式参数 > 下表允许的环境变量 > 磁盘值。大小写不同的环境键统一识别；父进程环境不修改。未列出的显式参数由解析器拒绝。

| 命令 | 上下文与参数 | 环境变量 |
|---|---|---|
| `config init` | 只创建 JSON；支持 `--dry-run`、`--pnpm-script`、`--browser`、`--browser-path`、`--test-browser`、`--test-browser-path`、`--test-timeout` | 不把临时 DSH/pnpm/browser 覆盖保存回配置；允许使用系统位置发现浏览器 |
| `config check` | 校验磁盘 v2/事务状态，输出工具诊断；不接受覆盖、不要求 DSH/pnpm 已安装 | 不使用运行时覆盖 |
| `config migrate [--dry-run]` | 只读取磁盘旧值；不依赖 DSH/pnpm，不启动工具探测 | 不使用运行时覆盖 |
| `build`、`pack`、`test` | 工具上下文；`--pnpm-script` | `DSH_PNPM` |
| `web [start]` | 开发上下文；`--open/--no-open`、`--browser`、`--browser-path`、`--startup-timeout`、loopback `--host`、`--port` | `DSH_PNPM`；无浏览器变量覆盖 |
| `web init/status/stop/reset` | 开发上下文；仅 reset 接受 `--yes`；status 同时显示开发插件安装状态 | `DSH_PNPM` 仅 init 需要 |
| `dev-install` | 开发上下文；只安装开发 home；`--pnpm-script`、`--dry-run`、`--skip-build`、`--all` | `DSH_PNPM` |
| `l4`、`l5`、`ci`、`verify-artifacts` | 测试上下文；L4/L5 可传 `--manifest`，verify-artifacts 必传且支持 `--check`；`--pnpm-script`、`--test-browser`、`--test-browser-path`、`--timeout`、`--keep` | `DSH_PNPM`、`DSH_E2E_BROWSER`、`CHROME_PATH` |
| `stable-install`、`status` | 目标上下文；`--target NAME`，或完整的 `--dsh-cli PATH --home DIR --profile NAME --surface desktop\|web --platform windows\|mac`，两种方式互斥 | 仅 `DSH_PNPM`；不从环境变量拼目标 |
| `test-env --suite fast` | 无本机配置依赖；可用 `--keep`、`--only ID,ID` | 不从个人配置获得被测值 |
| `test-env --suite real\|all` | 无本机配置依赖；显式 `--pnpm-script PATH`，可用 `--keep`、`--only ID,ID`；ART 浏览器用例接受 `--test-browser`/`--test-browser-path`；TOOL-04 需网络、Git 和 tar | 不从个人配置获得被测值；子进程使用独立 home/store/userconfig |
| `catalog`、`check-targets` | 无本机配置依赖 | 无目标选择 |

`DSH_CLI`、`DSH_HOME`、`DSH_PROFILE`、`DSH_PROFILE_DIR`、`DSH_WEB_URL` 不再重定向上述命令。子进程清理这些变量以及 npm/pnpm store 覆盖和 Electron 标志，再由用途上下文填入选定地址。旧变量本身不会触发错误；不适用的显式目标参数会报错。`l4 --home` 仅代表新的仓库 `.tmp` 测试目录，不是正式目标 home。`--` 不能绕过 Web 参数校验。

`stable-install` 必须传 `--manifest`，核验 M5 记录、包哈希及实际目标宿主版本，再执行 add/update；不能用 `--all` 绕过范围门禁。`--only @local/a,@local/b` 选择清单子集，未知、重复或不兼容包在安装前拒绝。`status --manifest PATH` 可只读核对已安装包内容和 bundle；不要求该清单仍为最新构建。

## 显式迁移与恢复

```text
node scripts/bootstrap.mjs config migrate --dry-run
node scripts/bootstrap.mjs config migrate
node scripts/bootstrap.mjs config check
```

预览只展示字段动作、缺少的目标信息和拟用备份位置，不创建锁、备份或候选文件。执行时重新规划，备份位置重新生成。v1 schema 冻结在 `schema.v1.json`；纯函数将 pnpm、Web/测试偏好原值保留，将 `tools.dshCli` 移入 `legacy.dshCli`，创建空 `targets`。个人 YAML 不读取、不复制、不改写。新版重复迁移为 no-op，不刷新备份或维护记录。

写入协议：独占 `.local-maintenance.lock` → 校验输入哈希 → `.local-backups/<时间-id>/` 保存原始字节及 manifest → 同目录候选文件及哈希核验 → 持久 `.local-maintenance.pending.json` → 依次替换 JSON 和维护记录 → 整体核验 → manifest 标为 committed → 清理 pending/候选/锁。所有配置、祖先目录、备份和候选路径均拒绝 symlink/junction，包括指向仓库内的链接。备份失败不替换目标；普通异常仅恢复仍等于本次写入哈希的文件。恢复失败保留 pending/锁，不覆盖第三方内容。

出现 pending/锁时，init、check、迁移和业务读取器都停止并提示恢复。不要仅凭 PID 或超时删除锁。恢复步骤：

1. 确认维护进程已经退出，保存需要保留的第三方编辑。
2. 查看 pending 引用的备份 manifest；仅处理其中固定的 `local.json`、`.local-maintenance.json`。
3. 核对备份 SHA-256 等于 `before`；核对当前文件是 `before`、`after` 还是第三方内容。第三方内容先另存并人工确认，不自动覆盖。
4. 将原先存在的文件恢复为备份原始字节。仅当 `before` 为 null 且当前哈希等于 `after` 时删除本次新建文件。
5. 再核验所有恢复结果，把备份 manifest 标记为 `rolled-back`；移除该事务列出的候选文件、pending 和锁，再运行迁移或 check。原配置为 v1 时 check 会继续提示显式迁移。

锁只协调维护命令；外部编辑器不受锁控制。哈希检测无法消除检查与替换间的竞态；迁移期间应暂停手动编辑。不承诺多文件原子提交、断电或磁盘损坏恢复。备份只保留本地，不自动上传或轮转。

## 独立验证

`test-env --suite fast` 只编译 `test/tsconfig.environment.json`，运行 CFG、TOOL、DEV、ISO、ART 和 TGT-01/02/03/05/06，共 28 项。DEV/ISO 使用假宿主、真实受控子进程和本地 HTTP。报告及每组证据写入 `.tmp/environment-tests/run-*/`；不要求个人配置、插件 build、真实 DSH 或浏览器。成功清理 fixture、失败保留、`--keep` 保留成功现场；缺证据、skip、清理失败都会失败。`--only ISO-01,ISO-02` 可选择当前 suite 的已实现用例，报告明确记录 selected，不代表完整阶段验收。

`test-env --suite real --pnpm-script <path>` 执行 TOOL-04，包含 TOOL-03/05 的真实断言：导出 Git 跟踪及未忽略的当前源码（不复制本机配置、产物或 node_modules），在独立用户目录/store 中冻结安装，探测公开 CLI、profile 初始化及内部 pnpm，构建并检查 notify-web tarball。选定 pnpm 包复制进临时工具目录，子进程 PATH 无全局 DSH/私有 runtime；不安装或切换用户工具。`TOOL-04-details.json` 记录版本、Node 调用轨迹、步骤与包内容。

real 另执行 DEV-03、ISO-01-real/02-real/03/05、ART-01/02-real/04-real/05-real/06，以及 TGT-04/05-real/06-real，共 14 项；all 合计 42 项。DEV 使用临时开发环境；TGT 另准备真实普通 Node DSH，CLI 实际入口、home、store 均与开发环境分开，真实验收 fixture tarball 后交付。ART-04-real/06 需要显式测试浏览器（`--test-browser chromium` 或 `--test-browser-path <Chrome>`），验证固定 notify-web tarball 的真实 L4/L5。仅记录实际执行的平台，不证明桌面能力。

两平台 CI 分别运行 fast 与 real，不预先初始化本机配置；完整 `ci` 先运行环境 all，再运行类型检查和 L1–L5。CI 报告只引用本次环境/L4/L5 的独立报告路径，并检查完整用例集合、逐项结果和清理证据；退出 0 但缺报告、缺项、重复、skip 或写报告失败均不通过。环境入口不回调整条 ci。报告不自动上传，平台通过与否以实际执行结果为准。

## 一次性测试生命周期（M4）

固定产物模式见本文末的 M5 协议；下面的隔离、清理规则同样适用。

L4/L5 通过同一 `runIsolatedTest` 创建 `.tmp/<suite>/run-*`，原子预留全新 home。`--home` 必须是仓库 `.tmp` 内的新目录，祖先链接、既有目录及与开发/配置中正式 home 的重叠均拒绝；两次或并发运行各有 home、store、日志和随机端口。测试仅使用公开 Web profile 与自己的 fixture，不加载开发 patch。

测试子进程清理继承的 DSH（仅保留解析后的浏览器选择）、npm_config、pnpm、Corepack 及 XDG 配置覆盖；显式设置 user/global npmrc、pnpm store/cache/home 和 XDG config/data 目录。DSH 从运行目录启动，避免消费仓库的安装配置；pnpm 内部命令走已选定 shim。保留系统 HOME/USERPROFILE 等正常变量，避免破坏 Chrome 的用户目录判断。L2 打包也使用已解析 pnpm 和独立包管理器配置。

成功默认删除本次 home（包括显式 `--home`）、store/cache、shim、配置及 workspace，保留报告、日志、截图和 trace；`--keep` 保留成功数据，失败保留现场。清理先核对路径，再用 lstat 解除链接，不遍历到插件源码。清理失败记为独立失败步骤。报告含版本、平台/Node、宿主入口、起止时间、逐步结果和清理状态，`last-report.json` 仅作便利索引；并发 CI 使用回调拿到各自准确报告路径。

异步进程等待支持 SIGINT/SIGTERM，退出时等待自己启动的进程树并检查已知 HTTP 端口关闭。Windows 使用活跃子进程的 PID 配合 taskkill /T；Unix 为测试子进程建立独立进程组。Windows 测试通过子进程内部派发 SIGINT 验证可处理的中断路径；强制终止 supervisor、断电和磁盘不可写不承诺生成完整报告。无法创建/写入报告时命令失败，不借用旧报告。原始日志只留本地，汇总与错误输出移除认证 token。

## 固定产物与验收协议（M5）

`pack` 默认构建，随后生成全新的 `dist/batches/<UUID>/`，内含 tarball 与 `manifest.json`，成功后原子更新 `dist/current.json`。没有同名文件覆盖；失败批次不发布为 current。`--skip-build` 只适用于已构建的输入，不免除包契约检查。

清单 `version: 1` 包含批次、创建时间、Node/pnpm、commit、Git dirty 摘要、跟踪及未忽略源码的逐文件 SHA-256 和汇总值、构建代号；每包记录路径、名称、版本、targets、是否有 Client、tarball 哈希和包内文件哈希。非 Git fixture 使用排除临时/构建/依赖目录的源码快照。构建（不含 `--check`）在写产物前更新代号；新构建、新 pack、源码变化、清单/文件变化均使旧记录不可用于当前交付。仅文件名/版本相同不构成相同产物。

```sh
node scripts/bootstrap.mjs pack
# 下列路径替换为 pack 打印的实际 manifest 路径
node scripts/bootstrap.mjs verify-artifacts --manifest dist/batches/<UUID>/manifest.json
node scripts/bootstrap.mjs verify-artifacts --manifest dist/batches/<UUID>/manifest.json --check
# 单独诊断，不生成完整的交付成功记录
node scripts/bootstrap.mjs l4 --manifest dist/batches/<UUID>/manifest.json
node scripts/bootstrap.mjs l5 --manifest dist/batches/<UUID>/manifest.json
node scripts/bootstrap.mjs stable-install --target daily --manifest dist/batches/<UUID>/manifest.json --dry-run
```

验收先预检**全部**清单文件，拒绝缺文件、错误 targets、逃逸/重复路径、链接、DSH/workspace 运行时依赖、本机配置与依赖目录。当前包契约要求零运行时依赖，接受 pnpm 生成的普通 USTAR 文件/目录；其他 tar 扩展明确失败。Host 在两个新 Node 进程中导入（含/不含 preserve-symlinks）。产物 L4/L5 不重建或重打包插件；L5 仍编译浏览器测试并安装专用 web-hello 测试驱动，它不是被测交付包。

安装从独立快照消费已校验字节，前后复核快照、原包、清单、源码状态和 current 批次。核对 profile bundle 登记、tarball spec、真实安装路径与完整文件清单/字节；正常 pnpm store 链接允许，回到源码 junction 或包内额外文件拒绝。L4 验证启用的 loader 行、HTTP、Client 注册及适用 SSE；L5 当前有 notify-web 的真实通知/交互/主题/locale adapter，新增 Client 插件没有 adapter 时失败，不套用通用成功。

`dist/verification/<UUID>/web-<platform>.json` 为 version=1 本机流程记录，内嵌 L4/L5 逐步报告与 browser results，不只存 `.tmp` 路径。环境初始化/安装/清理证据与功能结果分别列出；完整用例、安装哈希、起止时间、平台、工具链和宿主版本逐项校验。`status: passed` **仅指当前 Web 平台**；各包其他 surface/platform 均列为 `uncovered`。桌面包通过静态契约不等于桌面能力通过。日志、截图、trace 留在 `.tmp`，清理它们不会删除唯一的验收凭据。重新验收先写失败状态，失败不会继续保留上一次成功。

`stable-install` 在写目标前验证记录和目标公开 `--version`，仅接受精确宿主版本及 surface/platform 匹配的成功证据，不重打包，也不升级宿主。add/update 使用 `dist/consumption/run-*/inputs/` 的独立固定副本并检查实际安装内容；该目录属于 profile 的持久 tarball 来源，不要在 profile 仍引用它时删除。`--all` 不能绕过门禁。

## 正式目标与交付恢复（M6）

```text
node scripts/bootstrap.mjs target discover
node scripts/bootstrap.mjs target bind daily --dsh-cli <外部CLI> --home <独立home> --profile web --surface web --platform windows --dry-run
node scripts/bootstrap.mjs target bind daily --dsh-cli <外部CLI> --home <独立home> --profile web --surface web --platform windows
node scripts/bootstrap.mjs target list
node scripts/bootstrap.mjs target show daily
node scripts/bootstrap.mjs stable-install --target daily --manifest dist/batches/<UUID>/manifest.json --only @local/notify-web --dry-run
node scripts/bootstrap.mjs stable-install --target daily --manifest dist/batches/<UUID>/manifest.json --only @local/notify-web
node scripts/bootstrap.mjs status --target daily --manifest dist/batches/<UUID>/manifest.json
node scripts/bootstrap.mjs target unbind daily --dry-run
```

`discover` 不需要 local.json，只列 PATH/已知安装位置候选及拒绝原因，不执行 CLI、不自动选中或保存。workspace `.bin`、开发宿主真实路径及链接别名被排除。其余管理命令要求 v2。bind 只接受整组显式字段，保存绝对路径及真实身份；同名 bind 显式替换旧绑定。bind/unbind 使用配置事务备份与并发检查，只改变 targets，不保存环境覆盖、不修改个人 YAML。unbind 不卸载插件或删除目标数据；没有默认目标，仍须每次 `--target NAME`。

目标平台必须匹配当前机器，保留的 web/desktop profile 必须匹配 surface；Web 拒绝 Electron 入口。home 不得与开发、测试、源码包、仓库工具目录或宿主程序重叠；profile、manifest、lockfile、node_modules 容器及其祖先不得通过链接重定向。绑定后的真实入口/home/profile 变化会要求重新检查并显式 bind。安装过程重新检查配置、目标路径、固定包和验收记录，不复用上次 dry-run 的授权计划。

预览显示目标入口、实际路径、宿主版本、home/profile、场景、逐包路径/哈希、coverage、selected/skipped 和计划操作。无 `--only` 时按目标场景过滤，不兼容包显示 skipped；显式选择不兼容包则整体拒绝。预览允许在仓库 dist/.tmp 写版本探测日志及临时管理文件，不写配置或目标 profile。版本探测使用独立 probe home，包管理配置/cache 位于报告所在的 consumption 目录，不继承个人 npm/pnpm 配置来源。已有 profile 从 `.modules.yaml` 读取并验证当前 v11 store，保持 pnpm 的解析关联；新 profile 固定使用 `dist/target-stores/<profile身份哈希>`，预览/报告明确列出路径。store 不得与目标 home、开发/测试数据或源码重叠，异常 store 关联在写入前拒绝。

执行报告为 `dist/consumption/run-*/report.json`（version=1），每次操作前后原子更新；包含目标身份、宿主版本、清单哈希、逐包 spec/实际路径/哈希、stage、warnings、bundle、row、loaded、capability。状态解释：

- `installed` 表示固定文件和 bundle 已核对；Web 再用 `--dump-config` 核对同 id/name 且未禁用的配置行，`row=configured` 不代表运行时已经加载。
- `loaded=unconfirmed` 是 CLI 没有运行中状态接口时的正常结果；诊断中的 `restart-required`、加载失败分别记录。`capability=unverified` 始终表示日常目标尚未执行能力验收。
- warnings 导致整体 `needs-attention` 并退出 1；文件可已安装。加载诊断/行失败导致整体失败，保留文件安装事实。需要重启不会自动重启，退出 0 仅代表文件交付成功。
- 多包失败立即停止，前包保留 `installed`，失败包记录 stage/error，后包为 `not-attempted`；不伪造回滚，不调用 remove。中断时最后的 `installing` 也是未完成证据，不能当作成功。

恢复时先检查报告及对应 add/update/rows 日志，再用 `status --target ... --manifest ...` 核对磁盘状态；修复原因后重新 dry-run，可用 `--only` 重试失败/未执行的包。同一包 add 覆盖并 update 重解析，不手改 profile manifest、不删除源码 junction 的目标。旧批次因源码/构建变化失效时先重新打包验收，不绕过门禁。配置事务恢复继续沿用本页前述备份/pending 流程。报告与输入不自动上传或回收。

桌面人工验收：当前 M5 证据仅覆盖 Web，桌面安装会在门禁处停止。需先在独立 Electron home 验证隔离，再建设对应固定包验收证据；届时完全退出桌面应用、安装、人工启动，检查 bundle/行状态、warnings、原生能力和必要重启，并记录 OS/宿主版本/包哈希。不得用日常 profile 替代隔离验收，也不得把 Web 的通过记录当作桌面通过。

pack、验收、安装共用 `dist/.artifact-lock` 排斥仓库命令并发消费/发布。失联锁先确认所属进程已停止再人工移除；不自动凭 PID 回收。UUID 目录和多次哈希校验防止仓库命令静默替换，也能检测外部文件变化；这不是防恶意修改/改写后恢复的签名或文件系统事务。检测变化即失败，已发生的目标写入不自动回滚，保留现场以供诊断。
