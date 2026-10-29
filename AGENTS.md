# AGENTS.md

本文件是本仓库的工作约定，供在本仓库中工作的 agent 与开发者阅读。**所有自定义 DeepSeek Harness (dsh) 插件都在这里实现，每个插件单独一个顶层目录。**

> 概念与机制（bundle / patch / profile 的定义、安装与配置流程）见 [docs/dsh-concepts.md](docs/dsh-concepts.md)。本文件只讲规则，那份文档解释"为什么"。

## 1. 仓库定位

- 本仓库是 **dsh 自定义插件仓库**，不是 dsh 本体，也不是 dsh 的 fork。
- 每个插件是一个独立的 npm 包 + Cordis bundle，可以单独安装到 dsh profile、单独启停、单独删除。
- 插件通过 **bundle patch** 把 loader 行插入 profile，通过 **Host 插件入口** 注册工具/服务/事件钩子，通过 **Client 模块** 往 Web UI 的 slot 里渲染界面。
- 仓库只保存插件源码与文档；不保存 `node_modules`、`lib/`、`dist/`，不打包含 dsh 本体的产物。

## 2. 运行环境（运行时解析）

| 项 | 值 |
|---|---|
| dsh 版本 | `0.2.1-rc.2` |
| profile | `$env:DSH_PROFILE`；安装脚本未指定时默认 `desktop` |
| profile 目录 | `$env:DSH_PROFILE_DIR`，否则由 home 与目标 profile 名组合 |
| `DSH_HOME` | `$env:DSH_HOME`，未指定时为用户目录下的 `.dsh` |
| Web GUI | `$env:DSH_WEB_URL` 或启动器打印的地址；带认证信息的地址不入库 |
| 平台 | Windows / PowerShell 7（`pwsh`） |
| 本仓库 | 从脚本位置解析；文档中的 `<repo>` 表示本机仓库绝对路径 |

**这些值会随安装和会话变化**：优先读 `$env:DSH_PROFILE`、`$env:DSH_PROFILE_DIR`、`$env:DSH_HOME`、`$env:DSH_WEB_URL`，不要把上表当成永久常量写进代码。

本机同时存在两种 `dsh`：PATH 上的 npm 全局版（默认 Node 运行时）和桌面安装自带的 Electron 版。**`dsh web` 优先用 PATH 上的默认 Node 版**（`profiles/web/start.ps1` 与 L4 都按此顺序）：Electron 版会让 `process.versions.electron` 存在，插件的场景守卫会把 Web Host 判成 `desktop`。`DSH_CLI` 可覆盖两者。

本机可用的运行时工具（`node`/`pnpm` 未加入 PATH）：

```powershell
# 构建 / 类型检查（脚本会自动找 DSH 运行时的 node 和 pnpm）
pwsh -File .\scripts\build.ps1
pwsh -File .\scripts\build.ps1 -Check

# 临时跑脚本（Node 24）
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node --version

# dsh CLI（管理插件；desktop 的合成配置不能用 --dump-config 读取，
# 它由 Electron 独占管理 —— 要看合成的行树，用 dsh --profile web --dump-config）
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop list
```

