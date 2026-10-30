# 插件适用场景：desktop / web 与 mac / windows

> 本文定义本仓库的 `dsh.targets` 约定。dsh 0.2.1-rc.2 本身没有“适用场景”元数据：
> 内置插件管理器读取展示信息时只认 locale 的 `meta.title` / `meta.description` / `icon`，
> `evaluatePluginCompatibility` 只校验 `engines.dsh` / DSH peer 版本，
> `dsh.client.platform` 只用于 Client bundle 且只接受 `"web"`。
> 所以适用场景由本仓库自己声明、校验和展示，dsh 不参与解释。

> **阶段 1 已落地**：`dsh.targets` 声明、`node scripts/bootstrap.mjs check-targets` 校验、`CATALOG.md` 目录。
> **阶段 2 已落地**：安装过滤（`dev-install` / `stable-install` / `status`）与运行时守卫（各插件的 `src/targets.ts`）。
> **阶段 3（可选）**：插件管理器里的 UI 徽章 / 按场景页面；当前不做。

## 1. 两个正交维度

| 字段 | 取值 | 含义 |
|---|---|---|
| `surfaces` | `desktop` / `web` 的非空精确集合 | 插件**实际能运行**的形态 |
| `platforms` | `windows` / `mac` 的非空精确集合 | 插件**实际能运行**的操作系统 |

两个维度互相独立，例如：

- `["desktop"]` + `["windows"]`：只在桌面应用的 Windows 上运行；
- `["desktop","web"]` + `["mac","windows"]`：桌面和 Web、macOS 和 Windows 都能运行（通用 + 通用平台）；
- `["web"]` + `["mac","windows"]`：只在 Web 形态运行，不保证桌面应用里可用。

**`web` 表示“只在 Web 形态可用”，不是“Web UI 插件”。**
桌面应用内嵌的是同一套 Web UI；一个纯 Client 插件如果桌面里也能渲染，必须写
`["desktop","web"]`，显示为“通用”。只有确实依赖 `dsh web` 的插件才写 `["web"]`。

`headless` 和 `linux` 是保留值，当前校验不接受；等出现对应插件时再扩展校验、标签和目录。

## 2. 声明位置

每个插件的 `package.json` 必须有 `dsh.targets`：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "targets": {
      "surfaces": ["desktop"],
      "platforms": ["windows"]
    }
  }
}
```

约束：

- `surfaces` / `platforms` 都是非空数组，不允许重复项；
- 只允许本文列出的值；`headless`、`linux` 暂不接受；
- 不允许 `dsh.targets` 里出现未定义字段；
- 如果一个 bundle 里同时有不同场景的行，拆成多个 bundle；**一个 bundle 一个场景 envelope**；
- `dsh.targets` 不是版本兼容声明。版本兼容仍然用 `engines.dsh` / DSH peer，两者互不替代。

## 3. 展示标签与前缀

| 声明 | 中文 | English |
|---|---|---|
| `surfaces: ["desktop"]` | 桌面 | Desktop |
| `surfaces: ["web"]` | Web | Web |
| `surfaces: ["desktop","web"]` | 通用 | Universal |
| `platforms: ["windows"]` | Windows | Windows |
| `platforms: ["mac"]` | macOS | macOS |
| `platforms: ["mac","windows"]` | 通用平台 | All platforms |

locale 的 `meta.description` 必须以对应场景前缀开头，方便在内置插件管理器的卡片上直接看到：

```
【桌面 · Windows】一句话描述
[Desktop · Windows] One-line description

【Web · 通用平台】...
[Web · All platforms] ...

【通用 · 通用平台】...
[Universal · All platforms] ...
```

前缀由 `node scripts/bootstrap.mjs check-targets` 和 `dsh.targets` 交叉校验，防止元数据和描述漂移。

## 4. 校验

```sh
node scripts/bootstrap.mjs check-targets
```

检查内容：

- `package.json` 是 bundle，且存在合法的 `dsh.targets`；
- `surfaces` / `platforms` 取值、非空、无重复；
- 没有未定义字段；
- 有 `dsh.client` 时，`platform` 必须是 `web`（这是 Client bundle 的加载平台，不是 surface）；
- `locale/zh.json`、`locale/en.json` 的 `meta.description` 以场景前缀开头；
- `README.md` 有 `## 适用场景` 一节。

`node scripts/bootstrap.mjs build`（包括 `--check`）会先调用它，再检查 `CATALOG.md` 是否最新，最后才跑 `tsc`。

## 5. 运行时判定

在 Host 的 `apply` 第一行调用包内的 `assertTarget(ctx, pluginName)`；它读取自己的 `package.json`，与当前环境比较；不匹配就抛错，让该行变成 `failed`，不要静默无操作。

每个有 Host 入口的插件有一份自包含的 `src/targets.ts`，导出：

- `evaluateTarget(targets, environment)`：纯函数，便于测试 web/mac 分支；
- `detectEnvironment(ctx)`：检测当前 surface/platform（`apply` 时可用）；
- `assertTarget(ctx, pluginName)`：读取 `dsh.targets`、检测环境、抛错。

错误形如：

```
[desktop-notify] target mismatch: declared surfaces=desktop platforms=windows; current surface=web platform=windows
```

| 当前形态 | 判定 |
|---|---|
| `desktop` | Host 进程内 `process.versions.electron` 存在（桌面 Host 由 Electron 以 `ELECTRON_RUN_AS_NODE` 启动） |
| `web` | 不是 desktop，且 `profileContext.startedBundles` 包含 `@deepseek-ai/dsh-web-app`（Web bundle） |
| `headless` | 两者都不满足（保留，当前不声明） |

