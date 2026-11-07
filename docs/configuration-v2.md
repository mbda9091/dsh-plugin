# 开发测试与安装：输入和环境

开发测试使用 `node scripts/dev.mjs <命令>`；安装与查看使用 `node scripts/install.mjs install|status --profile NAME`。两个入口分别解析参数，不读取 `scripts/config/local.json`，不要求 `config init`，也不使用命名目标配置。旧 bootstrap、config 和 target 命令不再执行业务。

## 内部开发测试

先准备普通 Node 24、根 packageManager 指定的 pnpm 和冻结依赖：

```sh
pnpm install --frozen-lockfile
node scripts/dev.mjs build --check
node scripts/dev.mjs dev-install
node scripts/dev.mjs dev-web --no-open
node scripts/dev.mjs test
node scripts/dev.mjs ci
```

内部使用 workspace 精确声明的 DSH，开发 home 位于 `.local/dsh-dev/home`，测试使用 `.tmp` 内一次性 home/profile。日常 DSH/profile 环境变量不会重定向这些命令。安装自己的依赖、模型配置、浏览器等仍由调用者准备；不自动下载或修复工具。

| 设置 | 默认与覆盖 |
|---|---|
| Node / DSH / pnpm 版本 | 根 package.json 与 lockfile；当前 Node 24、DSH 0.2.2-rc.1、pnpm 11.28.5 |
| pnpm 脚本 | 默认自动发现 npm/Corepack 安装；可选 `--pnpm-script` > `DSH_PNPM` 覆盖；需要时检查版本 |
| 开发浏览器 | Edge；未指定路径且找不到 Edge 时用系统默认浏览器；`--browser` / `--browser-path` 覆盖 |
| 开发启动 | 打开浏览器、超时 30000 ms；`--no-open` / `--startup-timeout` 覆盖 |
| 测试浏览器 | Chrome；`--test-browser` > `DSH_E2E_BROWSER`，路径 `--test-browser-path` > `CHROME_PATH` > 系统 Chrome 发现 |
| 测试超时 | 120000 ms；`--timeout` 覆盖；环境 test-env 使用各用例独立超时 |

Corepack 安装无需手填路径：脚本在仓库目录中用当前 Node 调用已识别的 Corepack pnpm 入口，通过 `pnpm exec` 获取实际执行文件，再校验包身份和精确版本。探测禁止联网下载和自动修改 packageManager，不扫描缓存；未准备好对应版本时直接报错。build 不要求 pnpm 或浏览器；L2/pack/install 等才检查 pnpm；L5/完整 CI 才需要测试浏览器。选择 Chromium 时先准备 Playwright 对应浏览器。

Corepack 与 npm global prefix 探测通过 `.tmp/tool-probes` 内的临时文件捕获输出，兼容禁止管道 stdio 的 DSH 沙箱；结束后清理本次探测文件。status 也可能执行该工具发现过程，但不写目标 profile。

安装仓库当前 Playwright 版本匹配的 Chromium（包括无界面测试组件）：

```sh
node node_modules/playwright-core/cli.js install chromium
node scripts/dev.mjs l5 --test-browser chromium
```

无需新增 JSON；也可设置 `DSH_E2E_BROWSER=chromium` 供后续测试使用。若 pnpm 无法自动发现，在命令中补 `--pnpm-script <pnpm包>/bin/pnpm.cjs`，或设置 `DSH_PNPM`。浏览器下载到 Playwright 的本机缓存；升级 Playwright 后按需重新执行安装命令。

完整 CI 执行环境 fast/real → 类型检查 → L1–L3 → L4 → L5，核对报告，失败即停止。真实环境套件需要网络和本地端口。L4 默认包括 tarball 安装验证，verify-artifacts 可验收固定清单；不使用用户日常 profile。

包管理沿用系统 registry、代理、证书、缓存和 store；隔离的是 DSH 数据与插件依赖关系，不清理共享缓存。

## 安装到指定 profile

```sh
node scripts/install.mjs install --profile my-web --dry-run
node scripts/install.mjs install --profile my-web
node scripts/install.mjs status --profile my-web
```

`profile` 必填。只支持本机 Web；platform 默认当前系统，可显式传 `mac` / `windows`，不匹配时报错。`--surface`、`--target` 已移除。

外部 DSH 默认从当前 Node 的 npm 全局包布局解析，PATH 中同一 Node 的别名可参与定位；存在配套 npm 时，以当前 Node 执行 `npm prefix --global` 读取全局安装前缀（包括 Windows 的 AppData 布局），workspace DSH 不可作为安装宿主；缺失、多个候选或不支持的布局要求显式 `--dsh-cli`。不扫描 Electron 或其他私人 runtime。

home 遵循 DSH 0.2.2-rc.1 的 dsh-home-paths 规则：`--home` > `DSH_HOME` > `~/.dsh`，支持 `~`、`~/`、`~\\`；相对路径按启动时 cwd 解析。`DSH_PROFILE` 不补齐必填 profile，`DSH_PROFILE_DIR` 不覆盖计算结果，`DSH_CLI` 不覆盖宿主选择。解析值和来源会在执行前显示。

目标 profile 必须已经存在，宿主版本必须匹配仓库声明。install 保留缓存复用及必要时构建打包，不自动跑功能验收；status 只读，不构建或安装。完整参数、默认 patch 与失败行为见[安装指南](profile-install.md)。

## 旧配置

旧 local.json、个人 patch、备份、锁和 pending 不再被新入口读取，也不自动删除。保留的配置迁移源码和旧 schema 仅供历史测试/恢复参考，不提供 CLI 维护入口。旧事务有残留时，由用户先核对进程、备份 manifest 和哈希，人工处理；新流程不认领或迁移旧数据。

历史设计见[归档](archive/local-configuration-design.md)，本轮实施与验收见[分离方案](development-delivery-separation-plan.md)。