> dsh 的包、技能、模板都打包在 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar` 内。普通 shell 命令（`ls`、`cat`、`node`、pnpm）读不到 asar 里的文件；需要查文档时，用 dsh 自带的 `cordis-plugin-development` / `cordis-composition-reference` 技能，或运行时给出的实现路径。

## 3. 目录约定

```
dsh-plugin/
├── AGENTS.md
├── .gitignore
├── .gitattributes
├── docs/                     # 概念文档（dsh-concepts.md、plugin-targets.md），非规则
├── CATALOG.md                # 由 scripts/src/commands/catalog.ts 生成的插件场景目录
├── package.json              # workspace root：私有、无运行时依赖
├── pnpm-workspace.yaml
├── tsconfig.base.json        # 共享编译选项
├── scripts/
│   ├── bootstrap.mjs         # 唯一手写 JS：用 tsc 编译 scripts/src 后运行 CLI
│   ├── tsconfig.json         # scripts/src → scripts/.build（产物不入库）
│   ├── src/                  # TS 脚本层：cli.ts + core/ + commands/（含 test/l4）
│   ├── build.ps1             # 薄壳 → bootstrap.mjs build
│   ├── pack.ps1              # build + pnpm pack → dist/*.tgz
│   ├── dev-install.ps1       # link 安装（开发）
│   ├── stable-install.ps1    # 安装 tarball（稳定版）
│   ├── status.ps1            # 薄壳 → bootstrap.mjs status
│   ├── check-targets.ps1     # 薄壳 → bootstrap.mjs check-targets
│   ├── catalog.ps1           # 薄壳 → bootstrap.mjs catalog
│   └── common.ps1            # 仍由 pack / dev-install / stable-install 使用
├── profiles/web/             # 仓库内 web profile 的 patch 与启动脚本（不是插件）
├── packages/                 # 非插件的 workspace 私有共享库（不进 CATALOG）
│   ├── notify-core/          # 通知内容/locale；构建期内联进插件
│   └── notify-host/          # 通知触发逻辑；构建期内联进 desktop-notify / notify-web
├── test/                     # L1–L5 测试：src/（node:test）、fixtures/、e2e/（Playwright）；不是插件，不进 CATALOG
├── my-first-plugin/          # 一个插件一个目录；目录名 = 插件 id
│   ├── package.json
│   ├── tsconfig.json
│   ├── build.json            # 可选：声明 esbuild 的 host/client bundle
│   ├── src/index.ts          # Host 入口（Cordis 插件，TypeScript）
│   ├── src/client.ts         # 可选：纯逻辑、无 import 的 Web UI 入口（tsc → lib/client.js）
│   ├── src/client/index.ts   # 可选：可 import 共享库的 Web UI 入口（esbuild → lib/client.js）
│   ├── client.js             # 可选：需要 React/JSX 的 Web UI 入口（手写 JS）
│   ├── lib/                  # 构建产物，不入库（build.ps1 生成，安装/打包前必须有）
│   ├── cordis.patch.yml      # bundle patch：把行插入 profile
│   ├── locale/en.json
│   ├── locale/zh.json
│   ├── icon.svg
│   └── README.md
└── another-plugin/
    └── ...
```

规则：

1. **顶层目录即插件**，目录名用 `kebab-case`。目录名、包名后缀、loader 行 `id` 三者保持一致，例如目录 `todo-badge` ↔ 包名 `@local/todo-badge` ↔ 行 `id: todo-badge`。
2. 仓库根目录只放仓库级文件（`AGENTS.md`、`.gitignore`、`.gitattributes`、workspace 配置、`scripts/`）、`packages/` 下的非插件共享库和插件目录。
3. **插件必须自包含**：不能从自己目录之外相对导入（安装时插件目录会被单独链接/复制到 profile，跨目录导入会失效）。需要共用代码时，把它复制/内联进各插件，或后续单独引入共享包方案（见 §8）。
4. 删除插件 = 删除目录，并在插件管理器里移除对应 bundle；profile 里的依赖记录由插件管理器负责回收，别手工改。
5. **仓库只存源码**：`lib/`（`tsc` 产物）和 `dist/`（`pnpm pack` 产物）都不入库，由 `scripts/build.ps1`、`scripts/pack.ps1` 生成。出问题按 构建 → 打包 → 安装 的顺序定位，不要用"提交产物"来保留上一次能跑的状态。

## 4. 插件形态

按需要的扩展点选择最小形态：

| 形态 | 需要的文件 | 用途 |
|---|---|---|
| Host-only | `src/index.ts` + patch | 注册工具（`ctx.tools`）、服务、事件钩子、系统提示片段、session projection |
| Configuration-only | 仅 patch | 连接 MCP、`insert` 新行（**不能覆盖 profile 配置**，见下） |
| UI 插件 | `src/index.ts` + `client.js` 或 `src/client.ts` + `dsh.client` | 在 Web UI 的 slot 里渲染页面/面板/装饰 |

所有形态都是 bundle：`package.json` 里声明 `dsh.bundle.patch`，安装时由插件管理器把它加入 profile 的 bundle 列表。

**禁用：用 configuration-only bundle 承载 profile 配置。**

原因：dsh 的 patch 层序是 **bundle 层 → profile 层 → home 层 → `--patch`**，profile 的 `cordis.patch.yml` **永远晚于所有 bundle**。所以 bundle 里的同 id 配置只有两种结局：被 profile 静默覆盖而失效；或者为了生效而清空 profile，让本机失去覆盖手段。详见 [docs/dsh-concepts.md](docs/dsh-concepts.md) §2.1 与 §4.4。

本机配置直接写在 profile 的 `cordis.patch.yml`，改动前备份为同目录的 `cordis.patch.yml.bak`。纯配置 bundle 只允许用于 `insert` 新行（如接 MCP）等不与 profile 冲突的场景。

### 4.1 适用场景（必填）

每个插件必须在 `package.json` 的 `dsh.targets` 声明它能运行的形态和平台：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "targets": {
    "surfaces": ["desktop"],
    "platforms": ["windows"]
  }
}
```

