# dsh 插件开发：概念、安装与配置

> 本文记录 dsh 0.2.1-rc.2 的实际机制，结论来自实现代码与本机实测，不是推测。
> 面向"要写/装/调 dsh 插件"的人；日常操作规则见 [AGENTS.md](../AGENTS.md)，本文解释**为什么**。

## 0. 一张图

```
安装（app.asar + runtime）              ← 代码从哪来
  └─ bundle（npm 包 + cordis.patch.yml）  ← 可安装的"patch 层"，能力单元
       └─ profile（bundles 列表 + 依赖 + 用户 patch）  ← 一次运行的装配
            └─ 行树（loader entries）      ← 每个插件实例 + 它的 config
                 └─ 插件实例                ← 行指向的模块导出的 apply(ctx, config)
```

四者的关系可以一句话概括：

> **插件一定是 bundle，bundle 不一定是插件。**

插件是"行的实现"，bundle 是"贡献行的可安装单位"。一个 bundle 可以只贡献配置、不贡献任何代码。

> ## ⚠️ 最重要的一条：profile patch 永远晚于 bundle patch
>
> dsh 的 patch 应用顺序是固定的：
>
> ```
> bundle 层（按 dsh.profile.bundles 顺序） → profile 的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch
> ```
>
> **profile 层排在所有 bundle 层之后**，后应用的覆盖先应用的。所以只要 profile 里保留同 id 的生效条目，它就一定会盖过任何 bundle 提供的值。
>
> 由此推出一个硬结论：**configuration-only bundle 不能用来承载 profile 配置**。它要么被 profile 静默覆盖而失效，要么迫使你清空 profile——而清空 profile 又让本机失去了最高优先级的覆盖手段。
>
> 本仓库因此禁用该方案。本机配置直接写在 profile 的 `cordis.patch.yml`，改动前备份为同目录的 `cordis.patch.yml.bak`。

---

## 1. 四个概念

### 1.1 行（entry / loader row）

行树上的一个节点，最小的可配置单位：

```yaml
- id: desktop-notify                # 行身份，patch 靠它定位
  name: '@local/desktop-notify'     # 指向哪个包
  config: {...}                     # 传给插件 apply 的配置
  disabled: false                   # 可选，可用 !!js 表达式
```

- `id` 是主键。**不是** `name`——同一个包可以有多行（base 里 `tool-subagent` 与 `tool-subagent-fork` 都指向 `@deepseek-ai/dsh-tool-subagent`）。
- `name` 在 patch 里只用于**校验**：写了但和目标不一致，整条 patch 被跳过并告警。
- 行的 `config` 被整体替换，不做深合并（见 §2.3）。

### 1.2 bundle

**定义**：`package.json` 里声明了下面这行的 npm 包。

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

**作用**：把"要安装的包"和"要叠加的 patch"绑定成一个可安装单位。安装后，它的包名进入 profile 的 `dsh.profile.bundles`，每次启动都会读取它的 patch 并叠加。

关键点：**bundle 与代码无关**。dsh 加载 bundle 时只读 `package.json` 和 patch 文件，不会 `import` 这个包本身。所以：

| 包的类型 | 有没有 `dsh.bundle` | 装进 profile 后 |
|---|---|---|
| 普通 npm 包 | 无 | 只是普通依赖，dsh 不管 |
| 插件 bundle | 有 + 有 `src/`、`lib/` | patch 生效，并加载它自己的代码 |
| 配置 bundle | 有 + 无代码 | 只叠加 patch，不加载代码 |

官方也有纯配置 bundle 的例子：`@deepseek-ai/dsh-experimental-inspector-profile` 整个包只有 8 行 patch，负责把两个别的插件拉起来。

### 1.3 patch

**定义**：对行树的**增量修改**。只有两种动作：

```yaml
- insert:                        # 新增行
    - id: my-plugin
      name: '@local/my-plugin'

- id: ui-chat                   # 按 id 改写已有行
  config: { transcriptView: detailed }
```

