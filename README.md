# dsh-plugin

为 DeepSeek Harness（DSH）编写的自定义插件，提供桌面重启、审批提醒、任务完成通知和精确调用审批白名单。

每个插件都是独立的 npm 包和 Cordis bundle，可以按需安装到 DSH profile，单独启停。本仓库保存插件源码、构建脚本和文档，使用前需要安装 DSH 并构建插件。

## 插件一览

| 插件 | 用途 | 适用形态 | 平台 |
| --- | --- | --- | --- |
| [app-restart](app-restart/README.md) | 在对话中输入 `/restart`，重启桌面应用及 Host | 桌面 | Windows |
| [desktop-notify](desktop-notify/README.md) | 审批申请、任务完成或出错时弹出系统通知，可播放提示音 | 桌面 | Windows |
| [notify-web](notify-web/README.md) | 浏览器系统通知；点击后聚焦标签页并切换到对应会话 | Web | Windows、macOS |
| [approval-allowlist](approval-allowlist/README.md) | 按工具名和调用参数匹配审批规则，默认只观察、不自动放行 | 桌面、Web | Windows、macOS |

完整场景声明见 [CATALOG.md](CATALOG.md)。平台支持按各插件的 `dsh.targets` 判断；Windows、macOS 的远端类型检查与 L1–L5 已通过，包含真实 DSH Web 与 Chromium。系统原生通知、桌面 Electron 行为及日常浏览器启动仍需按场景另行验收。

## 准备环境

- DeepSeek Harness：当前开发与类型依赖版本为 **`0.2.1-rc.2`**，开发宿主由 workspace 冻结安装，无需全局 DSH；正式桌面应用单独管理。
- Node.js **24**、pnpm **11.28.5**；下面的依赖安装命令要求 pnpm 在 PATH 中可用。

统一入口为 `node scripts/bootstrap.mjs <command>`。普通 Node 24 需要在 PATH 中，或使用其绝对路径启动；不通过 `DSH_NODE` 选择运行时。编译器、pnpm 和开发 DSH 使用当前 Node。`config init` 只从 PATH 发现 pnpm 包脚本及系统浏览器，不扫描私有 runtime；无法发现时显式提供 `--pnpm-script <pnpm包>/bin/pnpm.cjs`。例如用 npm 全局安装指定 pnpm 后，包位于 `npm root -g` 输出目录下。准备说明和 v1 迁移见 [配置 v2](docs/configuration-v2.md)。

```sh
git clone https://github.com/mbda9091/dsh-plugin.git
cd dsh-plugin
pnpm install --frozen-lockfile
node scripts/bootstrap.mjs config init
node scripts/bootstrap.mjs build
```

构建会检查插件场景声明、插件目录和 TypeScript 类型，生成各插件的 `lib/`。`lib/`、`dist/` 和 `node_modules/` 均不入库。

`pnpm-workspace.yaml` 显式决定依赖安装脚本，允许 esbuild 和 DSH 所需的 node-pty、koffi、spawn-helper 准备，拒绝非必需脚本。peer 依赖随宿主解析并锁定，否则公开 DSH 缺少启动服务。新增需要安装脚本的依赖时，应单独检查并更新该清单。

`config check` 输出工具版本、实际入口、来源及使用范围。独立环境测试使用 `test-env --suite fast`；真实冻结安装、宿主/pnpm/包内容及开发生命周期验证使用 `test-env --suite real --pnpm-script <路径>`，不读取本机配置。

## 安装到桌面应用

构建完成后，打开 DSH 的 **Plugins（插件）** 页面，按需安装对应插件目录的绝对路径。例如，在仓库根目录执行以下命令取得桌面通知插件的路径：

```sh
node -p "require('node:path').resolve('desktop-notify')"
```

把输出填入插件安装页面。桌面场景可选择 `desktop-notify`、`app-restart` 和 `approval-allowlist`；Web 通知使用单独的 `notify-web`。

替换已加载的 Host 代码或安装包后，按宿主提示重启 DSH；更新 Client 代码后刷新页面。`/restart` 会中断正在进行的回合。

## 启动 Web

Web 需要**普通 Node 版 DSH CLI**。桌面应用自带的 Electron CLI 不适用于此启动器。

从仓库根目录执行：

```sh
# 查看工具探测结果，不写入本机配置
node scripts/bootstrap.mjs config init --dry-run

# 根据 example 生成本机配置，再检查格式与路径
node scripts/bootstrap.mjs config init
node scripts/bootstrap.mjs config check

# 初始化持久开发环境，再构建安装兼容 Web 插件
node scripts/bootstrap.mjs web init
node scripts/bootstrap.mjs dev-install

node scripts/bootstrap.mjs web
# 另一个终端查看/停止；停止保留会话和配置
node scripts/bootstrap.mjs web status
node scripts/bootstrap.mjs web stop
# 默认只预览；添加 --yes 才停止自己的实例并清理开发数据
node scripts/bootstrap.mjs web reset
```

