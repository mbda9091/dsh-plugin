# 本机配置 v2：字段、命令与迁移

M1/M2 实现协议（2026-10-31）。对应[环境计划](development-environment-plan.md)。M2 已加入锁定开发依赖与工具检查；M3 的开发生命周期、M5/M6 的产物验收与目标管理尚未交付。

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

`web` 只表示开发浏览器偏好，不包含个人 YAML。开发数据地址由上下文固定为 `.local/dsh-dev/home`、`store`、profile `web`；Web patch 地址为 `.local/dsh-dev/cordis.patch.yml`。M3 将交付数据初始化和生命周期；M1 不自动导入或生成个人 patch，受管 patch 缺失会明确失败。

## 命令和覆盖矩阵

所有命令通过 `node scripts/bootstrap.mjs`。适用字段的优先级为显式参数 > 下表允许的环境变量 > 磁盘值。大小写不同的环境键统一识别；父进程环境不修改。未列出的显式参数由解析器拒绝。

| 命令 | 上下文与参数 | 环境变量 |
|---|---|---|
| `config init` | 只创建 JSON；支持 `--dry-run`、`--pnpm-script`、`--browser`、`--browser-path`、`--test-browser`、`--test-browser-path`、`--test-timeout` | 不把临时 DSH/pnpm/browser 覆盖保存回配置；允许使用系统位置发现浏览器 |
| `config check` | 校验磁盘 v2/事务状态，输出工具诊断；不接受覆盖、不要求 DSH/pnpm 已安装 | 不使用运行时覆盖 |
| `config migrate [--dry-run]` | 只读取磁盘旧值；不依赖 DSH/pnpm，不启动工具探测 | 不使用运行时覆盖 |
| `build`、`pack`、`test` | 工具上下文；`--pnpm-script` | `DSH_PNPM` |
| `web` | 开发上下文；`--open/--no-open`、`--browser`、`--browser-path`、`--startup-timeout`、`--host`、`--port` | `DSH_PNPM`；无浏览器变量覆盖 |
| `dev-install` | 开发上下文；只安装开发 home；`--pnpm-script`、`--dry-run`、`--skip-build`、`--all` | `DSH_PNPM` |
| `l4`、`l5`、`ci` | 测试上下文；`--pnpm-script`、`--test-browser`、`--test-browser-path`、`--timeout`、`--keep` | `DSH_PNPM`、`DSH_E2E_BROWSER`、`CHROME_PATH` |
| `stable-install`、`status` | 目标上下文；`--target NAME`，或完整的 `--dsh-cli PATH --home DIR --profile NAME --surface desktop\|web --platform windows\|mac`，两种方式互斥 | 仅 `DSH_PNPM`；不从环境变量拼目标 |
| `test-env --suite fast` | 无本机配置依赖；可用 `--keep` 保留成功 fixture | 不从个人配置获得被测值 |
| `test-env --suite real\|all` | 无本机配置依赖；显式 `--pnpm-script PATH`，可用 `--keep`；需网络、Git 和 tar | 不从个人配置获得被测值；子进程使用独立 home/store/userconfig |
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

`test-env --suite fast` 只编译 `test/tsconfig.environment.json`，运行 CFG-01–06 和 TOOL-01/02/03/05。报告及每组证据写入 `.tmp/environment-tests/run-*/`。不要求 init、插件 build、DSH 执行或浏览器。成功清理 fixture、失败保留、`--keep` 保留成功现场；缺用例证据、skip、清理失败都会失败。

`test-env --suite real --pnpm-script <path>` 执行 TOOL-04，包含 TOOL-03/05 的真实断言：导出 Git 跟踪及未忽略的当前源码（不复制本机配置、产物或 node_modules），在独立用户目录/store 中冻结安装，探测公开 CLI、profile 初始化及内部 pnpm，构建并检查 notify-web tarball。选定 pnpm 包复制进临时工具目录，子进程 PATH 无全局 DSH/私有 runtime；不安装或切换用户工具。`TOOL-04-details.json` 记录版本、Node 调用轨迹、步骤与包内容。`all` 合并两套用例，不代表 M3–M6 已验收。

两平台 CI 分别运行 fast 与 real，不预先初始化本机配置；功能 CI 直接使用锁定 workspace DSH，已移除全局 DSH 与临时 add 过渡步骤。报告不自动上传。平台通过与否以实际 CI 结果为准。
