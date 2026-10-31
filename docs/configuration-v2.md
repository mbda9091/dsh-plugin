# 本机配置 v2：字段、命令与迁移

M1–M4 实现协议（2026-10-31）。对应[环境计划](development-environment-plan.md)。M4 统一一次性测试上下文、清理和独立报告门禁；M5/M6 产物验收、目标管理尚未交付。

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
| `l4`、`l5`、`ci` | 测试上下文；`--pnpm-script`、`--test-browser`、`--test-browser-path`、`--timeout`、`--keep` | `DSH_PNPM`、`DSH_E2E_BROWSER`、`CHROME_PATH` |
| `stable-install`、`status` | 目标上下文；`--target NAME`，或完整的 `--dsh-cli PATH --home DIR --profile NAME --surface desktop\|web --platform windows\|mac`，两种方式互斥 | 仅 `DSH_PNPM`；不从环境变量拼目标 |
| `test-env --suite fast` | 无本机配置依赖；可用 `--keep`、`--only ID,ID` | 不从个人配置获得被测值 |
| `test-env --suite real\|all` | 无本机配置依赖；显式 `--pnpm-script PATH`，可用 `--keep`、`--only ID,ID`；TOOL-04 需网络、Git 和 tar | 不从个人配置获得被测值；子进程使用独立 home/store/userconfig |
| `catalog`、`check-targets` | 无本机配置依赖 | 无目标选择 |

`DSH_CLI`、`DSH_HOME`、`DSH_PROFILE`、`DSH_PROFILE_DIR`、`DSH_WEB_URL` 不再重定向上述命令。子进程清理这些变量以及 npm/pnpm store 覆盖和 Electron 标志，再由用途上下文填入选定地址。旧变量本身不会触发错误；不适用的显式目标参数会报错。`l4 --home` 仅代表新的仓库 `.tmp` 测试目录，不是正式目标 home。`--` 不能绕过 Web 参数校验。

M1 中 `stable-install` 仍沿用已有 add/update 安装机制，仅增加完整目标选择；**具体 tarball 的验收门禁、目标发现/绑定/兼容证据是 M5/M6 的未完成项**，不将本阶段安装成功称作正式交付已验收。

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

`test-env --suite fast` 只编译 `test/tsconfig.environment.json`，运行 CFG-01–06、TOOL-01/02/03/05、DEV-01/02/04/05/06 和 ISO-01/02/04/06，共 19 项。DEV/ISO 使用假宿主、真实受控子进程和本地 HTTP。报告及每组证据写入 `.tmp/environment-tests/run-*/`；不要求个人配置、插件 build、真实 DSH 或浏览器。成功清理 fixture、失败保留、`--keep` 保留成功现场；缺证据、skip、清理失败都会失败。`--only ISO-01,ISO-02` 可选择当前 suite 的已实现用例，报告明确记录 selected，不代表完整阶段验收。

`test-env --suite real --pnpm-script <path>` 执行 TOOL-04，包含 TOOL-03/05 的真实断言：导出 Git 跟踪及未忽略的当前源码（不复制本机配置、产物或 node_modules），在独立用户目录/store 中冻结安装，探测公开 CLI、profile 初始化及内部 pnpm，构建并检查 notify-web tarball。选定 pnpm 包复制进临时工具目录，子进程 PATH 无全局 DSH/私有 runtime；不安装或切换用户工具。`TOOL-04-details.json` 记录版本、Node 调用轨迹、步骤与包内容。

real 另执行 DEV-03，复用 workspace 的只读锁定宿主，在新的临时仓库内初始化、安装 fixture link、启动实际 Web、修改产物后重启验证实际加载、保留调试哨兵并重置。该组同时提供 DEV-01/04/05 的真实生命周期证据，详情在 `DEV-03-details.json`。开发 fixture 不使用真实 `.local/dsh-dev/`。real 的 ISO-01-real/02-real/03/05 验证污染配置、独立 pnpm store、重复/并发宿主、成功/失败/超时/可处理中断与 CI 契约。real 共 6 项，all 共 25 项（23 组编号，其中 ISO-01/02 分 fast/real），不证明 M5/M6 或未执行的平台。

两平台 CI 分别运行 fast 与 real，不预先初始化本机配置；完整 `ci` 先运行环境 all，再运行类型检查和 L1–L5。CI 报告只引用本次环境/L4/L5 的独立报告路径，并检查完整用例集合、逐项结果和清理证据；退出 0 但缺报告、缺项、重复、skip 或写报告失败均不通过。环境入口不回调整条 ci。报告不自动上传，平台通过与否以实际执行结果为准。

## 一次性测试生命周期（M4）

L4/L5 通过同一 `runIsolatedTest` 创建 `.tmp/<suite>/run-*`，原子预留全新 home。`--home` 必须是仓库 `.tmp` 内的新目录，祖先链接、既有目录及与开发/配置中正式 home 的重叠均拒绝；两次或并发运行各有 home、store、日志和随机端口。测试仅使用公开 Web profile 与自己的 fixture，不加载开发 patch。

测试子进程清理继承的 DSH（仅保留解析后的浏览器选择）、npm_config、pnpm、Corepack 及 XDG 配置覆盖；显式设置 user/global npmrc、pnpm store/cache/home 和 XDG config/data 目录。DSH 从运行目录启动，避免消费仓库的安装配置；pnpm 内部命令走已选定 shim。保留系统 HOME/USERPROFILE 等正常变量，避免破坏 Chrome 的用户目录判断。L2 打包也使用已解析 pnpm 和独立包管理器配置。

成功默认删除本次 home（包括显式 `--home`）、store/cache、shim、配置及 workspace，保留报告、日志、截图和 trace；`--keep` 保留成功数据，失败保留现场。清理先核对路径，再用 lstat 解除链接，不遍历到插件源码。清理失败记为独立失败步骤。报告含版本、平台/Node、宿主入口、起止时间、逐步结果和清理状态，`last-report.json` 仅作便利索引；并发 CI 使用回调拿到各自准确报告路径。

异步进程等待支持 SIGINT/SIGTERM，退出时等待自己启动的进程树并检查已知 HTTP 端口关闭。Windows 使用活跃子进程的 PID 配合 taskkill /T；Unix 为测试子进程建立独立进程组。Windows 测试通过子进程内部派发 SIGINT 验证可处理的中断路径；强制终止 supervisor、断电和磁盘不可写不承诺生成完整报告。无法创建/写入报告时命令失败，不借用旧报告。原始日志只留本地，汇总与错误输出移除认证 token。
