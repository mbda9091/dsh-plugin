# dsh-plugin

开发测试入口为 `node scripts/dev.mjs`；安装入口为 `node scripts/install.mjs install --profile NAME`。无参数显示各自帮助。安装自动解析已准备好的 Node/DSH 环境，日常启动由用户管理。


为 DeepSeek Harness（DSH）编写的自定义插件，提供桌面重启、审批提醒和任务完成通知。

每个插件都是独立的 npm 包和 Cordis bundle，可以按需安装到 DSH profile，单独启停。本仓库保存插件源码、构建脚本和文档，使用前需要安装 DSH 并构建插件。

## 插件一览

| 插件 | 用途 | 适用形态 | 平台 |
| --- | --- | --- | --- |
| [app-restart](app-restart/README.md) | 在对话中输入 `/restart`，重启桌面应用及 Host | 桌面 | Windows |
| [desktop-notify](desktop-notify/README.md) | 审批申请、任务完成或出错时弹出系统通知，可播放提示音 | 桌面 | Windows |
| [notify-web](notify-web/README.md) | 浏览器系统通知；点击后聚焦标签页并切换到对应会话 | Web | Windows、macOS、Linux |

完整场景声明见 [CATALOG.md](CATALOG.md)。平台支持按各插件的 `dsh.targets` 判断。2026-11-06 宿主升级轮次的 macOS 完整 CI 通过记录见[历史验收](docs/testing-plan.md#1910-dsh-022-rc1-整体适配2026-11-06)，不代表后续入口重构已全量验收。入口拆分轮次已按用户确认的 macOS 范围完成，验收基线 `4049f6f` 的完整 CI 通过；Windows/Linux 与真实 DSH 沙箱暂缓，详见[分离方案记录](docs/development-delivery-separation-plan.md)。真实 Desktop 和个人日常 profile 不作为本轮已验收结果。

## 准备环境

- DeepSeek Harness：当前开发与类型依赖版本为 **`0.2.2-rc.1`**，开发宿主由 workspace 冻结安装，无需全局 DSH；正式桌面应用单独管理。
- Node.js **24**、pnpm **11.28.5**；下面的依赖安装命令要求 pnpm 在 PATH 中可用。

2026-11-06 查询 npm `latest` 得到 `0.2.2-rc.1`，仓库使用该精确版本及锁文件保证可复现安装。宿主、插件类型包和真实环境测试版本同步；未来升级仍先解析 `latest` 再更新精确版本。`pnpm-workspace.yaml` 允许新增 WebSocket 原生依赖构建；可选 Kerberos 模块默认不构建，因为其 node-gyp 在带空格的用户目录下编译失败。普通 Web 与代理功能不依赖它；需要 Negotiate/SPNEGO 代理认证时，须在支持的本机环境单独启用并验证 Kerberos 构建。

普通 Node 24 需要在 PATH 中，或使用绝对路径启动脚本。无需 config init 或 local.json；工具按命令需要解析。pnpm 默认自动发现，支持 npm 与 Corepack 安装，不需要手填绝对路径；`--pnpm-script` 仅保留为可选覆盖。详见[环境输入](docs/configuration-v2.md)。

```sh
git clone https://github.com/mbda9091/dsh-plugin.git
cd dsh-plugin
pnpm install --frozen-lockfile
node scripts/dev.mjs build
```

构建会检查插件场景声明、插件目录和 TypeScript 类型，生成各插件的 `lib/`。`lib/`、`dist/` 和 `node_modules/` 均不入库。

`pnpm-workspace.yaml` 显式决定依赖安装脚本，允许 esbuild 和 DSH 所需的 node-pty、koffi、spawn-helper 准备，拒绝非必需脚本。peer 依赖随宿主解析并锁定，否则公开 DSH 缺少启动服务。新增需要安装脚本的依赖时，应单独检查并更新该清单。

快速环境检查使用 `node scripts/dev.mjs test-env --suite fast`；完整验证使用 `node scripts/dev.mjs ci`。

## 安装到桌面应用

构建完成后，打开 DSH 的 **Plugins（插件）** 页面，按需安装对应插件目录的绝对路径。例如，在仓库根目录执行以下命令取得桌面通知插件的路径：

```sh
node -p "require('node:path').resolve('desktop-notify')"
```

把输出填入插件安装页面。桌面场景可选择 `desktop-notify` 和 `app-restart`；Web 通知使用单独的 `notify-web`。

替换已加载的 Host 代码或安装包后，按宿主提示重启 DSH；更新 Client 代码后刷新页面。`/restart` 会中断正在进行的回合。

## 启动 Web

Web 需要**普通 Node 版 DSH CLI**。桌面应用自带的 Electron CLI 不适用于此启动器。

从仓库根目录执行：

```sh
# 初始化持久开发环境，再构建安装兼容 Web 插件
node scripts/dev.mjs dev-web init
node scripts/dev.mjs dev-install

node scripts/dev.mjs dev-web
# 另一个终端查看/停止；停止保留会话和配置
node scripts/dev.mjs dev-web status
node scripts/dev.mjs dev-web stop
# 默认只预览；添加 --yes 才停止自己的实例并清理开发数据
node scripts/dev.mjs dev-web reset
```

开发只使用 workspace 锁定的普通 Node DSH。缺依赖时先冻结安装，不接受 `--dsh-cli` 或日常环境变量重定向。`dev-web` 默认使用随机空闲端口，可用 `--port 0` 选择空闲端口；重复启动或端口占用会报错。

日常启动入口已移除；安装及配置加载见 [指定 profile 安装](docs/profile-install.md)。开发仍使用 `dev-web`，测试仍使用独立临时 home/profile。

浏览器通知需要允许站点通知权限，并保持标签页打开。完整参数、配置层序和 Windows 排障见 [Web 配置与启动说明](profiles/web/README.md)。

## 配置职责

内部开发测试使用仓库声明、默认值和命令参数，不读取用户安装目标。安装只要求 profile，其余从当前 Node/DSH 环境解析或显式覆盖，不建立新的本机配置文件。旧配置保留但不读取。

## 开发与打包

开发 link 固定进入受管 Web profile；正式 tarball 必须选择完整目标。执行桌面目标安装前，先完全退出桌面应用，避免 profile 文件被占用。

```sh
# 预览目标过滤和安装命令
node scripts/dev.mjs dev-install --dry-run

# 构建并以 link 方式安装兼容插件
node scripts/dev.mjs dev-install

# 安装当前 tarball；缓存失效时构建打包，不要求功能验收证据
node scripts/install.mjs install --profile my-web --dry-run
node scripts/install.mjs install --profile my-web
node scripts/install.mjs status --profile my-web
```

开发链接使用仓库构建产物；tarball 安装使用打包副本，可用 `--only @mbda9091/包名` 选择子集。交付报告位于 `dist/consumption/run-*/report.json`，分开记录文件、bundle/配置行、加载和能力验证；部分失败不自动回滚或重启。输入来源与安装恢复规则见 [环境输入](docs/configuration-v2.md)。切换安装方式使用 add 覆盖与 update，避免手工删除 `link:` 依赖。

## 验证

```sh
# 类型与元数据检查
node scripts/dev.mjs build --check

# 完整本地检查：独立环境 all → 类型检查 → L1–L3 → L4 → L5
node scripts/dev.mjs ci
```

`ci` 先核验本次 CFG/TOOL/DEV/ISO 环境报告，再执行插件功能回归；环境 all 包含一次独立冻结安装，需要网络。单独快速验证可运行 `node scripts/dev.mjs test-env --suite fast`，定向验证支持 `--only ISO-01,ISO-02`。L4/L5 成功清理可变数据但保留报告/日志，失败或 `--keep` 保留现场；报告路径收录在 `.tmp/ci/last-report.json`。平台验收进度见[环境计划](docs/development-environment-plan.md)。

L1–L3 覆盖逻辑、包契约和集成行为；L4 使用一次性 profile 验证真实 DSH 安装与加载；L5 通过 Playwright 验证 Web 交互和通知。L4/L5 使用 workspace 普通 Node 版 DSH 和按需解析的 pnpm；L5 默认使用 Chrome，可用 `--test-browser` / `--test-browser-path` 覆盖，Chromium 需先通过 Playwright 安装。`--timeout` 控制测试操作和浏览器场景的超时。测试说明和环境覆盖参数见 [测试方案](docs/testing-plan.md)。

GitHub Actions 在 Windows、macOS 和 Linux runner 上准备 Node、pnpm 和冻结依赖后运行同一套检查。测试产物保存在本机或临时 CI runner 的 `.tmp/`，不自动上传日志、截图或 trace。

最新入口拆分轮次的验收记录见 [分离方案](docs/development-delivery-separation-plan.md)；宿主升级轮次见 [测试方案 §19.10](docs/testing-plan.md#1910-dsh-022-rc1-整体适配2026-11-06)，各自保留历史基线和失败原因；尚未完成的建设见 [§20](docs/testing-plan.md#20-当前未完成事项)。

## 文档

- [插件目录与适用场景](CATALOG.md)
- [DSH 的 bundle、patch 与 profile](docs/dsh-concepts.md)
- [插件场景声明与运行时守卫](docs/plugin-targets.md)
- [通知机制与设计记录](docs/archive/notification-host-design.md)
- [仓库开发约定](AGENTS.md)

## 许可证

[BSD 3-Clause](LICENSE)。

## Linux 开发

使用普通 Node 24 和 pnpm 11.28.5；在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
node scripts/dev.mjs build --check
node scripts/dev.mjs dev-install
node scripts/dev.mjs dev-web --no-open
```

Corepack 安装也自动发现 pnpm，无需初始化 JSON 或填写 pnpm 绝对路径；工具版本必须匹配仓库声明。

启动器打印访问地址；有桌面会话时可去掉 `--no-open`，通过 `xdg-open` 打开默认浏览器。自动化测试可用 `node node_modules/playwright-core/cli.js install --with-deps chromium` 准备浏览器及系统依赖。

Linux 支持 `notify-web`。通过 `node scripts/install.mjs install --profile <名称>` 安装到外部 profile，平台默认识别为 Linux；不要求固定产物验收证据，固定包验收由内部测试负责。`app-restart`、`desktop-notify` 仅适用于 Windows 桌面端。日常 DSH 启动由用户自行管理；仓库的 `web`、`daily-launcher` 入口已移除，开发环境使用 `dev-web`。

### WSL 默认工作区与验收边界

DSH 首次启动会通过 `xdg-user-dir DOCUMENTS` 查找文档目录。WSL 未配置该目录时可能返回用户主目录，宿主会拒绝创建默认工作区并显示提示。新建开发环境现在显式使用 `.local/dsh-dev/home/documents`；L5 使用本次 `.tmp/l5/run-*/workspace/documents`，并检查默认工作区确实创建，避免写入个人 Documents。

已有开发环境的 patch 会保留，不自动重写。需要修复时先备份 `.local/dsh-dev/cordis.patch.yml` 为同目录 `cordis.patch.yml.bak`，再在该受管开发 patch 中设置：

```yaml
- id: workspace-controller
  config:
    documentsDirectory: '/绝对路径/dsh-plugin/.local/dsh-dev/home/documents'
```

日常目标可通过界面显式选择工作目录；仓库命令不会改动其个人目录设置。WSL 的 Windows VS Code 命令可能被宿主发现但没有 Linux desktop entry 图标，宿主以通用图标回退；此项不通过修改宿主依赖或伪造图标解决。

完整真实环境验收须显式选择 Chromium：
```sh
node scripts/dev.mjs test-env --suite real --test-browser chromium
```
Windows 浏览器中的实际系统通知、点击聚焦仍需桌面人工验收；无头测试只替换系统 Notification API，不证明操作系统弹窗行为。