- `surfaces` 是精确集合：`["desktop"]`（桌面）、`["web"]`（仅 Web 形态）、`["desktop","web"]`（通用）。`web` **不表示**“Web UI 插件”：桌面内嵌同一套 Web UI，纯 Client 插件如果桌面里也能渲染，必须同时写 `desktop` 和 `web`。
- `platforms` 是精确集合：`["windows"]`、`["mac"]`、`["mac","windows"]`（通用平台）。
- `headless`、`linux` 是保留值；当前 `scripts/check-targets.ps1` 不接受，等有对应插件再启用。
- 一个 bundle 只承载一个场景 envelope；混合就拆包。
- 声明由 `scripts/check-targets.ps1` 校验，`build.ps1` 会调用；`CATALOG.md` 由 `scripts/catalog.ps1` 生成，不要手改。
- 安装过滤与运行时守卫已落地；UI 徽章/页面属于阶段 3，当前不做。两者都必须读取 `dsh.targets`，不得另写一份环境判断。语义见 [docs/plugin-targets.md](docs/plugin-targets.md)。

## 5. 文件模板

### 5.1 `package.json`（Host-only，TS）

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "一句话说明这个插件做什么",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "lib/**/*.js", "lib/**/*.js.map", "lib/**/*.d.ts", "lib/**/*.d.ts.map",
    "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/dsh-agent": "0.2.1-rc.2",
    "@deepseek-ai/dsh-session": "0.2.1-rc.2",
    "@types/node": "^24.0.0",
    "typescript": "7.0.2"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "targets": {
      "surfaces": ["desktop"],
      "platforms": ["windows"]
    }
  }
}
```

UI 插件在此基础上增加：

```json
{
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "lib/**/*.js", "lib/**/*.js.map", "lib/**/*.d.ts", "lib/**/*.d.ts.map",
    "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "targets": {
      "surfaces": ["desktop", "web"],
      "platforms": ["mac", "windows"]
    },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

要点：

- `private: true`：这些包不发布到 registry。
- `dsh.targets` 必填，示例是桌面 Windows；通用插件写 `["desktop","web"]` / `["mac","windows"]`（UI 模板示例就是通用，locale 前缀按实际值写）。字段语义见 §4.1 与 [docs/plugin-targets.md](docs/plugin-targets.md)。
- `exports.types` 指向编译产物，`default` 指向 `lib/index.js`；loader 只加载 `lib`，**不要**把入口指回 `src/`。
- `files` 必须覆盖**所有运行时文件**；新增模块或资源时同步更新（本地目录安装是链接，不受 `files` 过滤，但打包/发布时会用到）。
- devDependencies 里的 DSH 类型包必须**与运行时版本一致**（当前 `0.2.1-rc.2`）；升级 dsh 后同步升级，否则类型和运行时漂移。
- `dsh.client.inject` 只用于决定 Client 模块的激活顺序，不是依赖声明。
- 运行时依赖保持零：类型包只放在 `devDependencies`，编译时擦除。

### 5.2 `cordis.patch.yml`

> **层序（重点）**：dsh 的 patch 应用顺序是 **bundle 层 → profile 层 → home 层 → `--patch`**。profile 的 patch **永远晚于所有 bundle**，同 id 时 profile 必胜。这就是"纯配置 bundle 不能承载 profile 配置覆盖"的原因（见 §4）。

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

- `insert` 把行追加到 profile；行 `name` 指向本包。
- 只有插件声明了 `Config` 时才写 `config`；否则省略。
- 覆盖已有内置行用 `id` 定位并**整体替换** `config`（不是深合并），所以要把该行需要的字段写全。
- 需要条件启用时可用 `disabled: !!js "..."`（Loader 表达式，不是 `!js`）。

### 5.3 `src/index.ts`（Host 入口）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
// 只为了激活类型增强：给 Context 加上 ctx.agents，给 SessionEventMap 加上 approval/*
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'

/** 配置字段；运行时不做校验，字段类型就是文档。 */
export interface Config {
  /** 是否在权限申请时通知。 */
  notifyOnApproval?: boolean
}

/** 默认值，和 Config 的字段保持一致。 */
const DEFAULTS: Required<Config> = {
  notifyOnApproval: true,
}

export const name = 'my-plugin'

export function apply(ctx: Context, config: Config = {}): void {
  const options = { ...DEFAULTS, ...config }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked') {
      // event.data.toolName / reason 由 DSH 的 SessionEventMap 提供真实类型
      void event.data.toolName
      void options.notifyOnApproval
    }
  }, { global: true })
}
```

`tsconfig.json`：

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib", "types": ["node"] },
  "include": ["src/**/*.ts"]
}
```

约定：

