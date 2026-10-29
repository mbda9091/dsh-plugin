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

完整场景声明见 [CATALOG.md](CATALOG.md)。平台支持按各插件的 `dsh.targets` 判断；当前本机配置机制已在 Windows 验收，macOS 的实际启动仍需在对应环境验证。

## 准备环境

- DeepSeek Harness：当前开发与类型依赖版本为 **`0.2.1-rc.2`**。
- Node.js **24**、pnpm **11.28.5**；下面的依赖安装命令要求 pnpm 在 PATH 中可用。
- PowerShell **7**：用于运行仓库的 `.ps1` 入口。

PowerShell 脚本会尝试定位 DSH 自带的 Node/pnpm，也支持部分环境变量覆盖。DSH 版本升级时，应同步核对插件使用的类型包与运行时接口。

```powershell
git clone https://github.com/mbda9091/dsh-plugin.git
cd dsh-plugin
pnpm install --frozen-lockfile
pwsh -File scripts/build.ps1
```

构建会检查插件场景声明、插件目录和 TypeScript 类型，生成各插件的 `lib/`。`lib/`、`dist/` 和 `node_modules/` 均不入库。

## 安装到桌面应用

构建完成后，打开 DSH 的 **Plugins（插件）** 页面，按需安装对应插件目录的绝对路径。例如，在仓库根目录执行以下命令取得桌面通知插件的路径：

```powershell
(Resolve-Path ./desktop-notify).Path
```

把输出填入插件安装页面。桌面场景可选择 `desktop-notify`、`app-restart` 和 `approval-allowlist`；Web 通知使用单独的 `notify-web`。

替换已加载的 Host 代码或安装包后，按宿主提示重启 DSH；更新 Client 代码后刷新页面。`/restart` 会中断正在进行的回合。

## 启动 Web

Web 需要**普通 Node 版 DSH CLI**。桌面应用自带的 Electron CLI 不适用于此启动器。

从仓库根目录执行：

```powershell
# 查看工具探测结果，不写入本机配置
pwsh -File scripts/config.ps1 init --dry-run

# 根据 example 生成本机配置，再检查格式与路径
pwsh -File scripts/config.ps1 init
pwsh -File scripts/config.ps1 check

# 默认 Web patch 使用 notify-web，启动前先安装到 web profile
$config = Get-Content scripts/config/local.json -Raw | ConvertFrom-Json
& $config.tools.dshCli plugin --profile web add (Join-Path $PWD 'notify-web')

pwsh -File profiles/web/start.ps1
```

若无法自动定位普通 Node 版 CLI，可在初始化时传入 `--dsh-cli <CLI绝对路径>`。不使用通知插件时，删除本机 Web patch 中的 `notify-web` 行后再启动。

浏览器通知需要允许站点通知权限，并保持标签页打开。完整参数、配置层序和 Windows 排障见 [Web 配置与启动说明](profiles/web/README.md)。

## 本机配置与模板

| 提交到仓库的模板 | 初始化生成的本机文件 | 用途 |
| --- | --- | --- |
| `scripts/config/example.json` | `scripts/config/local.json` | 工具路径、浏览器偏好和启动参数 |
| `profiles/web/cordis.patch.example.yml` | `profiles/web/cordis.local.patch.yml` | HMR 路径、Web 插件配置和个人规则 |

本机文件已被 Git 忽略。运行时读取本机文件，**不会合并 example**；重复 `init` 不覆盖已有配置。配置格式由 `scripts/config/schema.json` 校验，支持的覆盖顺序为 **命令行参数 → 环境变量 → 本机配置**。

目前配置机制已接入初始化、检查和 Web 启动；构建、安装、状态及测试入口仍沿用现有工具定位逻辑。详见 [本机配置设计与实施进度](docs/local-configuration-design.md)。

审批白名单默认保持观察模式，需要自行配置具体规则才会自动放行。个人路径、凭据和审批规则应留在本机配置中；带认证参数的启动地址及运行日志也不应提交。

## 开发与打包

以下以 `desktop` profile 为例。执行桌面 CLI 安装前，先完全退出桌面应用，避免 profile 文件被占用。

```powershell
# 预览目标过滤和安装命令
pwsh -File scripts/dev-install.ps1 -Profile desktop -Surface desktop -DryRun

# 构建并以 link 方式安装兼容插件
pwsh -File scripts/dev-install.ps1 -Profile desktop -Surface desktop

# 构建并打包到 dist/，再切换到 tarball 安装
pwsh -File scripts/pack.ps1
pwsh -File scripts/stable-install.ps1 -Profile desktop -Surface desktop

# 查看安装模式及目标兼容性
pwsh -File scripts/status.ps1 -Profile desktop -Surface desktop
```

开发链接使用仓库构建产物；tarball 安装使用打包副本。切换安装方式时使用脚本覆盖同名依赖，避免手工删除 `link:` 依赖。需要的共享逻辑会在构建时内联进插件。

## 验证

```powershell
# 类型与元数据检查
pwsh -File scripts/build.ps1 -Check

# 完整本地检查：类型检查 → L1–L3 → L4 → L5
pwsh -File scripts/ci.ps1
```

L1–L3 覆盖逻辑、包契约和集成行为；L4 使用一次性 profile 验证真实 DSH 安装与加载；L5 通过 Playwright 验证 Web 交互和通知。L4/L5 需要可用的普通 Node 版 DSH，L5 默认使用系统 Chrome。测试说明和环境覆盖参数见 [测试方案](docs/testing-plan.md)。

GitHub Actions 在 Windows 和 macOS 上运行同一套检查。测试产物保存在本机或临时 CI runner 的 `.tmp/`，不自动上传日志、截图或 trace。

## 文档

- [插件目录与适用场景](CATALOG.md)
- [DSH 的 bundle、patch 与 profile](docs/dsh-concepts.md)
- [插件场景声明与运行时守卫](docs/plugin-targets.md)
- [通知机制与设计记录](docs/notification-host-design.md)
- [仓库开发约定](AGENTS.md)

## 许可证

[BSD 3-Clause](LICENSE)。