| 当前平台 | 判定 |
|---|---|
| `windows` | `process.platform === 'win32'` |
| `mac` | `process.platform === 'darwin'` |
| `linux` | `process.platform === 'linux'`（保留，当前不声明） |

注意：

- **不要用 profile 名判断形态**：profile 可以自定义、改名；
- **不要用 `ctx.get('webServer')` 判断 web**：`webServer` 服务在插件 `apply` 执行时还没有就绪（实测 `apply` 时 `false`、约 1.5 s 后为 `true`），此前按它判断会把 Web Host 误判成 `headless`；桌面 Host 同样有 `webServer`，因此也不能用它区分 desktop；
- **不要用 `ELECTRON_RUN_AS_NODE` 环境变量判断桌面**：它会泄漏到子进程；在 Host 进程内用 `process.versions.electron`；
- Web 判定使用 profile 组合后的 `startedBundles`：`dsh web` 会加载 `@deepseek-ai/dsh-web-app`，该列表在插件激活时已可用。自定义 Web bundle 名只要以 `/dsh-web-app` 结尾也能识别；
- **用默认 Node 的 `dsh web` 启动 Web**：桌面安装自带的 CLI 把 Host 跑在 Electron 引擎里，`process.versions.electron` 仍存在，会被判为 `desktop`。初始化优先从 PATH 发现普通 Node CLI，仓库 `node scripts/bootstrap.mjs web` 与 L4 读取已配置的工具路径；
- Client 侧不要用 `navigator` 猜平台；由 Host 判定并通过服务或首屏数据告知 Client。

## 6. 安装过滤与自由组合

组合的单位是 bundle。dsh 已经支持任意启用/停用 bundle，不需要发明新的组合格式；只需要按目标过滤：

- `node scripts/bootstrap.mjs dev-install` / `stable-install` 增加 `--surface desktop|web`、`--platform windows|mac`；
- 默认值：`--platform` 取当前系统，`--surface` 从 profile 名 `desktop`/`web` 推断；自定义 profile 必须显式传 `--surface`；
- 默认只安装目标兼容的插件，跳过时打印 `requires ...`；`--all` 才强制安装不兼容插件；
- desktop profile 安装“桌面 + 平台”和“通用 + 平台”的插件；
- web profile 安装“Web + 平台”和“通用 + 平台”的插件；
- `node scripts/bootstrap.mjs status` 增加同样的 `--surface` / `--platform`，显示每个插件的声明目标和 `compatible` / `skip`。

跳过不等于卸载：已经装在 profile 里的不兼容插件不会被脚本删除；用 `status` 查看，再到插件管理器里停用或移除。不要对 `link:` 依赖执行自动删除。

不建议把 `disabled: !!js "process.platform !== 'win32'"` 作为主机制：它只是静默禁用，插件管理器不会说明原因，profile 层还能覆盖。它可以作为极少数场景的兜底，不能替代安装过滤和运行时守卫。

## 7. 当前插件的取值

| 插件 | surfaces | platforms | 原因 |
|---|---|---|---|
| `@local/app-restart` | `["desktop"]` | `["windows"]` | 使用 WMI / Windows Script Host 重启桌面应用 |
| `@local/approval-allowlist` | `["desktop","web"]` | `["mac","windows"]` | Host 侧审批 waterfall，不依赖 Windows API |
| `@local/desktop-notify` | `["desktop"]` | `["windows"]` | 使用 Windows PowerShell WinRT 通知绑定 |
| `@local/notify-web` | `["web"]` | `["mac","windows"]` | Host 统一判断并通过认证 SSE 投递，浏览器 `Notification` 展示 |

## 8. 不采用的做法

- 不用 `dsh.client.platform` 表达 Host 插件的 surface：它只描述 Client bundle，且只接受 `"web"`；
- 不用 `engines.dsh` 表达 OS / surface：它只表达 dsh 版本兼容；
- 不把 `os` / `cpu` 当作唯一机制：pnpm 能拒绝安装，但错误不友好，也表达不了 surface；
- 不用 profile 名判断形态；
- 不修改内置插件管理器：它在 `app.asar` 里，升级会被覆盖。需要徽章/页面时用官方的
  `plugins.detail.badge` / `plugins.detail.section` / `plugins.tab` 扩展点写伴生插件；这属于阶段 3，当前不做。当前用 locale 描述前缀 + `CATALOG.md` 展示。

## 9. 相关文件

- [`node scripts/bootstrap.mjs check-targets`](../scripts/src/commands/check-targets.ts)：声明校验；
- [`node scripts/bootstrap.mjs catalog`](../scripts/src/commands/catalog.ts)：生成 [`CATALOG.md`](../CATALOG.md)；
- [`node scripts/bootstrap.mjs dev-install`](../scripts/src/commands/install.ts)、[`node scripts/bootstrap.mjs stable-install`](../scripts/src/commands/install.ts)：按目标过滤安装；
- [`node scripts/bootstrap.mjs status`](../scripts/src/commands/status.ts)：显示声明目标与当前兼容性；
- [`node scripts/bootstrap.mjs build`](../scripts/src/commands/build.ts)：构建入口，串联上述检查；
- [`AGENTS.md`](../AGENTS.md)：插件开发规则与检查清单。