- **类型必须来自 DSH 包**，不要用 `object`、`unknown` 或手写 `any` 糊弄：`ctx` 用 `Context`，事件用监听器自动推导出的 `SessionEvent` 联合类型，`ctx.get('agents')` 靠 `import type {} from '@deepseek-ai/dsh-agent'` 增强后自动有 `AgentRegistry` 类型。
- 需要哪类事件，就 `import type {} from` 声明它的包（`approval/*` 来自 `dsh-user-approval`，`turn/end` 来自 `dsh-session`）；空导入只拉类型、不进运行时。
- `Config` 用 `interface` 描述并导出，运行时不做校验：字段注释就是文档，配置和 `cordis.patch.yml` 的示例保持一致即可。
- 使用 ESM，**不要同时** `export default` 和 `export function apply`：Loader 的 `unwrapExports` 会折叠模块并丢掉 `inject`。
- `inject` 只列真正需要的服务；注册即副作用，用 `ctx.effect()` / `ctx.on()` 承载并返回清理函数。注册到其他上下文（如 `agent.ctx`）时，同时在本插件的 effect 里保留 disposer。
- 事件监听：waterfall 类监听器（`agent/pre-step`、`llm/stream`、`tools/pre-execute` 等）不接管决策时必须 `return next()`；改写 `agent/pre-step` 的决策时要展开（`{ ...decision, messages }`）保留其他字段。
- 只拒绝而不改写用 `ctx.tools.guard()`；只隐藏工具用对应 agent 上下文上的 `ctx.tools.restrict()`；观察最终结果用 `tools/result`，不要用 `tools/post-execute` 单纯观察。
- 不要在 import 时做网络/磁盘/时间敏感操作；启动路径保持轻量。
- **场景守卫**：`apply` 第一行调用包内 `src/targets.ts` 的 `assertTarget(ctx, name)`；不匹配直接抛错，不要静默 return。守卫必须在任何注册表/命令/文件副作用之前。`detectEnvironment` 的判定是：`process.versions.electron` → `desktop`；否则 `profileContext.startedBundles` 含 `@deepseek-ai/dsh-web-app`（或以 `/dsh-web-app` 结尾）→ `web`；否则 `headless`。**不要用 `webServer`/`webStartup`**：它们在插件 `apply` 时尚未就绪。
- **不要手改 `lib/`**：它是 `tsc` 的产物，不入库；链接安装和打包前先跑 `scripts/build.ps1` 生成。

### 5.4 `client.js`（Web UI 入口）

浏览器侧由 `window.__ModuleLoader__` 直接加载一个 classic script，入口文件最终必须是 `client.js`（或 `lib/client.js`）。当前有三条路径：

- **需要 React/JSX 的 UI 插件**：暂时手写 `client.js` 并入库；Host 侧的 `tsc` 不参与它。等第一个这类插件出现时，再引入 esbuild 把 `src/client.tsx` 构建成 `client.js`（届时 `client.js` 变成构建产物、不入库）。
- **纯逻辑、无 JSX、无 import/export 的 Client 模块**：可以写 `src/client.ts`，由插件的 `tsc` 直接产出 `lib/client.js`。这种文件必须是一个 script，而不是 ES module：
  - `tsconfig.json` 里设置 `"moduleDetection": "legacy"`，并在 `lib` 中加入 `"DOM"`；
  - `src/client.ts` 内**不要写** `import`/`export`（否则 `tsc` 会产出 ESM，浏览器加载失败）；
  - `package.json` 的 `./client` 指向 `./lib/client.js`，`files` 用 `lib/**` 覆盖，不单独列根目录 `client.js`。
- **需要 import 共享库/多文件的 Client**（`notify-web` 使用）：写 `src/client/index.ts`，在 `build.json` 里声明 `"client": { "entry": "src/client/index.ts", "format": "iife" }`；`tsc` 只做类型检查，esbuild 把它和 `@local/notify-core` / `@local/notify-host` 一起打成 `lib/client.js`。

```js
window.__ModuleLoader__.load({
  id: '@local/my-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function MyPanel() {
      return h('div', { style: { padding: 8 } }, 'hello')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'my-plugin',
          order: 5,
        }, MyPanel))
      },
    }
  },
})
```

约定：

- 注册的 factory `id` 必须等于包名；React 从浏览器的模块表 `require('react')` 取，**不要**另装 React、引 CDN 或找 UMD。
- 不要 `require` 任何 `@deepseek-ai/dsh-client-*` 包；需要控件就按宿主样式自己写。
- 组件样式只用主题 token（`--dsw-alias-*`），不要硬编码颜色；插件的**图标/插画**可以有自己的配色。
- 不要替换应用根节点、不要向 `document.body` 追加节点、不要读写其他插件的 DOM。
- 在 slot 里渲染，用 slot props 提供的 selector 读取最小数据切片；可见文案走 Client 的 locale 服务。
- 组件内注册的样式/计时器/监听器要在 `apply` 里用 `ctx.effect`/`ctx.on` 管理，或作为 React 元素渲染以便卸载时移除。