**作用**：dsh 里唯一的配置语言。没有"编辑最终配置"的入口——profile 的根配置 `cordis.yml` 内容永远是 `[]`，每次启动被重写回空，所有配置都是层层 patch 合成出来的。

patch 有四个载体，格式完全一样，只是来源和优先级不同（见 §4.1）：

| 载体 | 文件 | 谁维护 |
|---|---|---|
| bundle 层 | 各包的 `cordis.patch.yml` | 包作者 |
| profile 用户层 | `<profile>/cordis.patch.yml` | 用户 |
| home 层 | `$DSH_HOME/cordis.patch.yml` | 用户（对所有 profile 生效） |
| 启动叠加 | `--patch <file>` | 命令行临时使用 |

### 1.4 profile

**定义**：一次运行的完整装配。CLI 的自我描述是：

> boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch layers under your own overrides.

**物理形态**：`$DSH_HOME/profiles/<name>/`，就是一个 npm 项目目录：

```
desktop/
├── package.json          # dsh.profile.bundles（装配顺序）+ dependencies（装在哪）
├── node_modules/         # 本 profile 自己的依赖
├── pnpm-lock.yaml
├── cordis.yml            # 根配置，恒为 []
├── cordis.patch.yml      # 用户层
└── .plugin-manager/      # 安装操作日志
```

**作用**：

1. **多形态共用一套安装**：`dsh-base`、`web-app` 等 bundle 组合出 web / headless / tui / desktop 等形态。
2. **隔离**：不同用途可以有不同插件集和配置，互不污染。
3. **依赖边界**：插件装在 profile 的 `node_modules` 里，而不是全局安装。

**一个 dsh 进程 = 一个 profile。** CLI 启动方式是 `dsh --profile <name>`（`dsh web` 是 `dsh --profile web` 的缩写）。

---

## 2. 一次启动发生了什么

### 2.1 层序

`readProfilePatches`（`@deepseek-ai/dsh-app-boot`）按固定顺序拼出一份 patch 列表：

```
bundle 层（按 dsh.profile.bundles 的顺序）
→ <profile>/cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml
→ --patch 叠加（可多次）
→ 遥测开关（DSH_TELEMETRY_DISABLED）
```

然后这份列表被**一次性**应用到空的根配置上。后出现的 patch 覆盖先出现的，这就是"后层覆盖前层"的来源。

> ⚠️ **注意这里的顺序：profile 在 bundle 之后。** 不是"bundle 装进 profile 所以更晚"，而是 patch 列表里 bundle 的条目先被应用。同 id 时 **profile 一定赢**。这也是为什么配置型 bundle 无法覆盖 profile 的配置（见 §4.4 反模式）。

### 2.2 应用算法

`applyEntryPatches`（`@deepseek-ai/cordis-plugin-include`）的核心：

```js
for (const patch of patches) {
  const { id, insert, name, ...overrides } = patch

  if (insert && !id) { data.push(...insert); continue }          // 往顶层追加
  if (insert && id)  { 找到 group 行，往它的 config 数组里追加 }  // 往组内追加

  const target = entryMap.get(id)
  if (!target) { warn('entry not found'); continue }              // 只告警，不报错
  if (name && name !== target.name) { warn('name mismatch'); continue }

  for (const [key, value] of Object.entries(overrides)) target[key] = value
}
```

三条容易踩的推论：

1. **匹配键是 `id`**，`name` 只是校验。
2. **覆盖是顶层字段整体赋值**，`config` 对象被整个替换，不深合并。只写两个字段，其余会回落到插件 schema 默认值，而不是继承前一层。
3. **找不到 id 只 warning**，不中断启动。升级后 id 改名会静默失效，需要看启动日志。

### 2.3 为什么根配置永远是 `[]`

dsh 刻意不把合成结果落盘：Loader 在某些操作后会把当前树写回 `cordis.yml`，如果这份文件保存了合成结果，下次启动就会把每个 bundle 的行重复插入一遍。所以每次启动都先把它重写为空，再重新合成。