开发只使用 workspace 锁定的普通 Node DSH。缺依赖时先冻结安装，不接受 `--dsh-cli` 或日常环境变量重定向。`web` 默认监听 `127.0.0.1:3000`，可用 `--port 0` 选择空闲端口；重复启动或端口占用会报错。

浏览器通知需要允许站点通知权限，并保持标签页打开。完整参数、配置层序和 Windows 排障见 [Web 配置与启动说明](profiles/web/README.md)。

## 本机配置与模板

| 提交到仓库的模板 | 初始化生成的本机文件 | 用途 |
| --- | --- | --- |
| `scripts/config/example.json` | `scripts/config/local.json` | 工具路径、浏览器偏好和启动参数 |
| `profiles/web/cordis.dev.patch.yml` | `.local/dsh-dev/cordis.patch.yml` | `web init` 生成的开发 HMR 配置；不会导入旧个人 patch |

本机文件已被 Git 忽略。运行时读取本机文件，**不会合并 example**；重复 `init` 不覆盖已有配置。配置格式由 `scripts/config/schema.json` 校验，支持的覆盖顺序为 **命令行参数 → 环境变量 → 本机配置**。

配置机制已接入 Web、构建、打包、安装、状态及测试入口。已有 `version: 1` 配置需显式运行 `config migrate --dry-run` 和 `config migrate`。L4/L5 使用一次性 profile，不加载个人或持久开发 patch。详见 [配置 v2](docs/configuration-v2.md)。

审批白名单默认保持观察模式，需要自行配置具体规则才会自动放行。个人路径、凭据和审批规则应留在本机配置中；带认证参数的启动地址及运行日志也不应提交。

## 开发与打包

开发 link 固定进入受管 Web profile；正式 tarball 必须选择完整目标。执行桌面目标安装前，先完全退出桌面应用，避免 profile 文件被占用。

```sh
# 预览目标过滤和安装命令
node scripts/bootstrap.mjs dev-install --dry-run

# 构建并以 link 方式安装兼容插件
node scripts/bootstrap.mjs dev-install

# 构建并打包到 dist/，再切换到 tarball 安装
node scripts/bootstrap.mjs pack
node scripts/bootstrap.mjs stable-install --target daily

# 查看安装模式及目标兼容性
node scripts/bootstrap.mjs status --target daily
```

开发链接使用仓库构建产物；tarball 安装使用打包副本。切换安装方式时使用脚本覆盖同名依赖，避免手工删除 `link:` 依赖。需要的共享逻辑会在构建时内联进插件。

## 验证

```sh
# 类型与元数据检查
node scripts/bootstrap.mjs build --check

# 完整本地检查：独立环境 all → 类型检查 → L1–L3 → L4 → L5
node scripts/bootstrap.mjs ci
```

`ci` 先核验本次 CFG/TOOL/DEV/ISO 环境报告，再执行插件功能回归；环境 all 包含一次独立冻结安装，需要网络。单独快速验证可运行 `node scripts/bootstrap.mjs test-env --suite fast`，定向验证支持 `--only ISO-01,ISO-02`。L4/L5 成功清理可变数据但保留报告/日志，失败或 `--keep` 保留现场；报告路径收录在 `.tmp/ci/last-report.json`。平台验收进度见[环境计划](docs/development-environment-plan.md)。

L1–L3 覆盖逻辑、包契约和集成行为；L4 使用一次性 profile 验证真实 DSH 安装与加载；L5 通过 Playwright 验证 Web 交互和通知。L4/L5 需要普通 Node 版 DSH 和配置中的 pnpm，L5 使用 `test.browser` / `test.browserPath`；Chromium 需先通过 Playwright 安装。`test.timeoutMs` 控制测试操作和浏览器场景的超时。测试说明和环境覆盖参数见 [测试方案](docs/testing-plan.md)。

GitHub Actions 在 Windows 和 macOS runner 上先初始化各自的本机配置，再运行同一套检查。测试产物保存在本机或临时 CI runner 的 `.tmp/`，不自动上传日志、截图或 trace。

已确认通过的基线：[`d9f2a12`，2026-10-30 的 Windows/macOS CI](https://github.com/mbda9091/dsh-plugin/actions/runs/41061844806)。验收范围见 [测试方案 §19.7](docs/testing-plan.md#197-远端-ci-验收2026-10-30)；尚未完成的建设见 [§20](docs/testing-plan.md#20-当前未完成事项)。该记录对应指定提交，不代表后续每次运行自动通过。

## 文档

- [插件目录与适用场景](CATALOG.md)
- [DSH 的 bundle、patch 与 profile](docs/dsh-concepts.md)
- [插件场景声明与运行时守卫](docs/plugin-targets.md)
- [通知机制与设计记录](docs/notification-host-design.md)
- [仓库开发约定](AGENTS.md)

## 许可证

[BSD 3-Clause](LICENSE)。