### 5.5 本地化与图标

- `locale/en.json`、`locale/zh.json` 至少包含：

```json
{
  "meta": {
    "title": "插件标题",
    "description": "【桌面 · Windows】一句话描述这个插件的能力"
  }
}
```

- `meta.description` 必须以场景前缀开头，并与 `dsh.targets` 一致：
  - surface：`桌面`/`Desktop`、`Web`/`Web`、`通用`/`Universal`；
  - platform：`Windows`/`Windows`、`macOS`/`macOS`、`通用平台`/`All platforms`；
  - 组合成 `【桌面 · Windows】`、`【通用 · 通用平台】`，英文用 `[Desktop · Windows]`。
  `scripts/check-targets.ps1` 会检查。
- 图标：`icon.svg`（或 png/jpeg/webp），**必须放在包内**，≤ 256 KiB；自定义或确认可再分发，保留必要的署名。不要留模板占位图。
- 插件管理器与设置页在没有激活插件的情况下读取这些元数据，所以 `meta.title` / `meta.description` 要写真实内容。

### 5.6 `README.md`

每个插件目录都要有一份简短 README：用途、**适用场景**、配置项、安装方式、已知限制。不要复述 `AGENTS.md` 的通用规则。

## 6. 编写规则（重要）

1. **会话日志是唯一事实来源**：模型看到的内容必须能从已提交的 session event 重建；插件内存只是派生缓存。
2. **不要自造 session event 类型**：`Session.append()` 无法写 `ignorable: true`，未知类型会导致会话无法重新打开。需要派生状态时，用 `ctx.sessionProjections` 注册投影单元（`apply(state, event)` 纯同步、忽略事件时返回原引用）。
3. **扩展点从弱到强**：`ctx.tools.restrict()`（只能移除）< `ctx.tools.guard()`（只能拒绝）< waterfall 监听（可改写、依赖注册顺序）< `system-prompt/assemble`（整体替换）。选能满足需求的最弱机制。
4. **配置放 `Config`**，不要在代码里写死可调参数；用户的 patch 层在升级后仍然保留。
5. **性能**：不要轮询 `agent/status`，等待 `turn/end`、`tool/result` 等持久事件；派生状态放投影单元；计时器要能被清理。
6. **UI 即宿主 UI**：一个应用只有一个视觉体系，插件必须沿用宿主的主题 token、locale、间距和排版；先确定渲染位置（slot），再写视图。

## 7. 安装、重载与验证

### 7.1 安装

首选：Web UI 左侧 **Plugins（插件）** 页面，安装时填**插件目录的绝对路径**（如 `<repo>\my-plugin`）。插件管理器会：

1. 用 pnpm 把该目录作为依赖装进 profile；
2. 读取 `package.json` 的 `dsh.bundle.patch` 并把它加入 profile 的 bundle 列表；
3. 应用 patch，插入插件行。

在启用了 `plugin_manager` 工具的预设下，也可以让 agent 调 `install_bundle`，`target` 传绝对包目录。

备选（桌面版必须先**完全退出**，否则 profile 的 `package.json` 被占用）：

```powershell
& $dsh plugin --profile desktop add (Join-Path $PWD 'my-plugin')
```

这条命令是 pnpm 的透传：安装完成后，`dsh-plugin-manager` 会把新安装且声明了 `dsh.bundle` 的依赖自动加入 profile 的 bundle 列表；没有 `dsh.bundle` 的包只会作为普通依赖安装并给出警告。

**禁止**：

- 手工编辑 profile 的 `package.json` / `cordis.patch.yml`（管理器会覆盖你的改动，且容易和 bundle 层冲突）；
- 在 `$DSH_HOME` 下创建包；
- 在 profile 目录里直接跑 pnpm。

### 7.2 重载

- 新增 bundle：通常可通过 HMR 立即生效。
- **替换已安装的包、或修改了已加载的 Host 代码**：需要重启 dsh 才能加载新的 JS 模块代；插件管理器可能报 `restart-required`，这不是失败。
- 修改 Client 代码后，按界面提示刷新页面；不要假设 slot id 不变就代表新代码已加载。
- **模块加载失败会被缓存**：import 解析不到或顶层抛错时，Node 会缓存这个失败，修复后 HMR 也未必重试该入口，通常要重启（或更换入口文件）。所以在触发重载前先验证导入：
  - `node --preserve-symlinks --input-type=module -e "import('<入口绝对路径>')"`
  - 以及不带 `--preserve-symlinks` 的同一命令