---

## 3. dsh 怎么安装插件

### 3.1 入口

首选 Web UI 的 **Plugins** 页，填包目录的绝对路径；也可 `dsh plugin --profile <name> add <spec>`（pnpm 的透传）。桌面版必须先完全退出，否则 profile 的 `package.json` 被占用。

### 3.2 安装实际做了什么

```
dsh plugin add <spec>
├─ pnpm 执行安装
│    ├─ 写 profile/package.json 的 dependencies（link: / file: / 版本号）
│    ├─ 写 pnpm-lock.yaml
│    └─ 解压/链接到 profile/node_modules/<包名>/
└─ dsh-plugin-manager 扫描新增依赖
     ├─ 读 node_modules/<包名>/package.json
     ├─ 没有 dsh.bundle  → 警告"installed as a plain dependency"，不加入装配
     └─ 有 dsh.bundle    → 先验证 patch 文件能解析
                          → 把包名 push 进 dsh.profile.bundles
                          → 写回 profile/package.json
```

对应实现（`dsh-plugin-manager/lib/index.js`）：

```js
const metadata = bundleManifest(name, dir, anchor)
if (metadata?.dsh?.bundle === void 0) {
  options.onOutput?.(`warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer`)
  continue
}
for (const file of bundlePatchPaths(...)) loadOverlayPatches('dsh', file)
if (!bundles.includes(name)) bundles.push(name)
```

要点：

- **`dependencies` 由 pnpm 写，`bundles` 由插件管理器写**，都是自动的。
- `bundles` 的顺序 = 安装顺序，也就是 patch 层序。
- 管理器**不会**把 patch 内容写回 `package.json`；patch 只在启动时读取。
- 管理器也**不会**写 profile 的 `cordis.patch.yml`，只读它来判断磁盘状态是否变化。

### 3.3 支持的 spec 形态

dsh 的安装入口（`parseInstallSpec`）把 spec 分成四类：

| 形态 | 例子 | 备注 |
|---|---|---|
| 本地目录 | `<repo>\desktop-notify` | 必须绝对路径，相对路径直接报错 |
| 本地 tarball | `D:\...\dist\x.tgz` | 按扩展名识别 |
| git | `user/repo`、`git+https://...` | 从仓库拉 |
| registry | `@scope/name@1.2.3` | 从 npm 源装 |

pnpm 最终记录到 `dependencies` 的协议可能更多：`link:`、`file:`、版本范围、`npm:` 别名、`workspace:`、`catalog:`、git URL、`https://...tgz`。

本仓库两种模式：

| 模式 | 安装方式 | dependencies 里 | 特点 |
|---|---|---|---|
| 开发 | 目录 | `link:...` | 链接到仓库；源码构建到被监听的 `lib/` 后，由 HMR 尝试重载 |
| 稳定 | tarball | `file:...tgz` | 冻结副本，可复现，会安装 `dependencies` |

