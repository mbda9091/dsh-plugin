# Web profile 本机配置

先从 example 初始化本机配置，再启动 Web。配置机制和后续阶段见 [本机配置方案](../../docs/local-configuration-design.md)。以下命令从仓库根目录执行；需要 Node 24 和 workspace 开发依赖，无需 PowerShell 7。

## 首次使用

```sh
# 检查将选中的工具和准备生成的文件，不写配置
node scripts/bootstrap.mjs config init --dry-run

# 生成本机 JSON 和 Web patch；已有文件不会被覆盖
node scripts/bootstrap.mjs config init

# 构建插件，再检查配置中的路径
node scripts/bootstrap.mjs build
node scripts/bootstrap.mjs config check
```

Web 必须使用普通 Node 版 DSH。初始化按显式参数、已有环境变量、PATH 顺序选择，并检查 CLI 启动脚本；Electron 版和无法识别的 wrapper 会被拒绝。如果 PATH 上只有桌面版，先定位普通 Node 版的 `dsh.cmd`，通过 `--dsh-cli <绝对路径>` 或 `DSH_CLI` 指定。

初始化可选参数：`--dsh-cli`、`--pnpm-script`、`--browser edge|default`、`--browser-path`、`--test-browser chrome|chromium`、`--test-browser-path`。路径相对于仓库根目录解析；`pnpm-script` 必须指向 `pnpm.cjs`。显式路径无效会报错，不会静默改选其他安装。

默认 Web patch 包含 `notify-web` 参数，因此启动前需安装它。可用 Node CLI 安装当前兼容的 Web 插件（`notify-web` 和 `approval-allowlist`）：

```sh
node scripts/bootstrap.mjs dev-install --profile web --surface web
```

也可在插件管理页填写插件目录的绝对路径。暂时不用通知插件时，删除本地 patch 中的 `notify-web` 行。初始化和启动器都不安装插件、不改实际 profile 的依赖记录。

```sh
node scripts/bootstrap.mjs web
node scripts/bootstrap.mjs web --no-open --port 8080
```

旧的 `start.ps1` 已移除。个人 `dshweb` 函数或快捷方式需改为调用 `node <repo>/scripts/bootstrap.mjs web` 并转发参数；从其他工作目录启动时使用 bootstrap 的绝对路径。Node 不在 PATH 时也使用其绝对路径。运行中的服务不会自动读取新文件。

## 哪个文件负责什么

| 文件 | 用途 |
|---|---|
| `scripts/config/example.json` | 脚本配置模板，只供初始化使用 |
| `scripts/config/schema.json` | 脚本配置校验与编辑器提示 |
| `scripts/config/local.json` | 本机工具位置、浏览器偏好、启动参数，不入库 |
| `profiles/web/cordis.patch.example.yml` | Web patch 模板，只在 HMR 路径中支持 `${repoRoot}` |
| `profiles/web/cordis.local.patch.yml` | 本机 HMR 路径、通知和个人插件参数，不入库 |

运行时只读本机文件，不与 example 合并；更新模板不会改变个人配置。没有本机文件会提示初始化。重复 `init` 保留已有文件；如果只存在一份，则报错并要求先检查、备份，不补写另一份。

`check` 检查配置格式、版本、有效工具路径和 YAML 结构，不运行 YAML 的 `!!js`，也不执行 DSH 配置合成。目录搬迁、HMR 目录缺失或动态路径无法静态验证时会提示，并返回非零退出码。插件安装、激活状态与表达式执行结果仍需实际启动验证。

本机文件可直接编辑：

```json
{
  "$schema": "./schema.json",
  "version": 1,
  "tools": { "dshCli": null, "pnpmScript": null },
  "web": {
    "browser": "default",
    "browserPath": null,
    "openBrowser": false,
    "startupTimeoutMs": 30000
  },
  "test": { "browser": "chromium", "browserPath": null, "timeoutMs": 120000 }
}
```

这是结构示例，实际文件中的 `tools.dshCli` 应由初始化填入可用路径，或在运行时显式覆盖。路径填 `null` 不表示运行时重新探测；需要使用的工具未配置会报错。`web.browser=default` 使用系统浏览器，`browserPath` 在该模式下不使用；`--no-open` 不要求浏览器可用。`test` 字段供 L4/L5 使用；测试只读取本机 JSON 中的工具和测试参数，不加载这份个人 Web patch。

脚本设置优先级为 **命令行参数 > 已支持的环境变量 > 本机配置**。已有环境变量映射为 `DSH_CLI`、`DSH_PNPM`、`CHROME_PATH`、`DSH_E2E_BROWSER`；`.env` 不会自动加载。配置中的相对路径相对于仓库根目录，和终端工作目录无关。