- 开发期建议在 profile patch 里让 HMR 监听仓库，改代码/构建后自动重载，不必反复改 profile：
  ```yaml
  - id: hmr
    config:
      root: ['<repo>']
  ```

### 7.3 验证清单

1. `pwsh -File scripts/build.ps1 -Check` 通过（会先跑 `check-targets.ps1` 和 `catalog.ps1 -Check`，再 `tsc --noEmit`，含真实 DSH 类型）。
2. `pwsh -File scripts/build.ps1` 重新生成 `lib/`，且 `lib/` 由当前 `src/` 生成（产物不入库，但安装 / 打包前必须是最新的）。
3. `package.json`、`locale/*.json` 能解析（JSON 不允许注释和尾逗号）。
4. 安装结果里 `application: applied`、`warnings` 为空；行状态 `enabled`，没有 `overridden` / `failed`。
5. 实际触发一次插件能力（调用工具、看 UI 渲染），而不是只看安装成功。
6. UI 改动：确认控制台没有 `slot entry crashed`，浅色/深色主题都正常。
7. 视觉验证受限时（没有浏览器控制），只报告"已注册、未做视觉验证"，不要声称"看起来正常"。
8. 场景过滤：`dev-install.ps1 -DryRun -Surface web` 应跳过仅桌面插件；`status.ps1 -Surface web` 显示 `skip`；运行时的 web 必须用默认 Node 的 `dsh web` 启动（`profiles/web/start.ps1` 已优先 PATH），不匹配的 guard 应让该行 `failed` 而不是静默无操作。surface 判定读 `profileContext.startedBundles`，不要用 `webServer`（`apply` 时未就绪）；详见 [docs/plugin-targets.md](docs/plugin-targets.md) §5。
9. 测试：`node scripts/bootstrap.mjs test`（L1–L3，先构建再 `tsc -p test/tsconfig.json` + `node --test`）通过；改动安装/加载/Web 服务时再跑 `node scripts/bootstrap.mjs l4`（一次性 profile + 真实 `dsh web`，默认清理临时目录，`--keep` 保留日志）。
10. Web/Client 改动再跑 `node scripts/bootstrap.mjs l5`：自动构建并启动一次性 Web profile，用 Playwright 验证独立基线、实际 slot/交互、主题/locale、真实 SSE 通知。默认使用系统 Chrome；CI 用 `DSH_E2E_BROWSER=chromium`。报告、截图和 trace 保存在 `.tmp/l5/`，不自动上传；L4 的 `--home` 仅接受 `.tmp` 内新目录。详情见 `docs/testing-plan.md` §19。

**排障顺序**：先看 `build`（类型 / 编译错误），再看 `pack`（`pnpm pack --dry-run` 对比 `exports` 与包内容），最后看 `install` 之后 profile 里的加载结果。三段互相隔离，定位到哪段就修哪段，不要靠提交构建产物来保留上一次能跑的状态。

### 7.4 开发 / 稳定版切换（单 profile）

开发期用 `link:`，验收/使用期用 tarball 包安装，在同一个 profile 里显式切换：

```powershell
# 开发：先 build，再把每个插件以 link: 装进 profile，改代码 HMR 生效
pwsh -File scripts/dev-install.ps1

# 打包：build + pnpm pack，产物在 dist/*.tgz（只包含 files 列出的内容）
pwsh -File scripts/pack.ps1

# 稳定：安装 dist/*.tgz（同名包会替换 link/旧 tarball 的依赖 spec）
pwsh -File scripts/stable-install.ps1

# 查看当前模式
pwsh -File scripts/status.ps1
```

- 两个安装脚本都支持 `-DryRun`，只打印将执行的命令，不改 profile；
- 安装默认按目标过滤：`-Surface desktop|web`、`-Platform windows|mac` 覆盖推断；`-All` 强制安装不兼容插件；
- 安装会写 profile（工作区外），DSH 可能需要一次批准；在 DSH 外的终端执行也可以；
- **不要用 `pnpm remove` / `dsh plugin remove` 移除 `link:` 依赖**：Windows 上 pnpm 会跟随 junction 删除插件源码目录（已经踩过一次，源码从 git 恢复）。切换方向一律用 `add` 覆盖同名依赖。
- **切换方向后要重解析**：从 `link:` 切到 tarball 时，`dsh plugin add <tgz>` 可能只改 manifest 的 spec，而在 `node_modules` 里留下 junction、lockfile 里留下 `link:` 解析（表现为“装好了但还是链接”）。脚本会在 profile 里再执行 `pnpm update <name>` 强制重解析；`status.ps1` 会直接报告 `tarball spec, but LINKED` 这类不一致。
- **`link:` 不会安装插件的 `dependencies`，tarball 会**：稳定版必须单独验证一次依赖路径，不能只测 link；
- 替换已加载的插件后需要重启（插件管理器会报 `restart-required`）；
- 安装入口默认取 `$env:DSH_PROFILE`（否则 `desktop`），可用 `-Profile` 覆盖；`DSH_CLI` 可覆盖 dsh 可执行文件路径。