`link:` 不保证插件 patch 随保存自动应用；代码监听和 profile 配置重新组合是不同机制。代码、bundle/profile/home patch 与启动 `--patch` 的生效方式见 [Web 开发说明](../profiles/web/README.md#hmr-范围与安装模式)。

配置 bundle 之所以"能安装"，是因为 bundle 机制本身与代码无关；但这不代表它适合承载 profile 配置——见 §4.4。

### 3.4 包清单的四个关键字段

```json
{
  "type": "module",                                   // .js 按 ESM 解释
  "exports": { ".": "./lib/index.js" },               // 从哪儿进来（入口白名单）
  "files": ["lib/**", "cordis.patch.yml", ...],       // 哪些文件随包走（内容白名单）
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }  // 声明它是 bundle
}
```

- **`exports`**：定义对外入口。没列出的路径外部 import 不到；删掉它，Node 会回退找 `main` / 根目录 `index.js`，本仓库都没有，插件立刻加载失败。
- **`files`**：只过滤"额外文件"。`package.json`、`README`、`LICENSE` 永远自动包含，所以**不需要**写 `package.json`。
- **`files` 与 `exports` 是交集**：exports 指向的路径必须同时出现在 files 里，否则安装后找不到模块。
- **`files` 只在打包时生效**：`link:` 安装直接指向源码目录，完全绕过它——这就是"本地一切正常、打包后缺文件"的根因。

### 3.5 谁写什么

| 文件 | 手写 / 生成 | 说明 |
|---|---|---|
| 插件 `package.json` | 手写 | 含 `dsh.bundle.patch` |
| 插件 `cordis.patch.yml` | 手写 | 它贡献的行 |
| 插件 `src/*.ts` → `lib/*` | 手写源码，构建产物 | `lib/` **不入库** |
| profile `package.json` → `dependencies` | 生成（pnpm） | 别手改 |
| profile `package.json` → `dsh.profile.bundles` | 生成（管理器） | 别手改，顺序即层序 |
| profile `cordis.patch.yml` | 手写 | 用户层 |
| profile `cordis.yml` | 生成 | 每次启动重写为 `[]` |

---

## 4. 如何配置 dsh 插件

### 4.1 四层的选择

| 配置放哪 | 生效顺序 | 作用范围 | 适合 |
|---|---|---|---|
| bundle 的 patch | 最早（按 bundles 顺序） | 装了它的 profile | 插件自带默认值；仓库化的配置 |
| profile 的 patch | 中 | 该 profile | 本机个人偏好 |
| home 的 patch | 晚于 profile | **所有** profile | 跨 profile 的机器级偏好 |
| `--patch` | 最晚（遥测前） | 本次启动 | 临时实验 |

### 4.2 写法

```yaml
# 新增一行（插件自带）
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config:
        enabled: true

# 改一个已有内置行（整体替换 config）
- id: tool-web
  config:
    fetch: true
    searchTimeoutMs: 120000     # 必须把该行需要的字段写全

# 关掉一个默认开启的行
- id: session-telemetry-otel
  disabled: true

# 条件启用
- id: some-plugin
  disabled: !!js "!ctx.get('profileContext')"
```

### 4.3 desktop 的限制

desktop 的启动链**不支持** `--patch`：

- `dsh --profile desktop` 被显式拒绝：`profile "desktop" is managed exclusively by the Electron application`
- Electron 启动 Host 时 `patchFiles: []` 是写死的（`dsh-desktop-host/lib/index.js`）

所以 desktop 可用的配置入口只有三个：bundle patch、profile patch、home patch。前两个之外想"从仓库覆盖"，就要用配置 bundle（bundle 层）或 home 层。

### 4.4 反模式：用 configuration-only bundle 承载 profile 配置

曾经试过把 desktop 的启动配置抽成一个纯配置 bundle，结论是**不可行**，相关实现已从本仓库移除。

原因就是 §2.1 的层序：

```
bundle 层 → profile 层 → home 层 → --patch
```

纯配置 bundle 属于 bundle 层，**永远早于 profile 层**。于是只有两种结局：

- profile 里保留同 id（本机的正常状态）→ profile 覆盖 bundle，bundle 完全失效；
- 为了让它生效而清空 profile → 本机失去最后一道覆盖手段，配置也没有合适的位置了。

"用 bundle 覆盖 profile"这个需求在 dsh 的层序里不成立。真正晚于 profile 的只有 home 层和 `--patch`：前者作用于所有 profile 且文件在仓库外，后者 desktop 没有入口（见 §4.3）。

**本仓库的结论**：配置直接写在 profile 的 `cordis.patch.yml`，改动前备份为同目录的 `cordis.patch.yml.bak`；不把配置塞进 bundle。

纯配置 bundle 本身仍是 dsh 的合法形态（例如只 `insert` 新行、不覆盖任何已有配置）；禁用的是"用它承载 profile 配置覆盖"这一用法。

### 4.5 可选：home 层作为覆盖层

`$DSH_HOME/cordis.patch.yml` 天然在 profile 之后应用，能覆盖 profile 里的任何行，不需要改动 profile。代价是作用于所有 profile，且文件在仓库外（本机无符号链接权限，只能同步或手工维护）。

---

## 5. 本仓库的约定（今日变更）

- **仓库只存源码**：`lib/`（tsc 产物）和 `dist/`（pnpm pack 产物）都在 `.gitignore` 里，不再提交。
- **构建是安装/打包的前置**：`dev-install` 和 `pack` 都会先跑 `build`；缺 `lib/index.js` 时直接报错，不会链进一个空插件或打出空包。
- **验证顺序**：`build` → `pack` → `install`。出错时先定位是哪一段，不靠提交产物兜底。
- **不用 `pnpm remove` 移除 `link:` 依赖**：Windows 上 pnpm 会跟随 junction 删掉插件源码目录；切换方向一律用 `add` 覆盖。
- **切换 link / tarball 后要重解析**：否则 `node_modules` 里可能还是 junction，而 manifest 已是 `file:` 指向 tgz。
- **插件要声明适用场景**：每个插件在 `package.json` 的 `dsh.targets` 声明 `surfaces`（`desktop` / `web`）和 `platforms`（`mac` / `windows`）；`node scripts/bootstrap.mjs check-targets` 校验，`node scripts/bootstrap.mjs catalog` 生成 [`CATALOG.md`](../CATALOG.md)。安装脚本按目标过滤，`apply` 里的 `assertTarget` 做运行时守卫。语义与取值见 [plugin-targets.md](plugin-targets.md)。

---

## 6. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 本地正常，打包后 `Cannot find module` | `link:` 绕过 `files`，包内缺文件 | `pnpm pack --dry-run` / `tar -tzf` 对照 `exports` |
| 改了配置不生效 | 后层覆盖了你；或 id 写错（只 warning） | 看启动日志 `patch: entry ... not found` |
| 只改一个字段，其他字段丢了 | `config` 整体替换，不深合并 | 把该行需要的字段写全 |
| 修好代码仍然加载失败 | Node 缓存了模块加载失败 | 重启 dsh |
| 安装成功但插件没生效 | 包没声明 `dsh.bundle`，只当了普通依赖 | 检查包装时的警告 |
| desktop 用不了 `--patch` | Electron 启动参数写死 | 用 bundle / profile / home 层 |

---

## 7. 术语表

| 词 | 含义 |
|---|---|
| 行 / entry | 行树上的节点；`id` + `name` + `config` |
| bundle | 声明了 `dsh.bundle.patch` 的 npm 包；可安装的 patch 层 |
| plugin | 行指向的模块；导出 `apply(ctx, config)` |
| patch | 对行树的增量修改：`insert` 或按 `id` 覆盖 |
| profile | 一次运行的装配：bundles 列表 + 依赖 + 用户 patch |
| 层序 | bundles → profile patch → home patch → `--patch` |
| 投影 / projection | 由 session event 派生的只读状态单元（见 AGENTS.md §6） |

---

## 8. 源码位置（dsh 0.2.1-rc.2）

排除故障时可以直接翻这些实现（都在 `app.asar` 内，普通 grep 读不到）：

| 机制 | 文件 / 函数 |
|---|---|
| patch 应用算法 | `@deepseek-ai/cordis-plugin-include` → `applyEntryPatches` |
| 层序拼接 | `@deepseek-ai/dsh-app-boot` → `readProfilePatches` |
| profile 加载 | 同上 → `loadProfileDirectory` |
| 安装后扫描 bundle | `@deepseek-ai/dsh-plugin-manager` → `bundleManifest` / `bundles.push` |
| spec 分类 | 同上 → `parseInstallSpec` |
| desktop 启动 | `@deepseek-ai/dsh-desktop-host` → `main()`（`patchFiles: []`） |
| CLI 拒绝 desktop | `@deepseek-ai/dsh/lib/bin.js` → `rejectElectronProfile` |