启动器参数：`--open` / `--no-open`、`--dsh-cli`、`--browser`、`--browser-path`、`--startup-timeout <毫秒>`。`--host`、`--port` 等其他参数透传到 `dsh web`。命令行覆盖只对本次运行生效，不写回配置。

## 加载与重载

`node scripts/bootstrap.mjs web` 读取本机配置后，直接启动普通 Node Host：

```text
dsh web --patch <仓库>/profiles/web/cordis.local.patch.yml --no-open
```

启动器等待 DSH 输出地址，按配置打开浏览器，并等待服务结束。启动等待超时、启动失败或终端发出中断信号时会停止自己启动的 Host。为读取地址而使用的操作系统临时日志退出后清理；不在 `.tmp/web` 生成配置文件。

调用方通过 PATH 或 Node 绝对路径选择运行时，不再读取 `DSH_NODE`。构建、打包、安装、状态和测试均读取统一配置。Windows 默认浏览器通过系统 URL handler 打开，macOS 通过 `open`；指定 Edge 时直接启动其可执行文件。

本地 patch 属于最后的 `--patch` 层：bundle → profile → home → 本地 patch。同一行的 `config` **整体替换，不深合并**；个人审批规则和私有参数写在本地文件。启动参数中的 patch 是启动时读取的快照，修改后要重启服务。

HMR 只监听四个插件的 `lib/`，保留 Windows 和依赖目录排除规则。构建后才有可监听的代码；新增插件时在本地 patch 中明确增加其 `lib/` 绝对路径，不使用 `*/lib` 通配发现。仓库搬家后，先运行 `check`，备份后修改本地路径；第一阶段没有自动 repair。

`link:` 安装使用仓库构建产物；tarball 安装使用包内副本，需重新打包安装才能更新。HMR 不代表所有配置都能热重载：入口加载失败、包解析变化或宿主提示 `restart-required` 时需重启。Client 构建更新后仍需刷新浏览器。

通知默认开启审批、完成与错误通知，审批等待 300ms；心跳 15 秒、补发窗口 120 秒、缓存和单连接队列上限均为 256。浏览器站点通知权限需要单独允许；Host 加载成功不代表系统通知权限已授予。

## Windows 上安装依赖时报 `ENOENT scandir ..._tmp_...\node_modules`

本机 dsh `0.2.1-rc.2` 的 HMR 将 `path.relative()` 返回的 Windows 反斜杠路径直接交给 picomatch，默认的 `**/node_modules` / `**/.*` 因此可能不匹配。尤其 profile 在 C 盘、仓库在 D 盘时，依赖和隐藏目录都会被监听。监听器持有子目录句柄，pnpm 的 hoisted 安装移动旧依赖目录时先遇到 `EPERM rename`，随后其合并回退又扫描不存在的临时目录，最终显示 `ENOENT scandir`。

本目录的 patch 已将代码监听范围收窄为各插件的 `lib/`，同时显式保留默认排除规则，并补充 Windows 反斜杠规则。这里的 `**\\node_modules` 使用 YAML 单引号，两个反斜杠原样传给 picomatch，用于匹配路径中的一个反斜杠；不要改成单个反斜杠。

更新 patch 后，先停止并重新启动使用本 patch 的 Web 服务，使旧监听句柄释放，再在普通终端重跑原来的 `pnpm install`。如果暂时不需要 Web 服务，也可停止它后直接安装。仅更换终端或退出桌面窗口不够：独立的 Web 服务也可能仍在运行。

不需要删除锁文件、清空 store、修改 ACL 或更换 Node/pnpm。全新 `node_modules` 偶尔成功只是没有触发旧嵌套依赖的移动，不能作为长期修复。

已用 dsh 自带的 chokidar / picomatch、Node `24.21.0`、pnpm `11.28.5` 做隔离对照：

| 条件 | 结果 |
|---|---|
| 原排除规则，监听包含嵌套依赖的目录 | 复现相同 `ENOENT`，原始错误为 `EPERM rename` |
| 关闭该监听器，原失败目录直接重试 | 安装成功，无需清理目录或缓存 |
| 加入本 patch 的 Windows 排除规则，保持监听 | 安装成功，依赖目录没有被监听 |
| 修复后修改插件 `lib/*.js` | 仍收到代码变化事件 |

上游根治应在 HMR 匹配前把相对路径分隔符统一成 `/`，或显式配置 picomatch 的 Windows 路径支持；pnpm 还应保留首次移动失败的原因，避免用后续 `ENOENT` 遮盖它。