## 8. 依赖与构建

- **运行时零依赖**是默认目标：Host 侧只用 `ctx` 提供的服务与 Node 内置模块；Client 侧用浏览器模块表里的 React。这样插件被链接进 profile 后不需要额外安装步骤。
- **类型依赖**放在 `devDependencies`，版本与运行时对齐（`@deepseek-ai/dsh-*` 用 `0.2.1-rc.2`，cordis 用 `4.0.5`，TypeScript 固定 `7.0.2`）。它们不会进入运行时产物。
- **场景门禁**：`build` 先跑 `check-targets` 校验 `dsh.targets`、locale 前缀和 README 场景，再跑 `catalog --check`；`CATALOG.md` 由 `catalog` 生成，不要手改。实现都在 `scripts/src/commands/`，`.ps1` 只是薄壳。
- **构建**：`src/*.ts` → `lib/*.js` + `lib/*.d.ts`，产物**不入库**（`.gitignore` 忽略 `lib/`）。链接安装和打包都不会替你编译，所以 `dev-install.ps1` / `pack.ps1` 都会先构建，缺产物时直接报错。构建命令：
  - `pwsh -File scripts/build.ps1`（薄壳，实际执行 `node scripts/bootstrap.mjs build`）
  - `pwsh -File scripts/build.ps1 -Check` 只做类型检查
  - `pwsh -File scripts/ci.ps1` 或 `node scripts/bootstrap.mjs ci` 运行完整本地检查（类型检查 → L1–L3 → L4 → L5），失败即停止；汇总在 `.tmp/ci/last-report.json`。需要默认 Node 版 dsh；可用 `-DshCli` / `DSH_CLI` 指定。该入口不提交、推送或上传产物。
  - `node scripts/bootstrap.mjs test` 先构建，再编译并运行 L1–L3；`node scripts/bootstrap.mjs l4` 跑真实 `dsh web` 的 L4 harness（慢、需要本机 DSH）
  - 普通终端且 `node` 在 PATH 上时，也可以用根 `package.json` 的 `pnpm build` / `pnpm check` / `pnpm catalog` / `pnpm status` / `pnpm test`；**DSH 沙箱内不要用 `pnpm run`**（它会用管道 spawn 子进程，被沙箱拒绝后会卡住），直接用 `node scripts/bootstrap.mjs <cmd>`。
  - 脚本层自身也会先被编译到 `scripts/.build/`（不入库）；`scripts/bootstrap.mjs` 是唯一手写 JS
- **workspace 共享库**：`packages/*` 下的私有包（如 `@local/notify-core`、`@local/notify-host`）不是插件，没有 `dsh.bundle`/`dsh.targets`，不进 CATALOG。`build` 会先按依赖顺序用 `tsc` 构建它们，再构建插件。插件通过根 `devDependencies` 或 workspace 链接在构建期引用它们；**不要**把它们写成插件的 `dependencies`（link 安装不会装，tarball 会要求分发）。
- **`build.json` 与 esbuild**：需要 import 共享库或多文件的插件，在包根放 `build.json` 声明 `host`/`client` 入口；`tsc` 只产出声明和做类型检查，`build` 用平台自带的 esbuild 可执行文件（`spawnSync` + `stdio: 'inherit'`）生成 `lib/index.js`（ESM）和 `lib/client.js`（IIFE）。esbuild 不做类型检查；`-Check` 仍跑两个 tsconfig。原生 esbuild 的 JS wrapper 会启动管道式子进程，在 DSH 沙箱里会 `EPERM`，所以直接调用 `@esbuild/<platform>/esbuild(.exe)`。
- **共享库必须被内联**：`@local/notify-core`、`@local/notify-host` 这类构建期库由 esbuild bundle 进插件产物，profile 不需要安装；`files` 里不要列它们，也不要让运行时 `import '@local/notify-*'` 残留。
- **脚本层约定**（`scripts/src/`）：
  - 业务逻辑只写 TypeScript，`bootstrap.mjs` 只负责编译和加载；不要引入 `tsx`/`ts-node`。
  - 子进程必须 `stdio: 'inherit'`：DSH 沙箱会拒绝管道式子进程 stdio（`EPERM`）；需要捕获输出时写临时文件再读，不要用 pipe。
  - 不要在 `scripts/` 下建 `lib/` 目录：`.gitignore` 的 `lib/` 规则会把它连同源码一起忽略；共享代码放 `scripts/src/core/`。
  - 发现插件必须走 `dsh.bundle` 清单判断，不能只看"顶层目录有 `tsconfig.json`"，否则 `scripts/` 自己会被当成插件编译。
  - 测试源码在 `test/src/`，由 `test/tsconfig.json` 编译到 `test/.build`；测试 import 插件**已构建**的入口（`@local/*` → `lib/index.js`），所以要先构建。不要手改 `test/.build/`。
  - `.ps1` 入口在安装脚本迁完之前保留为薄壳；删壳与文档切换要在同一步完成。
