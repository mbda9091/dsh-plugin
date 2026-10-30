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

- DeepSeek Harness：当前开发与类型依赖版本为 **`0.2.1-rc.2`**。
- Node.js **24**、pnpm **11.28.5**；下面的依赖安装命令要求 pnpm 在 PATH 中可用。

统一入口为 `node scripts/bootstrap.mjs <command>`。Node 24 需要在 PATH 中，或使用 Node 可执行文件的绝对路径启动；仓库不再提供 PowerShell 启动脚本，也不通过 `DSH_NODE` 选择运行时。首次运行 `config init` 会发现 DSH、pnpm 和浏览器位置；日常命令使用已保存的配置。DSH 版本升级时，应同步核对类型包与运行时接口。

```sh
git clone https://github.com/mbda9091/dsh-plugin.git
cd dsh-plugin
pnpm install --frozen-lockfile
node scripts/bootstrap.mjs config init
node scripts/bootstrap.mjs build
```

构建会检查插件场景声明、插件目录和 TypeScript 类型，生成各插件的 `lib/`。`lib/`、`dist/` 和 `node_modules/` 均不入库。

`pnpm-workspace.yaml` 中的 `allowBuilds` 仅允许 esbuild 执行安装脚本，让本机与 CI 的依赖安装无需交互审批。新增需要安装脚本的依赖时，应单独检查并更新该清单。

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

# 默认 Web patch 使用 notify-web，启动前先安装兼容的 Web 插件
node scripts/bootstrap.mjs dev-install --profile web --surface web

node scripts/bootstrap.mjs web
```

若无法自动定位普通 Node 版 CLI，可在初始化时传入 `--dsh-cli <CLI绝对路径>`。不使用通知插件时，删除本机 Web patch 中的 `notify-web` 行后再启动。

浏览器通知需要允许站点通知权限，并保持标签页打开。完整参数、配置层序和 Windows 排障见 [Web 配置与启动说明](profiles/web/README.md)。

## 本机配置与模板

| 提交到仓库的模板 | 初始化生成的本机文件 | 用途 |
| --- | --- | --- |
| `scripts/config/example.json` | `scripts/config/local.json` | 工具路径、浏览器偏好和启动参数 |
| `profiles/web/cordis.patch.example.yml` | `profiles/web/cordis.local.patch.yml` | HMR 路径、Web 插件配置和个人规则 |

本机文件已被 Git 忽略。运行时读取本机文件，**不会合并 example**；重复 `init` 不覆盖已有配置。配置格式由 `scripts/config/schema.json` 校验，支持的覆盖顺序为 **命令行参数 → 环境变量 → 本机配置**。

配置机制已接入 Web、构建、打包、安装、状态及测试入口。已有 `version: 1` 本机配置可继续使用，无需重新生成。L4/L5 只读取工具和测试设置，使用一次性 profile，不加载个人 Web patch。详见 [本机配置设计与实施进度](docs/local-configuration-design.md)。

审批白名单默认保持观察模式，需要自行配置具体规则才会自动放行。个人路径、凭据和审批规则应留在本机配置中；带认证参数的启动地址及运行日志也不应提交。

## 开发与打包

以下以 `desktop` profile 为例。执行桌面 CLI 安装前，先完全退出桌面应用，避免 profile 文件被占用。

```sh
# 预览目标过滤和安装命令
node scripts/bootstrap.mjs dev-install --profile desktop --surface desktop --dry-run

# 构建并以 link 方式安装兼容插件
node scripts/bootstrap.mjs dev-install --profile desktop --surface desktop

# 构建并打包到 dist/，再切换到 tarball 安装
node scripts/bootstrap.mjs pack
node scripts/bootstrap.mjs stable-install --profile desktop --surface desktop

# 查看安装模式及目标兼容性
node scripts/bootstrap.mjs status --profile desktop --surface desktop
```

开发链接使用仓库构建产物；tarball 安装使用打包副本。切换安装方式时使用脚本覆盖同名依赖，避免手工删除 `link:` 依赖。需要的共享逻辑会在构建时内联进插件。

## 验证

```sh
# 类型与元数据检查
node scripts/bootstrap.mjs build --check

# 完整本地检查：类型检查 → L1–L3 → L4 → L5
node scripts/bootstrap.mjs ci
```

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