- **新增插件**：复制一个现有插件的 `tsconfig.json`、`package.json` 的 `scripts`/`devDependencies` 起步；写好 `dsh.targets` 后运行 `pwsh -File scripts/catalog.ps1` 更新 `CATALOG.md`；`build` 按 `dsh.bundle` 清单发现插件（不只看 `tsconfig.json`），新目录只要声明了 bundle 就会被构建。
- **确需运行时依赖时**：优先打包进 `lib/`；否则要保证依赖能从插件真实路径解析（链接安装可能保留符号链接，裸 `import '@scope/pkg'` 会从 profile 目录解析而找不到）。
- **安装**：只有 `devDependencies` 变化时才需要 `pnpm install`。DSH 沙箱会拒绝 pnpm 替换/清理包目录（`EPERM`），这一步需要一次沙箱外批准，或在 DSH 外的普通终端执行。这是沙箱的设计边界，不要为了绕过它去手工删 ACL。
- **不要**提交 `node_modules`、`.pnpm-store`、`lib/`、`dist/`；**不要**手改 `lib/`。
- 跨插件共享代码放 `packages/*` 私有 workspace 库（如 `@local/notify-core`、`@local/notify-host`），由 esbuild 在构建期内联进各插件；不要用跨插件的运行时 import。

## 9. Git 约定

- 本机配置机制见 [docs/local-configuration-design.md](docs/local-configuration-design.md)。Web 首次使用运行 `scripts/config.ps1 init`；只提交 example 和 schema，不提交 `scripts/config/local.json`、`profiles/web/cordis.local.patch.yml` 或备份。当前仅配置命令和 Web 接入新机制，安装、构建与测试入口的统一属于后续阶段。

- 主分支 `main`，提交保持可读历史。
- 提交信息：`feat(<plugin>): ...`、`fix(<plugin>): ...`、`docs: ...`、`chore: ...`；一个插件的完整改动尽量放在一个提交里。
- 提交前：`git status` 确认没有 `node_modules/`、临时文件、凭据；`.credentials.yaml` 之类永远不要入库。
- 不提交 `lib/`、`dist/`（除非该插件明确以产物交付并在 README 说明）。

## 10. 安全边界

- 插件 Host 代码在 dsh 进程内、以当前用户权限运行，**等同于本机代码**；只安装自己写的或已审阅的插件。
- 不要读取或外传 `~/.dsh/.credentials.yaml`、会话数据、其他用户的文件。
- 测试时不要修改用户已有的 profile 配置、会话或工作区状态；测试后恢复。
- 不要在插件里静默执行 shell 命令、下载并运行远程代码。

## 11. 新插件检查清单

- [ ] 顶层目录名 = 包名后缀 = loader 行 `id`
- [ ] `package.json` 字段完整，`files` 覆盖所有运行时文件（含 `lib/**`），`dsh.targets` 已声明 `surfaces` / `platforms`
- [ ] `cordis.patch.yml` 能插入正确的行，`config` 与 `Config` 一致
- [ ] `locale/en.json`、`locale/zh.json` 有真实的 `meta.title` / `meta.description`，且描述以场景前缀开头
- [ ] Host 入口的 `apply` 第一行有 `assertTarget(ctx, name)`，不匹配时抛错
- [ ] `icon.svg` 合法、在包内、≤ 256 KiB、非占位图
- [ ] `scripts/build.ps1 -Check` 通过；JSON 可解析
- [ ] `node scripts/bootstrap.mjs test` 通过（L1/L2 契约会检查本插件的 `lib` 入口、`files`、locale 前缀）
- [ ] `scripts/build.ps1` 已重建 `lib/`（产物不入库，但装 / 打包前必须最新）
- [ ] 需要共享库/多文件 Client 的插件已声明 `build.json`，`lib/client.js` 由 esbuild 产出且不含运行时 `@local/*` import
- [ ] 安装后行 `enabled`、无 `error`，能力实际可用
- [ ] README 写清用途、**适用场景**、配置、安装、限制
- [ ] `scripts/catalog.ps1` 已生成 `CATALOG.md`（`build.ps1 -Check` 会校验）
- [ ] `git status` 干净，提交信息符合约定
