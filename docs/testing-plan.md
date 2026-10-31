# 测试与 Web L5 方案（v0.1）

> 2026-10-31 环境 M4：L4/L5 已统一全新测试 home/store、npm/pnpm 配置来源和进程树清理；成功保留报告/日志、删除可变数据，失败或 `--keep` 保留现场。`ci` 新顺序为环境 all → 类型检查 → L1–L3 → L4 → L5，核验本次独立报告，缺项/skip/清理或报告写入失败均不通过。ISO-01–06 实现及当前平台证据见[开发环境计划 §9.8](development-environment-plan.md#98-m4-测试隔离与-ci-证据门禁2026-10-31)。这里的环境 M4 与本文历史测试 M4 是不同编号。

> 2026-10-31 环境 M1/M2：已交付独立 `test-env --suite fast/real/all`。M1 `ff461e0` 的 Windows/macOS 配置 fast 均通过，功能 CI 均在过渡 DSH 准备步骤失败；M2 `8478d76` 的 Windows CFG/TOOL、L1–L4 及单独复验 L5 通过，尚无远端运行记录。提交、job 链接、失败及复验证据见[开发环境计划 §9.5](development-environment-plan.md#95-m1m2-提交后-ci-核查与-windows-复验2026-10-31)。当前配置/参数适用范围以[配置 v2](configuration-v2.md)为准；环境 M1/M2 与本文历史测试里程碑分别编号。

> 状态：M1–M5 已完成；提交 `d9f2a12` 的 Windows/macOS 远端 CI 全部通过（§19.7）。更新日期：2026-10-30（Asia/Shanghai）。
> 本文保留历史实施记录；原远端基线见 §19.7，P0 本机及 Windows/macOS 远端验收见 §7.5（2026-10-31 补验），未完成事项与范围边界集中在 §20。M6 等首个真实 UI 组件需要时再启动。
> 历史日志中的机器路径已脱敏；`<repo>`、`%USERPROFILE%`、`%LOCALAPPDATA%` 为路径占位符。新的本机配置入口见 [本机配置方案](local-configuration-design.md)，L4/L5 不读取日常 Web 本机 patch。
> TS 脚本收尾已实现；后续环境统一与开发隔离见[独立规划](development-environment-plan.md)。以下历史通过记录不代表 P1–P4 已实现。
> 环境配置的新增测试另见[环境方案 §4.7](development-environment-plan.md#47-验证设计独立环境配置测试)：包含独立入口、35 组场景及逐步交付安排；CFG/TOOL 已实现，后续 DEV/ISO/ART/TGT 待实现。它验证配置迁移、宿主选择、目录/进程隔离和交付一致性，与本文插件 L1–L5 分别报告。

## 1. 结论摘要

- **L5 先只做 Web**，使用真实 `dsh web` + Playwright；桌面端 L5 延期。
- **`app-restart`、`desktop-notify` 不适配 Web**，保持 desktop-only；Web L5 已覆盖 fixture 和真实 `notify-web`，后续 Web/UI 插件复用该 harness。
- **Web profile 由官方 shipped `web` 初始化**，不手工拼配置；已初始化并验证，测试使用独立的 workspace-local `DSH_HOME`。
- **仓库脚本已统一为 TypeScript 并用 `tsc` 编译**，主入口为 `node scripts/bootstrap.mjs <command>`，不使用 Node 类型擦除。PowerShell 兼容入口已移除；收尾证据见 §7.5。配置第二阶段的行为见 §19.6，前文各阶段记录保留。
- **测试 runner 不统一**：Host/脚本用 `node:test`，L5 用 Playwright；未来 UI 组件测试计划用 Vitest，尚未引入。`browser-use` 只做探索式验收。
- **M4 已落地**：L1–L3 在 `test/src/` 下用 `node:test`，当前 251 项用例已在 Windows 本机全部通过，平台专属用例在其他平台按条件跳过。L2 对四个正式插件实际打包、解包、检查内容并导入入口。L4 在一次性 profile 里安装、启动真实 `dsh web` 并断言 loader 输出；失败自动保留现场。
- **M5 已完成**：正式 L5 验证实际 slot/交互、主题/locale 和真实 SSE 通知链路；Windows/macOS 远端 CI 已通过（§19.7），原生系统通知不在其验收范围内。
- **沙箱优先**：先在 DSH 沙箱内跑；遇到 `EPERM`/进程或浏览器限制，再退到普通终端或 CI，不做 ACL 绕过。

## 2. 范围

### 目标

- 建立 Web 端的 L4（无浏览器）和 L5（真实浏览器）测试能力。
- 为后续 Web/UI 插件提供可复用的测试 harness。
- 把仓库脚本从 PowerShell 迁移到强类型 TypeScript，跨平台运行。
- 用 `tsc` 保证源码和测试的类型安全。

### 非目标（当前阶段）

- 不做桌面端 L5（Electron/Toast/真实重启）。
- 不为了测试而把 `app-restart`、`desktop-notify` 改成 Web 插件。
- 不把 `browser-use` 放进 CI 门禁。
- 不统一所有测试到 Vitest。
- 早期 M3 只迁只读/构建脚本；安装与打包业务已在配置第二阶段迁入 TypeScript（§19.6），不再是待办。

## 3. 现状

- 仓库现在有四个插件：`app-restart`、`desktop-notify`（`desktop/windows`）、`notify-web`（`web/mac+windows`）与 `approval-allowlist`（`desktop+web/mac+windows`）。本文早先关于 `desktop-notify` 适配 Web 的计划已被 3 包拆分取代：共享内容在 `packages/notify-core`，桌面/Web 分别由 `desktop-notify` 与 `notify-web` 投递。
- `$DSH_HOME/profiles` 下现在同时有 `desktop` 与 `web`；仓库内另有 `profiles/web/`（patch + 启动脚本），不是插件。
- 早期执行 `dsh web --help` 时，DSH 尝试创建 `%USERPROFILE%\.dsh\profiles\web`，在 DSH 沙箱下报过：
  `EPERM: operation not permitted, mkdir '%USERPROFILE%\.dsh\profiles\web'`；该 profile 现已由官方模板初始化。
- `dsh --help` 提供 `--from-default-profile <name>`：
  “replace a custom profile with a fresh copy of a shipped profile template”。
  这是复制官方 profile 的正式入口。
- 仓库已有 L1–L3 自动化测试和 L4 harness；脚本层位于 `scripts/src/`，测试位于 `test/src/`。

## 4. 测试分层

| 层 | 内容 | 需要 DSH 运行 | 工具 | 当前状态 |
|---|---|---|---|---|
| L1 | 纯逻辑：格式化、转义、配置合并、target 判定 | 否 | `node:test` | 已实施（M4，`test/src/l1/`） |
| L2 | 包/契约：包名、`dsh.targets`、patch、locale、`exports`、`files`、`lib` 入口 | 否 | `node:test` + `tsc` | 已实施（M4，`test/src/l2/`） |
| L3 | Host 集成：用假 Context 调 `apply`，断言监听器、命令、事件路由 | 否（同进程） | `node:test` | 已实施（M4，`test/src/l3/`） |
| L4 | 临时 profile 安装（link + tarball）、loader 行、`dsh web` 就绪、CLI/HTTP 检查 | 是，不开浏览器 | Node 脚本 | 已实施（M4，`l4` 命令） |
| L5 | 真实 Web UI：Playwright 打开页面，断言 slot、交互、主题、locale、console | 是，浏览器 | Playwright | M5 已实施：基线、slot/交互、主题/locale、通知、错误门禁（§19） |
| 探索 | 自然语言驱动的页面探索、录屏、人工验收 | 是 | `browser-use` | 手动，不进 CI |

### L4 与 L5 的边界

- **L4 先做**：装不上、loader 行不对、目标被跳过，先在无浏览器层定位。
- **L5 只负责浏览器行为**：页面/ slot / 交互 / 主题 / console。不要把“服务没起来”也归到 L5。
- L5 失败时先看 L4 是否通过；L4 通过再看浏览器。

### 与环境配置测试的分工

现有配置、命令上下文和 harness 回归测试可复用于[环境测试方案](development-environment-plan.md#472-测试入口隔离设施与证据)，但 L1–L5 通过不能替代配置迁移、错误宿主、路径越界、故障恢复等场景的证据。新增环境测试采用独立的 `test-env` 入口和报告（尚未实现），快速组不要求先构建插件或准备健康的本机配置，真实组在隔离目录中使用真实 DSH。

环境测试随[六步建设](development-environment-plan.md#58-环境测试逐步接入与判定完成)逐步加入：第 1 步先交付配置测试与快速入口，第 2–3 步加入真实工具/开发环境，第 4 步接入完整两平台 CI，第 5–6 步验证产物与正式目标。插件功能检查仍由本文 L1–L5 承担；验收包时，应将结果关联到指定 tarball 的哈希，不能内部重打包后将另一份文件的结果记到该包上。

### 具体测什么

- L1/L2/L3 沿用前面讨论：
  - `app-restart`：命令注册、handler 只触发一次、VBScript 生成/转义、target guard。
  - `desktop-notify`：审批/回合结束路由、配置开关、子代理过滤、XML/PowerShell 转义、spawn 参数。
  - 通用契约：目录名=包名、targets、patch、locale 前缀、README、图标、`lib` 入口。
- L4（M4 已实施）：
  - 一次性 workspace-local `DSH_HOME`，官方 shipped `web` profile 能组装；
  - `link:` 安装 Web fixture 与真实通用插件，profile 依赖 spec、bundles、`--dump-config` 行一致且未禁用；
  - `dsh web` 能启动并返回 200（含 303 + auth cookie 握手），boot HTML 含 client module；
  - 声明不可匹配 target 的 fixture 由 loader 报 `dsh: warning: N entry did not activate`，行仍在配置中且服务继续可用；
  - `pnpm pack` 出的 tarball 安装后 `node_modules` 是真实拷贝（非 link），插件仍能激活；
  - 步骤结束后进程退出、端口关闭；失败自动保留日志与报告，`--keep` 额外保留成功现场。
- L5：
  - 页面加载，无 console error；
  - Web/UI 插件 slot 渲染，无 `slot entry crashed`；
  - 点击/输入触发 Host 行为；
  - 浅色/深色、中文/英文；
  - 截图回归（可选）；
  - Web 通知：用 `addInitScript` stub `window.Notification`，断言标题/正文/权限拒绝路径。

### 明确不自动化的部分

- Windows Toast 是否真的弹出、声音是否可闻；
- 点击通知是否真的聚焦窗口；
- `/restart` 是否真的重启桌面应用；
- 桌面 Electron 壳的窗口行为。

这些保留人工验收，不用单元测试或 Web L5 假装覆盖。

## 5. Web DSH 准备

### 5.1 使用官方 web profile

目标：不要手工拼 `cordis.patch.yml`，直接使用官方 shipped `web` profile。

实测结论（2026-10-24）：

- `web` 是 **shipped profile**，不能作为 `--from-default-profile` 的“自定义 profile 目标”。
  执行 `dsh web --from-default-profile web --dump-config` 会报：
  `profile "web" names shipped profile "web" and cannot be a custom profile target; omit --from-default-profile to use it`。
- 正确做法是直接执行 `dsh web --dump-config` / `dsh web`，DSH 会初始化 shipped `web` profile。
- 直接使用真实 `$DSH_HOME` 时，DSH 每次组装 profile 都会重写 `profiles/web/cordis.yml`；在 DSH 沙箱下这属于工作区外写入，会反复触发审批。
- **测试/自动化统一使用 workspace-local `DSH_HOME`**，例如：
  `<repo>\.tmp\dsh-home`。实测 `DSH_HOME` 指向工作区内目录时，`dsh web` 会创建
  `.tmp/dsh-home/profiles/web`，不再触发工作区外审批。

当前真实 `$DSH_HOME` 下的 `web` profile 已由官方模板初始化成功：

```text
$DSH_HOME\profiles\web\
├── package.json        # dsh.profile.bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app
├── cordis.patch.yml    # 空数组（用户覆盖层）
├── cordis.yml          # 每次组装时重写
└── pnpm-workspace.yaml
```

自动化/测试推荐命令（不触发工作区外审批）：

```powershell
$env:DSH_HOME = Join-Path $PWD '.tmp/dsh-home'
dsh web --dump-config
dsh web --no-open --host 127.0.0.1 --port 0
```

实测启动输出：

```text
dsh web: http://127.0.0.1:<port>/?token=<token>
```

HTTP 检查返回 `200`，HTML 约 37 KB。URL 带 token，Playwright/L4 必须使用完整 URL，不能只拼 host/port。

Web 应用参数（`dsh web --help`）：

```text
--host <host>      绑定一个具体本地 IPv4/IPv6 地址
--port <port>      0 表示由系统分配
--no-open          不自动打开浏览器
--public-url <url> 对外公布 URL
--trusted-host     额外信任的 authority
--tls-cert/key      HTTPS
```

注意：

- `DSH_HOME` 工作区化会隔离 profile、会话和缓存；测试结束后可整体删除 `.tmp/dsh-home`。
- 真实 `$DSH_HOME/profiles/web` 可以保留作为官方基线，但自动化不要用它，避免审批和污染用户状态。
- 如果必须用真实 home，只能在普通终端/CI 跑，或接受每次启动的审批。

### 5.2 Web readiness checklist

- [x] `web` profile 由官方 shipped template 初始化成功。
- [x] `dsh --profile web --dump-config` 可读，包含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`。
- [x] `dsh web` 能启动，HTTP 200，URL/token 可获取。
- [x] Web 用默认 Node 的 `dsh` 启动（Host 内 `electron=null`，surface 识别为 `web`）；见 §16。
- [x] 工作区 `DSH_HOME` 隔离方式验证通过，不再触发工作区外审批。
- [x] 无自定义插件的独立 Web UI 基线通过（M5，§19）。
- [x] `dsh plugin --profile web add <tarball>` 可用（M4：`local-approval-allowlist-0.1.0.tgz`）。
- [x] 运行时插件行 `enabled`、无 warning 的结构化断言（M4：`--dump-config` 行 + loader stderr 的 `entry did not activate`；M4 未发现可读的“运行时行状态”API，见 §14）。
- [x] 临时 profile/测试数据的隔离方式确定：`.tmp/dsh-home`。
- [x] 进程能退出，端口释放；`taskkill /T /F` 可能对已退出子进程打印 `Access denied`，以端口关闭为准。
- [x] 确认沙箱内无法启动 Chrome；沙箱外 L5 已验证，见 §5.5 与 §14。

### 5.3 隔离策略

首选（已验证）：

- 设置 `DSH_HOME=<repo>\.tmp\dsh-home`；
- DSH 会在工作区内创建 `profiles/web`、会话和缓存；
- 不写 `%USERPROFILE%\.dsh`，不触发工作区外审批；
- 测试结束整体删除 `.tmp/dsh-home`。

其他可选：

- 临时 `DSH_PROFILE_DIR`；
- 临时 profile 名（如 `dsh-e2e-<random>`）并在结束后删除；
- 临时端口；
- 临时日志/截图目录。

禁止：

- 修改用户现有 `desktop` profile；
- 复用用户会话数据；
- 直接手工编辑 profile 的 `package.json` / `cordis.patch.yml`。

如果必须写真实 `$DSH_HOME`，需要在文档中明确原因、清理步骤和失败兜底。

### 5.4 沙箱、终端、CI 的优先级

1. **DSH 沙箱**：先试，并且优先用 workspace-local `DSH_HOME`。
   - 已知 `node:test` 子进程会 `EPERM`，测试运行器需 `--test-isolation=none`；
   - `dsh web` 使用真实 `$DSH_HOME` 时会重写 `cordis.yml`，反复触发工作区外审批；
   - 改用 `.tmp/dsh-home` 后，profile 写入留在工作区，审批问题消失（已实测）。
2. **普通终端**：沙箱不允许的写操作、浏览器启动、进程树管理，在这里执行。
3. **CI**：最终稳定门禁；Windows + macOS，L4 每次跑，L5 可 PR/nightly。

不要在插件或脚本里为了绕过沙箱去改 ACL；这是设计边界。

### 5.5 M2 实测结果（最小 Web fixture + L5 spike）

已落地：

- fixture：`test/fixtures/web-hello/`
  - Host 入口 `index.js`（空 `apply`）；
  - `client.js` 设置 `window.__DSH_WEB_HELLO__` 并在 `conversation.composer.dock` 注册 slot；
  - `dsh.targets` 为 `web` / `windows+mac`，`dsh.client.immediately: true`；
  - 不是顶层插件，不进入 CATALOG，也不会被 `build` 当正式插件构建。
- 安装（workspace-local home）：
  ```powershell
  $env:DSH_HOME = Join-Path $PWD '.tmp/dsh-home'
  dsh plugin --profile web add (Join-Path $PWD 'test/fixtures/web-hello')
  ```
  结果：profile `package.json` 增加 `@local/web-hello` 的 `link:` 依赖，bundles 增加该包。
- L4 证据：
  - `dsh --profile web --dump-config` 中出现 `id: web-hello`、`name: '@local/web-hello'`；
  - `dsh web` 返回的 HTML boot 数据包含
    `{"id":"@local/web-hello","url":"plugins/??@local/web-hello/client.js...","immediately":true}`；
  - HTTP 200，说明 server 侧 loader 和 client module 注册都生效。
- L5 脚本：`test/e2e/web-l5.mjs`
  - 使用 `playwright-core` + 系统 Chrome（不下载浏览器）；
  - 读取 `DSH_E2E_URL`（和当前桌面 GUI 的 `DSH_WEB_URL` 分开），也支持 `.tmp/dsh-e2e-url.txt`；
  - 等待 `window.__DSH_WEB_HELLO__.factory`，随后断言 `applied`，收集 console/pageerror，检查 `slot entry crashed`，截图到 `.tmp/web-l5.png`；
  - 命令：`node test/e2e/web-l5.mjs`。

**L5 实测（2026-10-24）**：在 `danger-full-access` 下 Chrome 可以启动，L5 通过：

```json
{
  "state": {
    "factory": true,
    "applied": true,
    "registered": true,
    "error": null,
    "slot": "conversation.composer.dock"
  },
  "consoleErrors": [],
  "pageErrors": []
}
```

截图：`.tmp/web-l5.png`（约 45 KB）。实测 marker 显示 `conversation.composer.dock` slot 注册成功；截图是未创建会话时的 landing page，因此 slot 组件本身未在画面上出现。当前脚本仅输出 `registered`，尚未断言该字段；也未对所有 console error 判失败，详见 §14。此证据只能证明本次加载与注册，不能证明实际可见渲染或完整回归门禁。

运行方式（终端/CI 或已加白的 DSH 命令）：

```powershell
# 终端 1：workspace-local home 启动测试 web
$env:DSH_HOME = Join-Path $PWD '.tmp/dsh-home'
dsh web --no-open --host 127.0.0.1 --port 0

# 终端 2：把完整 URL（含 token）传给脚本
$env:DSH_E2E_URL = 'http://127.0.0.1:<port>/?token=<token>'
node test/e2e/web-l5.mjs
```

**沙箱结论**：workspace-write 下 Chrome 无法启动（`spawn EPERM` / crashpad/mojo access denied）；`danger-full-access` 下可以启动，所以 L5 需要一次提权审批，或由 `approval-allowlist` 对精确命令加白。

### 5.6 approval-allowlist（observe 模式已安装）

新增插件 [approval-allowlist](../approval-allowlist/README.md)，用于把特定工具调用的审批加白。

- 不按 `reason` 文本匹配；用 `approval/request.callId` 找到 durable `tool/call`，比较 `name` + 原始 `arguments`。
- 默认 `mode: observe`：只写审计 JSONL，继续走原审批；`mode: allow` 且精确命中才返回 `allowed-once`。
- 默认只允许根 agent；`maxUses` 省略或为 `0` 表示无限放行，正安全整数限制次数；其他非法值打印错误日志并跳过该规则，支持 `expiresAt`。
- 规则格式：

  ```yaml
  rules:
    - tool: pwsh
      arguments:
        command: 'node test/e2e/web-l5.mjs'
        workdir: '<repo>'
      # 省略 maxUses => 无限放行
  ```

历史验证（2026-10-24）：

- 已验证 `link:` 安装、重启加载、observe 记录和精确 allow 匹配。
- 插件 bundle 默认 `observe`。个人命令、次数限制和授权策略只保存在本地配置，不在公共文档中记录。
- 精确匹配成功时的审计日志结构示例：

  ```json
  {"mode":"allow","decision":"allow","detail":"allowed","matchedRule":0,"tool":"pwsh",...}
  ```

- 审计日志：`<repo>\.tmp\approval-allowlist.log`。

安全注意：

- `allow` 模式等于把某条命令的审批权交给插件配置；只应由可信用户维护配置。
- 审计日志包含命令原文，可能含敏感参数。
- 不要把匹配放宽成 `reason` 子串或通配符。
- 规则已绑定精确命令和 `sandbox_permissions`，并非“所有 pwsh 都放行”。
- 无限放行意味着该 `.mjs` 脚本内容也被信任；修改脚本会改变被自动放行的实际行为。

### 5.7 审批通知与 allowlist 的顺序问题

问题：`approval/asked` 在 approval waterfall 之前写入会话，所以 `desktop-notify` 会在 allowlist 返回 `allowed-once` 之前就弹通知；用户会为一次从未展示的审批收到提醒。

修复（`desktop-notify`）：

- `approval/asked` 不再立即通知，而是按 `approvalDelayMs`（默认 300ms）延迟；
- 收到同一 `id` 的 `approval/decided` 时取消定时器；
- allowlist 自动放行的决定在同一 turn 内立即到达，因此通知被取消；
- 手动审批期间决定未到，300ms 后仍会正常提醒。

配置：

```yaml
- id: desktop-notify
  config:
    notifyOnApproval: true
    approvalDelayMs: 300
```

当前状态：代码已构建，`desktop-notify` 已切换为 link 安装；需要一次 DSH 重启加载新代码，然后验证“命中 allowlist 时不再弹通知、手动审批仍会弹”。

## 6. 工具选择

### 6.1 `node:test`

用于：

- L1/L2/L3；
- 脚本的纯函数与 CLI dry-run；
- 零依赖、同进程、快。

沙箱注意：

- 使用 `--test-isolation=none` 避免测试运行器 `spawn`；
- 文件串行执行，避免全局状态竞争；
- 子进程优先 `stdio: 'inherit'`。

### 6.2 Vitest

用于：

- UI 插件的组件/逻辑测试；
- jsdom/happy-dom + Testing Library；
- slot 注册逻辑（假 `ctx.slots`）；
- 交互、状态、格式化。

不用于：

- 真实 DSH 集成；
- 真实浏览器布局/CSS/主题；
- 替代 `tsc` 类型检查。

### 6.3 Playwright

用于：

- L5 Web 集成；
- 真实浏览器、真实 `dsh web`；
- slot/交互/主题/locale/console/截图；
- Web 通知用 `addInitScript` stub。

### 6.4 `browser-use`

定位：探索式验收，不进 CI。

- 适合让 agent 自由点击、观察、录屏、发现视觉/流程问题；
- 不适合作为确定性回归门禁；
- 产生的场景再由 Playwright 固化成稳定测试。

### 6.5 `tsc`

所有 TS 源码和测试的类型检查入口。

- 脚本：`tsc -p scripts/tsconfig.json` 编译到 `scripts/.build`（含 `.d.ts`，供测试引用）；
- 测试：`tsc -p test/tsconfig.json` 编译到 `test/.build`，类型检查与产物由同一次编译完成；
- Vitest 的 esbuild 转换不算类型检查，不能省 `tsc`。

## 7. TS 脚本迁移

### 7.1 结构

```text
scripts/
├── bootstrap.mjs          # 唯一手写 JS：定位 tsc、编译 scripts/src、加载 .build/cli.js
├── tsconfig.json          # rootDir: src, outDir: .build（含 declaration，供 test/ 引用）
├── src/
│   ├── cli.ts             # build/check-targets/catalog/status/config/web/pack/dev-install/stable-install/test/l4/l5/ci
│   ├── core/
│   │   ├── repo.ts        # 仓库根（从 import.meta.url 推导，不依赖 CWD）
│   │   ├── json.ts        # 读取/写入 UTF-8、isRecord、stringArray
│   │   ├── plugins.ts     # 插件发现（dsh.bundle 清单驱动）、稳定排序
│   │   ├── targets.ts     # Resolve-Target、兼容性、场景标签
│   │   ├── dsh.ts         # DSH_HOME/profile/manifest/安装模式
│   │   ├── exec.ts        # 无管道子进程：stdio 落文件、等待 URL/HTTP、停止进程
│   │   └── dsh-cli.ts     # 定位 dsh CLI；解析 .cmd 包装器，直接 spawn 引擎
│   └── commands/
│       ├── build.ts       # 门禁 + 逐插件 tsc（--check 只做 noEmit）
│       ├── check-targets.ts
│       ├── catalog.ts
│       ├── status.ts
│       ├── config.ts      # 本机配置初始化与检查
│       ├── web.ts         # Web 启停与浏览器打开
│       ├── pack.ts        # 打包
│       ├── install.ts     # link/tarball 安装、预检与重解析
│       ├── ci.ts          # 完整检查编排
│       ├── l5.ts          # 浏览器验收编排
│       ├── test.ts        # L1–L3：tsc test/ 后 node --test
│       └── l4.ts          # L4 harness：一次性 profile、安装、dsh web、断言、清理
└── .build/                # tsc 产物，gitignore

test/
├── tsconfig.json          # rootDir: src, outDir: .build
├── src/
│   ├── harness/           # fake Context、临时目录、process.versions/ENV 恢复
│   ├── l1/                # 纯逻辑（脚本 core + 插件导出的纯函数）
│   ├── l2/                # 包/契约（独立于生成器重新推导）
│   └── l3/                # Host 接线（apply/监听器/命令/handler）
├── fixtures/              # web-hello、target-mismatch（不是顶层插件）
├── e2e/web-l5.ts          # 正式 L5；web-l5.mjs 保留为兼容薄壳
└── .build/                # tsc 产物，gitignore
```

所有命令通过 `node scripts/bootstrap.mjs <command>` 调用。旧 `scripts/*.ps1`（含
`common.ps1`）与 `profiles/web/start.ps1` 已移除，原参数改用 Node CLI 的
`--check`、`--dry-run`、`--profile`、`--surface` 等形式。Node 由调用方通过 PATH 或绝对路径选择，
不再使用 `DSH_NODE` 定位。`pack` / `dev-install` / `stable-install` 继续复用配置第二阶段的 TS 业务（§19.6）。

### 7.2 约束

- 业务逻辑全部在 `src/*.ts`；`bootstrap.mjs` 只做编译和加载。
- 不引入 `tsx`/`ts-node`；用 `tsc` 产物运行。
- 参数解析用 `node:util` 的 `parseArgs`。
- 子进程用 `spawnSync` + 参数数组，不拼 shell 字符串。
- 优先 `stdio: 'inherit'`；需要捕获时写临时文件再读。
- Windows 上 Node 24 不能直接 spawn `.cmd`（`EINVAL`）：解析 `dsh.cmd` 的
  `--expose-internals` 行，直接 spawn 桌面引擎并设 `ELECTRON_RUN_AS_NODE=1`；
  `app.asar` 内路径是虚拟的，不能用 `existsSync` 校验。
- `dsh web` 的认证是 `303 + Set-Cookie` 握手；HTTP 检查必须复制 auth cookie
  跟随一次重定向，否则会得到 401。
- 测试运行器固定 `node --test --test-isolation=none --test-concurrency=1`：
  沙箱拒绝管道式子进程，串行也能避免 `process.versions` 等进程级桩互相干扰。
- 跨平台解析（配置第二阶段后的行为）：
  - 运行时工具使用显式参数 > 支持的环境变量 > 本机配置，缺失或无效不静默回退；工具发现只在 `config init` 进行；
  - `DSH_HOME` 默认 `os.homedir()/.dsh`；
  - `DSH_PROFILE` / `DSH_PROFILE_DIR` 优先；
  - pnpm 使用已解析配置中的 `pnpm.cjs`（`node pnpm.cjs`）；
  - Windows `.cmd` 需要 `cmd.exe /d /s /c`，或解析到背后 `.js` 用 node 执行。
- 外部 JSON（manifest/profile）用 type guard 做运行时校验，不能只靠 TS 类型。

### 7.3 迁移顺序

1. `common` + `check-targets` + `catalog` + `build`（只读/编译）；
2. `status` + `pack`；
3. `dev-install` / `stable-install`（pnpm、dsh passthrough、junction、删除风险最高）；
4. 删除 `.ps1` 兼容入口，迁移调用方、帮助、文档与专属测试；Node CLI 独立验收（§7.5）。

迁移业务时先记录旧脚本输出，再对比新脚本；`--dry-run`/`--check` 优先自动化。§7.4 保留当时的对拍记录，兼容入口退场后的当前用法以 §7.1/§7.5 为准。

### 7.4 M3 实施结果（2026-10-24）

已落地：`scripts/src/` 骨架 + `check-targets` / `catalog` / `build` / `status` 四个命令
迁移到 TypeScript；`.ps1` 改成薄壳转发；根 `package.json` 增加
`build` / `check` / `catalog` / `status` 四个 script；`.gitignore` 增加 `scripts/.build/`。

对拍证据（迁移前先抓基线到 `.tmp/m3-baseline/`，逐条 diff）：

- 四个命令的成功输出与旧 `.ps1` **逐字节一致**；`status` 覆盖三种分支
  （未安装 / `link (dev)` / `tarball (stable)`，桌面与 Web profile 各一次）。
- `catalog` 写出的文件与 PowerShell 版**字节一致**（1058 B，无 BOM、`\n` 结尾）。
- 负例逐字节一致且同为 exit 1：不支持的 surface/platform、重复 platform、
  未知 `dsh.targets` 字段、`targets` 缺失、`surfaces` 非数组、`surfaces` 为空、
  locale 前缀不匹配、README 缺 `## 适用场景`、`catalog` 过期/缺失。
- `pwsh -File scripts/build.ps1 -Check` 在薄壳化之后仍然 exit 0，输出与基线一致。

迁移中发现并在实现里修掉的三个陷阱（都实测确认）：

1. `.gitignore` 的 `lib/` 规则会吞掉 `scripts/src/lib/**`（`git check-ignore` 命中）→
   共享代码目录改用 `scripts/src/core/`。
2. `build.ps1` 原来按"顶层目录 + tsconfig.json"发现工程，加了 `scripts/tsconfig.json`
   之后会把 `scripts` 自己当第 4 个插件编译 → 改为按 `dsh.bundle` 清单发现。
3. 沙箱内 `spawnSync` 默认 pipe 会 `EPERM`，`stdio: 'inherit'` 正常 →
   `bootstrap.mjs` 与 `build` 都用继承 stdio；后续需要捕获 dsh/pnpm 输出时必须走临时文件。

已知非字节级差异（记录在案，不视为回归）：

- 错误信息在 TS 版走 **stderr**，旧 PowerShell 版走 host/stdout；文本内容与退出码一致。
- 非法 JSON 的报错文案来自 Node 的 `JSON.parse`，不再是 .NET 的异常文本（前缀仍为
  `cannot parse locale JSON:`）。
- `catalog` 的排序从 PowerShell 文化排序改为码点排序；当前 3 个插件结果相同，
  以后也不会随宿主 locale 漂移。
- `pnpm run <script>` 在 DSH 沙箱内会卡住（pnpm 用管道 spawn 子进程，被沙箱拒绝），
  所以沙箱内统一用 `node scripts/bootstrap.mjs <cmd>`；根 `package.json` 的
  `build`/`check`/`catalog`/`status` 留给普通终端与 CI。
- `pnpm install` 在沙箱内会因 `node_modules` 包目录 rename 报 `EPERM`（AGENTS §8 已记录）；
  本次迁移只改动了 lockfile 的 3 行（根 `@types/node`），需要时在普通终端补一次安装。

早期后续项的当前状态：

- `pack` / `dev-install` / `stable-install` 已迁入 TypeScript，并补齐配置与安装切换测试（§19.6）。
- `.ps1` 在 M3 和配置第二阶段曾作为兼容入口保留，现已按 P0 移除（§7.5）。
- `scripts/src/core` 已有 `node:test` 覆盖；根 `devDependencies` 也已显式声明 `@types/node`，不再依赖插件提升。
- 先前安装阻塞的 HMR 原因与处理仍保留在 §12，属于历史排障记录。

### 7.5 P0 脚本收尾（2026-10-30）

当前入口为 `node scripts/bootstrap.mjs <command>`。已删除 `scripts/` 下 10 个 `.ps1`
与 `profiles/web/start.ps1`，移除 PowerShell 参数映射专属测试；原配置、安装预检、
失败停止、Web 超时与清理测试继续保留。帮助、报错提示、根 package scripts、AGENTS、
各 README 和现行操作说明均已迁移。本机已知 `dshweb` 函数也改为调用 bootstrap，
修改前在其配置文件旁保留备份；其他机器的个人快捷方式按 Web README 自行迁移。

新增 `test/src/l3/node-entrypoints.test.ts` 直接复制并编译脚本源码，从带空格、中文和
单引号的目录运行真实 bootstrap；覆盖 PATH/绝对 Node、不同 CWD、无需 PS 的帮助、
缺配置提示、init 预览与重复初始化、check、安装 dry-run/参数/退出码、status 和 Web 参数/退出码。
Windows 默认浏览器改用系统 URL handler，新增回归断言 URL 作为单个参数传入；macOS 仍用 `open`。

Windows / Node `24.19.0` 的独立验收：

- 在 `.tmp/p0-review/source 中文/` 建立不含 PS 入口、个人配置和旧构建产物的源码副本，
  复用已安装的第三方依赖，`@local/*` 指向副本自身；重新初始化副本配置，从其他 CWD 调用 Node CLI。
- `ci` 的 type-check、L1–L3、L4、L5 全部退出 0；**252 tests / 252 pass / 0 fail**。
  L4 覆盖真实安装/加载与 tarball，L5 覆盖 Web 基线、slot、主题/locale 和 SSE 通知。
  汇总位于 `.tmp/p0-review/source 中文/.tmp/ci/run-3RHznU/report.json`。
- 另从其他 CWD 经真实 Node CLI 执行 `config check`、`dev-install --dry-run`、link 安装、
  `pack`、`stable-install --dry-run`、tarball 安装与 `status`，确认安装副本不再是 junction。
  `web --no-open --host 127.0.0.1 --port 0` 使用副本本机 patch，认证 HTTP 200、通知 Client
  已注册；停止 Host 后 launcher 退出，配置字节不变。报告位于
  `.tmp/p0-review/source 中文/.tmp/cli-smoke-KQWW6T/report.json`。
- 首次在沙箱内运行到 L4 时，pnpm 创建 junction 被 `EPERM` 拒绝；上述独立验收在允许
  创建链接的执行环境中重跑，未改 ACL、未修改日常 DSH profile。

远端补验（2026-10-31，Asia/Shanghai）：迁移提交 `ab745e9` 已推送至 `main`，
[GitHub Actions run 41084664654](https://github.com/mbda9091/dsh-plugin/actions/runs/41084664654)
的 `test (windows-latest)` 与 `test (macos-latest)` 均为 `success`。两平台均从固定工具链、
冻结依赖安装与配置初始化开始，经同一 Node CLI 完成类型检查和 L1–L5；本次迁移无需修复即可通过。
Windows 工具链安装耗时较长，但安装与后续测试均成功。此记录对应迁移代码提交；
后续仅更新验收文档的提交使用 `[skip ci]`，不改变已验证的代码与工作流。

默认浏览器真实打开与系统原生通知不以模拟进程测试或 L5 结果冒充通过。
P1–P4 的工具/环境隔离、配置 repair/migrate 尚未实现。


## 8. Web/UI 插件测试策略

- 当前两个桌面插件不进入 Web L5。
- Web L5 先用一个最小 Web fixture 插件（client-only，渲染一个 slot）跑通 harness。
- 第一个真实 UI 插件出现时：
  - Client 入口从手写 `client.js` 迁到 `src/client.tsx`，构建成 `client.js`；
  - Vitest 直接 import 组件/逻辑；
  - Playwright 加载真实 `dsh web`，断言 slot/交互/主题/locale/console；
  - 如果包含通知，用 stub `Notification` 断言。
- fixture 已放在 `test/fixtures/`，不进 CATALOG、不由正式插件安装脚本发现；L4/L5 显式安装它们。

## 9. 统一 Vitest 的风险与决定

风险：

1. **沙箱/进程模型**：Vitest 默认 worker/child process，DSH 沙箱可能 `EPERM`；需 `pool: 'threads'` 或普通终端/CI。
2. **不做类型检查**：esbuild 转换不等于 `tsc`；必须额外 `tsc --noEmit`。
3. **解析器差异**：Vite resolver ≠ Node ESM resolver；测试通过不代表生产加载通过。
4. **环境分裂**：node 与 jsdom 两套 environment/setup。
5. **覆盖率合并**：与 `node:test` 的 coverage 格式/阈值不同。
6. **依赖变重**：Vite/esbuild/jsdom/Testing Library 进入 devDependencies。
7. **迁移成本**：现有 node:test 断言/mock/watch 要重写。
8. **UI 保真度**：jsdom 仍不是浏览器，L5 仍必须 Playwright。

**决定**：不统一。保持：

- Host/scripts：`node:test`；
- UI 组件：Vitest；
- L5：Playwright；
- 所有 TS 由 `tsc` 兜底类型检查。

## 10. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 方案文档（本文） | ✅ 本文 |
| M1 | 用官方 shipped `web` profile，完成 readiness checklist | 完成：独立浏览器基线由 M5 补齐 |
| M2 | 最小 Web fixture + L5 Playwright spike | 完成：原型的注册、可见 DOM 与 console 假通过已由 M5 修复 |
| M2.5 | approval-allowlist observe 安装与精确规则 | ✅ 完成：observe 采集、allow 规则、无审批 L5 均验证 |
| M3 | TS 脚本骨架 + 只读/构建脚本迁移 | 已完成：四个命令已迁 TS；普通终端入口回退已修复，未设置环境变量/正常 home/隔离 home 三种环境验证通过（§14） |
| M4 | L1–L3 测试 + L4 harness | 完成：当前 251 项用例、四个插件打包契约与真实 L4；Windows/macOS CI 通过，见 §19.7 |
| M5 | L5 Playwright 正式接入 + CI | 完成：Windows/macOS 远端类型检查与 L1–L5 全部通过（§19.7） |
| M6 | 第一个 UI 插件出现后接入 Vitest 组件测试 | 待开始（依赖 UI 插件） |

注意：原计划的“当前插件适配 Web”已取消，`app-restart` / `desktop-notify` 保持 desktop-only。

## 11. 决策记录

| ID | 决策 | 日期 | 状态 |
|---|---|---|---|
| D1 | L5 先只做 Web；桌面 L5 延期 | 2026-10-24 | 已定 |
| D2 | `app-restart`、`desktop-notify` 暂不适配 Web | 2026-10-24 | 已定 |
| D3 | `web` 是 shipped profile，直接 `dsh web` 使用；测试用 workspace-local `DSH_HOME` 隔离，不手工拼 profile | 2026-10-24 | 已定（实测修正） |
| D4 | L4 与 L5 分开；L4 无浏览器，L5 用 Playwright | 2026-10-24 | 已定 |
| D5 | `browser-use` 只做探索式验收，不进 CI | 2026-10-24 | 已定 |
| D6 | 测试 runner 不统一：node:test + Vitest UI + Playwright | 2026-10-24 | 已定 |
| D7 | TS 脚本必须 `tsc` 编译，保留 `bootstrap.mjs` | 2026-10-24 | 已定 |
| D8 | 沙箱优先，失败后普通终端/CI | 2026-10-24 | 已定 |
| D9 | L5 使用 `playwright-core` + 系统 Chrome；fixture 放 `test/fixtures/`，不纳入 CATALOG | 2026-10-24 | 已定 |
| D10 | L5 在 workspace-write 下不可行；需要 `danger-full-access`，由 allowlist 或手动审批放行 | 2026-10-24 | 已定（实测修正） |
| D11 | 审批加白只做 exact-call 匹配，不做 reason 子串匹配 | 2026-10-24 | 已定 |
| D12 | `approval-allowlist` 默认 observe，精确规则才切 allow | 2026-10-24 | 已定 |
| D13 | 审批通知延迟 300ms，收到 `approval/decided` 即取消，避免 allowlist 误报 | 2026-10-24 | 已实现，待重启验证 |
| D14 | 只读/构建脚本迁 TypeScript，`.ps1` 在安装脚本迁完前保留为薄壳；根 `package.json` 同时提供 `build`/`check`/`catalog`/`status` | 2026-10-24 | 已定（M3 落地） |
| D15 | 插件发现改为 `dsh.bundle` 清单驱动；脚本层共享代码放 `scripts/src/core/`，不叫 `lib/`（`.gitignore` 会吞掉） | 2026-10-24 | 已定（实测修正） |
| D16 | `catalog` 的表头与错误提示改指 `node scripts/bootstrap.mjs catalog`，与 TS 入口对齐 | 2026-10-24 | 已定（M3 落地） |
| D17 | L1–L3 测试放 `test/src/`，用 `tsc -p test/tsconfig.json` 编译到 `test/.build`，再跑 `node --test --test-isolation=none --test-concurrency=1`；测试 import 插件的**已构建**入口（`@local/*` → `lib/index.js`），与 DSH 实际加载一致 | 2026-10-24 | 已定（M4 落地） |
| D18 | 插件导出纯函数/注册函数供 L1/L3 使用（脚本生成、转义、规则匹配、命令注册、事件订阅），`apply` 行为不变；不引入模块 mock | 2026-10-24 | 已定（M4 落地） |
| D19 | L4 是单独的慢命令 `l4`（默认不随 `test` 跑）：一次性 `DSH_HOME`、真实 `dsh web`、无浏览器；失败保留日志/报告，成功清理重目录 | 2026-10-24 | 已定（M4 落地） |

## 12. 风险与开放问题

### 风险

- DSH 的 workspace-write 下无法启动 Chrome：Playwright `spawn EPERM`；`Start-Process chrome.exe` 报 crashpad/mojo `Access denied`。`danger-full-access` 下可启动，因此需要 allowlist 或手动审批。
- `dsh web` 使用真实 `$DSH_HOME` 会重写 `cordis.yml`；workspace-local `DSH_HOME` 已规避审批。
- pnpm 在沙箱内仍可能因目录修改或 symlink 权限报 `EPERM`；workspace-local `DSH_HOME` 并不能隔离 pnpm 的所有 store 写入。§14 的 fixture 安装在沙箱内失败、沙箱外通过。
- 此前沙箱外的 `ENOENT scandir ..._tmp_.../node_modules` 已通过隔离对照定位到 HMR：Windows 反斜杠导致默认忽略规则未匹配，监听器持有依赖目录句柄，使 pnpm 移动失败。仓库 Web patch 已收窄监听到插件 `lib/` 并补充 Windows 忽略规则；须重启使用该 patch 的 Web 服务后重试。证据和步骤见 [Web profile README](../profiles/web/README.md)。不再将该错误统一归因于沙箱 ACL 或记为“根因未知”。
- Web profile 与官方模板可能随 DSH 升级漂移，需要记录版本/生成方式。
- workspace-local `DSH_HOME` 不包含用户的凭据/设置；需要真实模型回合的测试要单独提供测试凭据，或避免调用模型。不要把用户凭据复制进测试 home。
- Playwright 浏览器依赖、端口、进程清理在 Windows/macOS 上不同；`taskkill` 可能对已退出子进程打印 `Access denied`。
- Vitest worker 在沙箱内可能 `EPERM`。
- 沙箱内 `spawnSync` 默认的管道 stdio 会 `EPERM`（已实测），`stdio: 'inherit'` 正常；脚本和测试里的子进程必须继承 stdio，需要捕获输出时写临时文件。
- `dsh web` 引擎（`ELECTRON_RUN_AS_NODE=1`）仍然报告 `process.versions.electron`；插件 `src/targets.ts` 当前把这种进程判为 `desktop`，因此 web 里的“桌面插件应被跳过”无法被 L4 观测。L4 用声明 `headless` 的 fixture 验证失败上报；surface 检测本身的修正待定（§14）。
- Windows 上 `taskkill /T /F` 对由 `dsh.cmd` 启动的进程会报 `Access denied`；L4 改为直接 spawn 引擎并 `child.kill()`，再以端口关闭为最终判据。
- L4 依赖本机 `dsh` CLI、pnpm 运行时和一次性 profile；未安装 DSH 的环境只能跑 L1–L3。
- 根 `@types/node` 已显式声明并更新 lockfile（§19），不再依赖插件依赖的隐式提升。
- 手写 `client.js` 可测试性差，UI 插件需要 TS/TSX 构建。
- 安装脚本迁移涉及 pnpm/dsh 透传、junction 删除风险，必须最后做。

### 开放问题

1. CI 里用系统 Chrome 还是 Playwright 下载的 Chromium？浏览器安装/缓存如何管理？
2. L5 的 CI 运行器：Windows 还是 macOS，是否都能跑 DSH Web？
3. TS 脚本的 Node 下限：仅 Node 24，还是兼容 Node 20？
4. 第一个 Web/UI 插件是什么，何时替换 `test/fixtures/web-hello`？

## 13. M1–M4 验收状态

M1：

- [x] `web` profile 由官方 shipped `web` 初始化，路径和生成命令记录在文档中。
- [x] `dsh --profile web --dump-config` 成功，能定位到插件行。
- [x] `dsh web` 能启动，HTTP 200，URL/token 可获取。
- [x] 无 fixture 的独立浏览器基线已验证，且先于安装测试插件执行（§19）。
- [x] 记录沙箱内/外执行的差异（EPERM、workspace-local `DSH_HOME`、端口/进程清理）。
- [x] 不修改用户 `desktop` profile、不写入用户会话数据。

M2：

- [x] 最小 fixture `test/fixtures/web-hello` 创建。
- [x] fixture 以 `link:` 装进 workspace-local web profile。
- [x] `--dump-config` 出现 `web-hello` 行。
- [x] Web HTML boot 数据包含 `@local/web-hello` client module。
- [x] L5 脚本 `test/e2e/web-l5.mjs` 就绪（playwright-core + Chrome + marker/console/screenshot）。
- [x] 实际跑通 L5：`factory/applied/registered=true`，console/pageerror 为空，截图已生成。
- [x] `conversation.composer.dock` 的注册、可见 DOM、交互与刷新单次渲染均由 M5 验证（§19）。

M2.5：

- [x] `approval-allowlist` 插件实现，默认 observe，exact-call 匹配。
- [x] `link:` 安装进 desktop profile，bundle on。
- [x] 重启 DSH，确认插件加载（observe 审计日志出现）。
- [x] observe 一次 L5 命令，记录真实 `tool`/`arguments`。
- [x] 在 desktop profile 写入精确 allow 规则（`tool: pwsh` + command + sandbox_permissions，无限放行）。
- [x] 重启 DSH，验证 allow 规则生效（无审批跑通 L5）。

M4：

- [x] `scripts/src/core/` 的 L1 覆盖（target 解析、插件发现、JSON/profile 路径、安装模式）。
- [x] 插件纯函数 L1：VBScript 生成/转义、PowerShell+XML 转义、allowlist 规则匹配/次数/过期。
- [x] L2 契约：包名/目录/loader 行一致、targets、locale 前缀、patch、`files`、`exports`、`lib` 入口可导入、构建新鲜度、图标/README；三个正式插件实际 tarball 内容及解包入口检查，含漏打包反例。
- [x] L3：`apply` 的 target 守卫、`/restart` 注册与 handler 单次调用、`session/event` 路由/延迟取消/子代理过滤、approval waterfall 的 observe/allow/maxUses/rootOnly/审计。
- [x] L4：一次性 home、link 安装、`--dump-config` 行、真实 `dsh web` 200 + boot HTML、匹配失败上报、tarball 安装为真实拷贝、端口关闭与清理。
- [x] `node scripts/bootstrap.mjs test`（146 用例）与 `l4`（7 阶段）在 Windows 本机通过；macOS 条件模拟通过，未做 macOS 真机验收。
- [x] L4、L5 纳入 Windows/macOS CI workflow（M5）。
- [x] GitHub Actions Windows/macOS 远端验收通过（2026-10-30，§19.7）；这里的 macOS 证据限于 runner 上的 Web 自动化。

## 14. M1–M3 复核与修正（2026-10-24）

结论：M1–M3 主链路可用，M3 的普通终端入口问题已修复；M2 的浏览器测试原型仍有断言待补，不能将一次成功运行当成完整测试门禁。M4 的分层测试/harness 已于同日实施（见 §15）；M5 的正式 L5/CI 尚未建设完成。

### 实际复核结果

- 指定 `DSH_NODE` 后，`scripts/build.ps1 -Check` 和完整构建通过；三个插件的入口在带/不带 `--preserve-symlinks` 两种模式下导入成功。
- 使用全新的 `.tmp/m1-m3-review/dsh-home`，通过官方 CLI 初始化 shipped `web`、安装 `web-hello` fixture；未修改用户现有 profile 或复用用户会话。
- fixture 安装在受限沙箱内因 pnpm store 的 symlink 权限报 `EPERM`；沙箱外安装通过。
- `--dump-config` 包含 fixture 行，HTTP 返回 200，boot HTML 包含 client module；真实 Chrome 输出 `factory/applied/registered=true`、`error=null`，console/pageerror 为空。服务关闭后端口确认不再响应。
- 本次仍只验证加载和注册；未验证 slot 实际可见 DOM、主题、locale、交互，也未单独跑无 fixture 的浏览器基线。tarball 安装和运行时行状态断言属于待建的 L4 harness（§15 已补）。

### M2.5：allowlist 次数语义已修正

- 用户确认：省略 `maxUses` 或设为 `0` 均不限制次数；正安全整数限制本次插件加载期间的放行次数。
- 负数、小数、字符串、`null`、非有限数或不安全整数：加载时打印包含规则索引的错误日志，并跳过该规则的白名单匹配。错误日志不受审计开关 `log: false` 影响；其他有效规则继续匹配，没有规则命中时进入原审批流程。
- 已对编译后的真实插件入口执行 18 组同进程模拟验证，覆盖不限次数、次数耗尽、非法值、一次性错误日志、有效规则仍可命中及 observe 模式；类型检查和完整构建通过。这些临时验证尚未纳入 M4 的持久测试套件（§15 已将其中的规则与 waterfall 语义固化为 L1/L3 用例）。
- 源码与本地 `lib/` 已更新；未重启用户 DSH，正在运行的插件仍需重新加载新 Host 代码后生效。

### M2：L5 原型存在假通过，待修

L5 指真实浏览器测试；当前 `test/e2e/web-l5.mjs` 是 M2 的最小原型，用来验证 DSH Web 能加载测试插件。M5 才负责把它扩展成完整测试并接入 CI。

当前原型只等待 factory、断言 apply，不断言 `registered`，且只对包含 `slot entry crashed` 的 console error 判失败。用模拟浏览器返回 `registered=false` 并报告连接错误，脚本仍成功退出，已复现假通过。应补充等待与注册/slot 断言，并对全部非预期 console errors 判失败；实际 DOM、主题和交互断言在 M5 完善。本次仅同步缺口，未修改 L5 脚本。

### M3：普通终端工具定位已修复

原问题：`scripts/common.ps1` 直接用空的 `$env:DSH_HOME` 拼路径，导致普通 PowerShell 执行 `build.ps1`、`check-targets.ps1`、`catalog.ps1`、`status.ps1` 时，在工具定位阶段报错。

修复后的解析规则：

- Node：显式 `DSH_NODE` → 当前 `DSH_HOME` 的运行时 → 用户默认 `~/.dsh` 的运行时 → PATH 上的 Node。未配置 home 时直接使用默认 home；显式 `DSH_NODE` 无效时给出错误，不静默改用其他 Node。
- pnpm：当前 home 的运行时 → 默认 home 的运行时 → PATH。运行时 `pnpm.cjs` 通过已解析的 Node 执行；PATH 的 pnpm 直接执行，避免把 Windows 的 `pnpm.cmd` 当 JavaScript。`pack`、`dev-install`、`stable-install` 已同步调用方式。
- profile：当前会话匹配的 `DSH_PROFILE_DIR` 优先，其次使用 `DSH_HOME/profiles/<name>`；未配置 home 时使用 `~/.dsh/profiles/<name>`。隔离 home 中缺少运行时只触发工具回退，profile 仍留在隔离 home。
- 都找不到工具时，明确提示设置 `DSH_NODE` 或安装工具/配置 PATH，不再暴露空路径异常。

Windows / PowerShell 7 实测矩阵（每组均清除 `DSH_NODE`、`DSH_PROFILE`、`DSH_PROFILE_DIR`）：

| 环境 | 工具来源 | profile 路径 | 结果 |
|---|---|---|---|
| 未设置 `DSH_HOME` | 默认 `~/.dsh` 运行时 | 默认 home 的 `profiles/desktop` | 通过 |
| `DSH_HOME` 指向正常 `~/.dsh` | 指定 home 的运行时 | 指定 home 的 `profiles/desktop` | 通过 |
| `DSH_HOME` 指向无运行时的隔离测试 home | 回退到默认 `~/.dsh` 运行时 | `.tmp/m1-m3-review/dsh-home/profiles/web` | 通过 |

每组均执行并检查退出码：`build.ps1 -Check`、`build.ps1`、`check-targets.ps1`、`catalog.ps1 -Check`、`status.ps1 -Profile <name>`、`dev-install.ps1 -DryRun -Profile <name> -Surface web`；并断言 Node/profile 路径，实际运行解析出的 pnpm `--version`。

补充验证：显式 `DSH_NODE` 优先、非法路径报错、`DSH_PROFILE_DIR` 不串用到其他 profile；模拟无运行时候选后，PATH 上的 Node 和 `pnpm.cmd` 均成功执行 `--version`。未设置 DSH 环境变量时，`pack.ps1 -SkipBuild` 实际打包和 `stable-install.ps1 -DryRun -Profile desktop -Surface web` 也通过。

验证前后真实 desktop 与隔离 web 的 `package.json`、`cordis.patch.yml` 哈希一致；没有执行真实安装。矩阵脚本和日志保留在忽略目录 `.tmp/m1-m3-review/terminal-matrix.ps1`、`terminal-matrix.log`，尚未纳入 M4 的持久测试套件。本次验证平台为 Windows，未声称 macOS 已实测。

## 15. M4 实施结果（2026-10-24）

### 15.1 落地内容

- **L1–L3 持久测试**：`test/src/` 下 9 个 `*.test.ts`（§16 增加 target-environment 后为 10 个），`tsc -p test/tsconfig.json` 编译到 `test/.build`，
  再由 `node --test --test-isolation=none --test-concurrency=1` 串行执行。
  - L1：`scripts/src/core`（target、发现、JSON、profile、安装模式）+ 插件导出的纯函数
    （VBScript 生成/转义、PowerShell/XML 转义、allowlist 规则匹配/次数/过期）。
  - L2：独立重新推导契约（目录=包名后缀=行 id、targets、locale 前缀、patch、`files` 覆盖、
    `exports` 可解析、`lib` 入口可导入、`lib` 比 `src` 新、图标/README、fixture 契约）。
  - L3：假 Context + 假服务/agent/session 调 `apply`，断言 target 守卫、`/restart` 只注册一次且
    handler 每次只触发一次、`session/event` 的延迟/取消/子代理过滤、approval waterfall 的
    observe/allow/maxUses/rootOnly/审计；M2.5 当时的 18 组临时验证中的规则语义已固化为 L1/L3 用例。
- **L4 harness**：`node scripts/bootstrap.mjs l4`（`pnpm test:l4`）。一次性
  `.tmp/l4/<run>/dsh-home`，真实 `dsh` CLI、真实 `dsh web`、无浏览器；`prerequisites`
  之后的七个检查阶段：
  `profile-init → install-link → web-link → install-mismatch → web-mismatch →
  install-tarball → web-tarball`。
- **命令入口**：`node scripts/bootstrap.mjs test [--only l1,l2,l3] [--skip-build]`、
  `l4 [--keep] [--home <dir>] [--skip-tarball] [--timeout <ms>]`；根 `package.json` 增加
  `test` / `test:l4`。
- **为可测试性做的小改动**（`apply` 的运行时行为不变）：`app-restart` 导出脚本生成器与
  `registerRestartCommand`；`desktop-notify` 导出转义/脚本函数与 `registerSessionNotifications`；
  `approval-allowlist` 把规则匹配拆到 `src/rules.ts` 并导出。`scripts/src/core` 新增
  `exec.ts`（无管道子进程）与 `dsh-cli.ts`（定位/包装 dsh），`resolveInstallMode` 移入 `core/dsh.ts`。

### 15.2 实测证据（Windows，`.tmp` 工作区）

- `node scripts/bootstrap.mjs test`：**129 tests / 26 suites / 129 pass / 0 fail**（约 0.4 s；§16 改为默认 Node 的 dsh 后增至 138 / 27）；
  `test` 默认先跑 `build`（metadata 门禁 + 三插件 tsc），再编译并运行测试。
- `pwsh -File scripts/build.ps1 -Check`：targets/catalog/tsc 全部通过。
- `node scripts/bootstrap.mjs l4`：`prerequisites` + 七个检查阶段全部 PASS，报告写入
  `.tmp/l4/last-report.json`；关键 detail：
  - `install-link`：两个包均为 `link:` 依赖，bundles 与 `--dump-config` 行一致；
  - `web-link`：`HTTP 200, boot HTML contains @local/web-hello, no activation warnings`；
  - `web-mismatch`：loader stderr 出现 `entry did not activate` + `target-mismatch` +
    `target mismatch`，服务仍返回 200；
  - `install-tarball`：`local-approval-allowlist-0.1.0.tgz` 安装后 `node_modules` 不是链接；
  - `web-tarball`：`HTTP 200, tarball-installed plugin activates`；
  - 所有测试端口在步骤结束后确认关闭；成功后运行目录被删除，只保留报告（`--keep` 保留日志）。

### 15.3 实测发现（已处理或已记录）

1. **Node 24 不能直接 spawn `.cmd`**（`EINVAL`）。L4 解析 `dsh.cmd` 的
   `--expose-internals` 行，直接 spawn 桌面引擎并设 `ELECTRON_RUN_AS_NODE=1`；
   `app.asar` 里的 `cli.js` 是虚拟路径，`existsSync` 为假，不能用来校验。
   这也让 `dsh web` 成为可直接 `kill()` 的子进程。
2. **`dsh web` 的认证握手是 303 + HttpOnly cookie**：`/?token=...` 返回 303 和
   `set-cookie: dsh-auth-*`，重定向目标不带 token。Node fetch 没有 cookie jar，
   L4 复制这次 Set-Cookie 再跟随一次重定向；直接 `redirect: 'follow'` 会得到 401。
3. **`taskkill /T /F` 在沙箱内对相关进程报 `Access denied`**，进程仍存活；
   `child.kill()`（direct spawn 的引擎）可用，最终以端口关闭作为断言。
4. **`dsh web` 引擎仍带 `process.versions.electron`（本机 44.7.0）**：插件
   `src/targets.ts` 的旧 `currentEnvironment()` 因此把 web 判为 `desktop`。
   - 影响：桌面插件在 web 里不会被守卫拒绝；web-only 插件在 web 里反而可能被判 desktop。
   - L4 不依赖此判定：`target-mismatch` fixture 声明保留值 `headless`，所以无论 surface 检测
     怎么修都会失败，用于验证“失败必须被上报”而不是验证判定逻辑。
   - **已修正（§16）**：Web 改用默认 Node 的 `dsh` 启动，surface 判定改为读取
     `profileContext.startedBundles`；Electron 引擎启动的 web 仍会被判 desktop，已不再作为推荐路径。
5. **脚本层 `declaration` 改为 true**：测试通过 `scripts/.build/core/*.js` 引用脚本层，
   tsc 需要相邻 `.d.ts`。这些声明只存在于 gitignored 的 `.build/`。
6. **测试直接 import 已构建的插件入口**（`@local/*` → `lib/index.js`）：L2/L3 因此验证的是
   DSH 实际加载的产物；`test` 默认先构建，`--skip-build` 仅用于迭代。
7. **根 `@types/node` 仍靠提升**：与 §7.4 记录一致，L1–L3 也依赖这一点；
   未在本轮重新引入根 devDependency（避免再次卡在 pnpm install）。

### 15.4 验收边界（不夸大）

- L4 证明 loader 行、插件激活/失败上报、HTTP 服务与 boot HTML；**不**证明浏览器内 slot 可见、
  主题、locale、交互或 console —— 那是 L5（M5）。
- L3 用的是假 Context/假服务，不是真实 Cordis Host；真实服务契约仍由 L4 的加载结果兜底。
- 本机实测平台为 Windows；macOS 的 L4（进程停止、pnpm 路径）尚未实测，CI 接入属 M5。
- L5 原型 `test/e2e/web-l5.mjs` 的假通过缺口未改动，仍按 §14 由 M5 处理。

## 16. 后续修正：Web 改用默认 Node 的 dsh（2026-10-25）

### 16.1 问题

- 桌面安装自带的 `dsh.cmd` 把 Host 跑在 Electron 引擎里，`process.versions.electron` 存在；
  插件旧守卫据此把 `dsh web` 的 Host 判成 `desktop`（§15.3-4）。
- 默认 Node 里另装了 `npm i -g @deepseek-ai/dsh@0.2.1-rc.2`。它启动的 `dsh web` 是普通
  `node.exe`，`electron` 为 `null`；但旧守卫的 web 分支依赖 `ctx.get('webServer')`，而该服务
  在插件 `apply` 时还没有就绪，会把 Web Host 误判成 `headless`。

### 16.2 实测（npm dsh + Node v24.22.1）

用一次性 `DSH_HOME` 安装一个探针插件，记录 `apply` 时的环境：

```json
{
  "when": "apply",
  "electron": null,
  "webStartup": false,
  "webServer": false,
  "profileName": "web",
  "startedBundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/..."],
  "argv": ["...\\node.exe", "...\\@deepseek-ai\\dsh\\lib\\bin.js", "web", "--no-open", ...]
}
```

1.5 s 后 `webStartup`/`webServer` 才出现。旧守卫下，`approval-allowlist`
（desktop+web）在 npm `dsh web` 里报
`target mismatch ... current surface=headless` 并变成 failed；而 `app-restart`
（desktop-only）在 Electron 引擎的 web 里反而不报错。

三种形态的实际启动验证（同一探针插件，`apply` 时记录）：

| 启动方式 | `electron` | `startedBundles` | 判定 |
|---|---|---|---|
| npm `dsh web --no-open ...` | `null` | base + `dsh-web-app` + 插件 | `web` |
| npm `dsh --profile web --no-open ...` | `null` | base + `dsh-web-app` + 插件 | `web` |
| npm `dsh headless "..."` | `null` | base + `dsh-headless` + 插件 | `headless` |
| 桌面引擎（`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`） | `44.7.0` | 任意 profile（探针用 headless 验证） | `desktop` |

`dsh headless` 在缺凭据时会以 `MISSING_CREDENTIAL` 退出，但插件 `apply` 早于该错误，
探针日志已写入，可用于判定。

其他实测：

- `dsh web --no-open --host 127.0.0.1 --port 0`：HTTP 200（37 KB），进程是
  `node.exe`，监听 PID 与进程树可直接停止；
- `dsh plugin --profile web add <dir>` 会转发给 PATH 上的 `pnpm`。本机 PATH 只有 Corepack
  shim，其缓存目录在 `%LOCALAPPDATA%\node\corepack`（工作区外），沙箱下 `mkdir` 报 `EPERM`；
- 用 DSH 运行时自带的 pnpm（`dsh-runtimes/*/dependencies/pnpm/bin/pnpm.cjs`）做 shim 后，
  link/tarball 安装都通过，store 落在 `<repo>\.pnpm-store`。

### 16.3 修正内容

- **surface 判定改为 bundle 信号**：三个插件的 `src/targets.ts` 新增并导出
  `detectEnvironment(ctx)`：
  - `process.versions.electron` 存在 → `desktop`（桌面 Host 优先）；
  - 否则 `profileContext.startedBundles` 含 `@deepseek-ai/dsh-web-app`（或以
    `/dsh-web-app` 结尾）→ `web`；
  - 否则 → `headless`。
  `webServer` / `webStartup` 不再参与判定；错误信息中的平台词改用 `windows`/`mac`。
- **启动入口优先默认 Node 的 dsh**：
  - `profiles/web/start.ps1` 的解析顺序改为 `DSH_CLI` → PATH 上的 `dsh`（仅 `.cmd`/`.exe`）
    → 桌面安装路径；并改为轮询 `HasExited` 等待、`Process.Kill($true)` 收尾，避免沙箱内
    `Wait-Process`/`taskkill` 的 `Access denied`；
  - `scripts/src/core/dsh-cli.ts` 同样优先 PATH；识别 npm `dsh.cmd` 的
    `node .../@deepseek-ai/dsh/lib/bin.js` 形式，直接 spawn Node，保留 Electron 包装器和
    `cmd.exe` 回退；
  - L4 在运行目录生成 `pnpm` shim（Windows 为 `pnpm.cmd`，POSIX 为可执行脚本）并加入子进程
    PATH，避免依赖宿主机 Corepack 缓存。
- `test/fixtures/target-mismatch` 的内联守卫同步新判定（声明 `headless`，在任何真实 Host 中
  都会失败）。
- L3 新增 `target-environment.test.ts`，覆盖 desktop/web/headless、别名 bundle、畸形
  `startedBundles`、以及“旧 webServer 信号不再生效”。

### 16.4 证据

- `node scripts/bootstrap.mjs test`：**138 tests / 27 suites / 138 pass / 0 fail**。
- `node scripts/bootstrap.mjs l4`：`prerequisites` + 七个阶段全部 PASS；报告中的 `dsh`
  指向 PATH 上的 npm `dsh.cmd`（`.tmp/l4/last-report.json`）。`web-link` 无激活警告
  （说明 `approval-allowlist` 在 npm dsh 的 web 里正常激活），`web-mismatch` 仍有
  `entry did not activate` + `target mismatch`。
- 手工：npm `dsh web` 中 `approval-allowlist` 激活；安装 `app-restart` 后它被报告
  `current surface=web` 并 failed（desktop-only 的预期结果），服务仍返回 200。
- 手工：`profiles/web/start.ps1 --no-open --port 53124` 用 npm dsh 启动，HTTP 200；
  停止 node 进程后 launcher 正常退出，无 `Access denied`。

### 16.5 边界

- `desktop` 优先于 bundle：Electron 引擎跑任何 profile（探针实测包括 `headless`）都会被判
  `desktop`。这是桌面 Host 的正确语义，但也意味着不能用桌面 CLI 跑 Web。
- `web` 判定依赖 profile 实际组合了 `@deepseek-ai/dsh-web-app`（或名字以 `/dsh-web-app`
  结尾的别名）；自定义的 Web bundle 若用别的包名，会被判成 `headless`，需要在
  `detectEnvironment` 的识别列表里补充。
- 用桌面安装的 CLI 启动的 web 仍会被判 `desktop`；这是旧路径，不再推荐。要得到正确的
  `web` 判定，使用 `profiles/web/start.ps1` 或直接运行 PATH 上的 `dsh web`。
- 正在运行的旧 Web 服务（含本机 10089）不会自动切换；需要用新 launcher 重启。
- npm dsh 的 `plugin add` 依赖 PATH 上的 pnpm。普通终端由 Corepack/系统 pnpm 提供；
  沙箱内由 L4 的 shim 提供，未修改宿主机 Corepack 缓存。
- 本机实测仍是 Windows；macOS 的 launcher/PATH 行为未实测。

## 17. M4 复核修正与验收（2026-10-25）

本轮修正三个问题：L2 没有验证实际包内容导致漏包仍通过；L4 失败时默认删除日志；
`app-restart` 的测试错误地要求 macOS 也成功注册。修正后 Windows 验证通过，
macOS 仅验证了模拟条件，不代表 macOS 真机 L4 已验收。

### 17.1 三个插件的打包契约

`lib` 是 TypeScript 编译产物，不是一种安装方式。link 开发安装使用仓库目录里的 `lib`；
tarball 稳定安装使用 `.tgz` 解包后的 `lib`。本地能导入入口，不代表这些文件已进入 tarball。

L2 现在对 `app-restart`、`approval-allowlist`、`desktop-notify` 分别执行：

1. 真实 `pnpm pack`，将 `.tgz` 解包到仓库内一次性目录。
2. 校验包内全部 `lib/` 文件（包括非入口模块、类型声明及映射文件）、locale、bundle patch、
   README 与所有 `exports` 目标；与源目录逐文件比较内容，并检查包的关键元数据。
3. 在新的 Node 进程中导入解包后的入口，分别带/不带 `--preserve-symlinks`，检查 `apply` 与插件身份。
4. 对每个插件复制一份测试包，故意从 `files` 移除全部 `lib`：先确认本地入口仍可导入，
   再实际打包，断言包内容检查必须拒绝该 tarball。测试不修改正式插件源码或清单。

依赖：Node、已有 TypeScript 依赖、pnpm 的 `pnpm.cjs`、PATH 上的 `tar`。
pnpm 使用与 L4 相同的定位规则（`DSH_PNPM` 显式路径优先，其次 DSH 运行时）；
工具缺失直接报错，不跳过打包检查。L2 因此会运行文件重定向的子进程，但不启动 DSH 或浏览器。

| 验证 | app-restart | approval-allowlist | desktop-notify |
|---|---|---|---|
| 本地构建及入口导入 | 通过 | 通过 | 通过 |
| 实际 tarball 内容及解包入口导入 | 通过 | 通过 | 通过 |
| 故意漏掉 lib 的反例能被拒绝 | 通过 | 通过 | 通过 |
| 真实 DSH link/tarball 安装及激活 | 未做桌面验收 | Web 两种方式均通过 | 未做桌面验收 |

三个插件的打包契约均已覆盖；两个桌面插件的真实重启/Toast 和桌面安装激活仍属于人工验收，
不能用解包入口导入来替代。L4 的 Web fixture 与真实通用插件范围保持不变。

### 17.2 L4 现场保留规则

- 失败：无论是否传 `--keep`，自动保留本次运行目录、日志、临时 profile 与 `report.json`。
- 成功：默认清理自动创建的运行目录；`--keep` 表示成功时也保留现场。
- 显式传 `--home` 的成功运行仍沿用保留策略，避免清理调用者指定的测试 home。
- `.tmp/l4/last-report.json` 始终提供最新汇总，增加 `runDir`、`logDir` 方便定位；
  保留现场中的 `report.json` 不会被下一次运行覆盖。运行目录使用随机后缀避免同秒冲突。
- 持久回归用例主动制造 `profile-init` 失败，断言退出码非零、错误日志及独立报告仍在；
  检查结束后测试清理自己的现场，并恢复此前的最新汇总，避免把预期失败留作真实 L4 的最新结论。

### 17.3 macOS 测试预期

`app-restart` 仍只支持 Windows。测试显式模拟 Windows 桌面，断言命令注册成功及缺少服务时的提示；
另模拟 macOS 桌面，断言场景守卫报 `platform=mac`，且拒绝发生在命令/事件注册之前。
平台及 Electron 标记均在测试后恢复。这里不把插件适配到 macOS，也不触发实际重启。

### 17.4 验证结果

- `node scripts/bootstrap.mjs test`：**146 tests / 27 suites / 146 pass / 0 fail**，包含三个插件的
  真实打包与漏包反例、失败日志保留回归；默认先完成构建。
- `pwsh -NoProfile -File scripts/build.ps1 -Check`：targets、catalog、类型检查通过。
- 在 `process.platform=darwin` 的模拟进程中运行 `app-restart` 测试：**7/7 通过**；未声称 macOS 真机通过。
- 使用 Node 版 npm dsh 运行完整 `l4`（不带 `--keep`）：前置检查及七个阶段全部通过；
  三次 Web 服务的端口关闭检查通过，成功后运行目录确认已删除，最新报告保留且 `ok=true`。
- L4 的真实安装在沙箱外执行以满足 pnpm store 链接权限；使用一次性 workspace-local home，
  未安装到用户现有 desktop/web profile。

M4 本轮三个问题已修复。M5 的正式 L5、CI 和 macOS 真机验证仍待完成；§15、§16 中的
129/138 用例数字保留为当时的历史证据，当前验收以 §19.7 为准。
## 18. 通知 Host 统一后的测试补充（2026-10-25）

本轮把 Desktop 与 Web 的触发条件统一到 `packages/notify-host`，Web 改为经过认证的 SSE 通道；测试范围相应扩大：

- 仓库现有 **四个插件**：`app-restart`、`desktop-notify`、`notify-web`、`approval-allowlist`。
- **两个构建期共享库**：`packages/notify-core`（文案/locale）、`packages/notify-host`（触发逻辑）；它们不进 CATALOG，也不安装到 profile。
- L1–L3 当前为 **189 tests / 35 suites / 189 pass / 0 fail**。
- 新增 `test/src/l3/notify-host.test.ts`：根/子会话、审批延迟与取消、重复 asked、已显示审批撤回、`agent/disposed`、全部 `turn/end` 原因、四个开关。
- 新增 `test/src/l3/notify-web-host.test.ts`：直接调用 `connection.fetch.register` 的 route，读取 SSE 流，覆盖 `sync`、增量 `update`、同 epoch replay、非法游标 400、epoch 重置。
- 重写 `test/src/l3/notify-web-client.test.ts`：在 VM 中提供 `fetch` 可控 SSE 流、Notification、localStorage、`document.baseURI`，覆盖审批/完成/错误/撤回/点击、权限手势、cursor 恢复、replay 去重。
- `test/src/l3/desktop-notify.test.ts` 更新为共享源的语义：`session/event` + `agent/disposed` 两个全局监听、重复审批只发第一条、无法确认根身份不通知。
- L4 `web-link` 现在先交换一次启动 token 并保留 Cookie，然后断言：
  - 无 Cookie 的 `GET /api/notify-web/events` 返回 401/403；
  - 带 Cookie 返回 200、`content-type: text/event-stream`；
  - 首帧是 `event: sync`。
  这验证了真实 DSH Connection 的认证与流式 bridge，不只检查 boot HTML 是否包含模块名。
- 构建验证：`build --check`、`build`、`test`、`l4`（含 tarball 阶段）与 `l4 --skip-tarball` 均通过。L4 仍使用一次性 workspace-local `DSH_HOME`，不修改用户现有 profile。

当时尚未完成（后续自动化与原生通知记录分别见 §19、通知方案 §11.11；当前待办以 §20 为准）：

- 真实浏览器中的操作系统通知弹出、权限手势、点击聚焦/切会话、多标签页锁接管；沙箱内 Chrome 仍因 `spawn EPERM` 无法启动，模拟 Notification 不能替代。
- L5 若要覆盖通知，应使用真实 `dsh web` + Playwright，stub `Notification` 以记录构造与点击，同时保留真实 SSE 流；不要把“boot HTML 含模块名”当作通知通过。
- macOS 真机、Host 重启后跨进程恢复待审批仍不在本轮范围。

§17.4 的 146 用例数字与更早的 129/138 保留为历史证据；当前验收以 §19.7 为准。

## 19. M1–M4 复核与 M5 实施（2026-10-28）

本节取代前文“待 M5”与旧用例数量的当前状态；历史证据保留。复核起点为工作区已有的四插件/共享通知实现，198 个 L1–L3 用例通过，未覆盖或撤销这些既有改动。

### 19.1 已修复的复核问题

- M2 原型只断言 factory/apply、不验证可见 DOM，且忽略普通 console error。正式 L5 等待注册完成，断言 factory/apply/registered、slot 名、可见 DOM、数量和真实 Host 回声；任何非预期 console error/pageerror（含 `slot entry crashed`）均失败。
- 欢迎页不渲染 composer dock，创建空白会话仍不够。fixture 通过真实 workspace/session controller 创建临时会话，再写入带 id/source 的 `user/message` 和完整回合边界，进入实际会话界面；不调用模型、不创建未知事件。
- M3 根目录缺少显式 `@types/node`；已声明并由 pnpm 更新 lockfile。状态检查也补上裸路径/URL `.tgz` 仍为 junction 时的错误报告。
- L2 的构建新鲜度原来仅比较 `src/index.ts`，会漏掉其他模块和内联共享库的改动；现在检查插件全部 TS 源码和 bundle 的 workspace 源码。
- L4 的 HTTP 请求没有请求级超时，慢服务可能突破轮询截止时间；端口关闭检查还会把权限/超时等任意 fetch 失败误判成关闭。现在请求遵守截止时间，只有连接被拒绝才证明端口关闭。
- 子进程启动错误曾可能触发未处理的 `error` 事件，最终强杀失败还会被吞掉。现在保留明确错误，清理失败也让测试失败。
- L4 `--home` 原本接受任意已有目录，可能污染用户 profile；现在只接受仓库 `.tmp` 内全新的路径，并解析已有祖先的 symlink/junction 后检查边界。
- `scripts/src/core/web-harness.ts` 统一 L4/L5 的 CLI、pnpm shim、环境隔离、官方 profile 初始化、服务启动/退出/端口关闭。增加启动失败、HTTP 卡住和 home 拒绝的持久回归测试。

### 19.2 正式 L5

入口：`node scripts/bootstrap.mjs l5`，或 `pnpm test:e2e:web`（普通终端）。旧 `node test/e2e/web-l5.mjs` 为兼容薄壳，也转到新 harness，不再使用手工维护的 URL 文件或用户 GUI URL。

执行顺序：构建 → `tsc -p test/e2e/tsconfig.json` → 一次性 home → 官方 shipped `web` → 无自定义插件的浏览器基线 → 安装 fixture 与真实 `notify-web` → 重启测试服务 → 浏览器断言 → 退出/端口关闭。

五项浏览器检查：

1. 独立基线：处理预览/登录提示，确认宿主可交互、无自定义 fixture、无 console/pageerror。
2. slot/交互/主题/locale/刷新：真实会话中的 composer slot 只出现一次；输入中文/英文文本、点击按钮、断言 Host 返回递增计数；浅色/深色 × 中文/英文四组合截图；断言宿主主题 token 的实际颜色变化；等待 locale 的 Host 设置写入完成后刷新，确认 slot 没有重复注册。
3. 英文通知：真实 `approval/asked` 与 `turn/end` 经共享 Host 源和认证 SSE 到达真实 Client，断言标题、正文和 `approval/decided` 撤回。
4. 中文通知：同样的完整链路，断言中文标题/正文和撤回。
5. 拒绝权限：真实用户手势调用 stub 的权限请求并返回 denied；在超过默认审批延迟的观察期内，不创建 Notification，也不连接通知 SSE。

只用 `addInitScript` 替换操作系统 `Notification` API；不 mock HTTP/SSE，不提供账号/API Key，不调用模型。测试用已支持的 durable 事件触发 Host，fixture 端点仅存在于测试包中。它不验证系统 Toast 外观、窗口聚焦、多标签页接管或桌面重启；M6/Vitest 仍待真实 UI 组件需要时接入。

**已知宿主问题**：Windows 的 DSH `0.2.1-rc.2` 在选择会话后请求 `/open-in-app/icon/explorer`，返回 404。测试只对当前测试 origin 下这一精确路径、精确 404 console 文案、Windows 平台做例外，并单独写入 `known-host-errors.json`。其余 404、其他 console error 或 slot 崩溃仍失败。升级宿主后应复核并移除此例外。初次启动无凭据时还可能显示“无法创建默认工作区”提示；测试使用显式创建的临时 workspace。

### 19.3 运行、产物与 CI

**本地 CI 不需要提交或推送 GitHub**。已安装仓库依赖、默认 Node 版 dsh 和浏览器后，统一入口依次执行类型检查 → L1–L3（含构建/打包契约）→ L4 → L5，任一步失败立即停止并返回非零退出码：

```sh
node scripts/bootstrap.mjs ci
# 保留成功的完整临时 profile：
node scripts/bootstrap.mjs ci --keep
```

本机 Node 未加入 PATH 时，先加入 PATH 或使用 Node 可执行文件的绝对路径启动 bootstrap。当前普通终端只找到 Electron 版 dsh 时，显式传入已验证的默认 Node 版入口（路径随本机安装变化）：

```sh
node scripts/bootstrap.mjs ci --dsh-cli '<普通 Node 版 dsh 入口绝对路径>'
# 已配置可用的普通 Node 版 dsh 时：
node scripts/bootstrap.mjs ci
```

旧 `scripts/ci.ps1` 已移除，当前使用上述 Node CLI。下文旧命令仅为当时的验收记录。

汇总结果位于 `.tmp/ci/run-*/report.json` 与 `.tmp/ci/last-report.json`，记录平台、Node 版本、各阶段耗时和退出码；L4/L5 的详细现场继续由各自 harness 保存。该入口不执行 git 操作，也不上传产物。GitHub workflow 调用同一 `ci` 入口，避免两套检查漂移。

本地入口复用已安装依赖和系统 Chrome，不宣称是全新 runner 的冻结依赖安装验证；需要与远端浏览器一致时，按下方命令安装匹配的 Chromium 并设置 `DSH_E2E_BROWSER=chromium`。Windows 本机只能验收 Windows，macOS 仍需在 macOS 环境运行同一入口。当前按用户要求仅做本地验证与文档 commit，暂不推送或触发 GitHub。

本地使用系统 Chrome（或设置 `CHROME_PATH`）；CI 使用与 lockfile 中 `playwright-core` 匹配的 Chromium：

```sh
node node_modules/playwright-core/cli.js install chromium
# 设置 DSH_E2E_BROWSER=chromium 后：
node scripts/bootstrap.mjs l5
```

- Node 下限按本仓库测试工具链固定为 24；CI 安装 `pnpm@11.28.5`、`@deepseek-ai/dsh@0.2.1-rc.2`，并显式设置 `DSH_PNPM` 到该 pnpm 的 `bin/pnpm.cjs`。
- 优先 PATH 上的默认 Node 版 dsh。若 PATH 只有 Electron 桌面 wrapper，需设置 `DSH_CLI` 到 npm/pnpm 安装的 dsh；不能用 Electron 版伪装 Web surface。
- `.github/workflows/tests.yml` 在 main push、PR、手动运行时执行 Windows/macOS 矩阵：冻结 lockfile 安装、runner 配置初始化、Chromium 安装、类型检查、L1–L3、L4、L5。远端通过记录见 §19.7；这不包含系统原生通知或桌面 Electron 的人工验收。
- L5 每次生成 `.tmp/l5/run-*/`，保存 `report.json`、服务/浏览器日志、每项检查的 screenshot/trace/错误列表与 `results.json`；`.tmp/l5/last-report.json` 指向最近结果。
- 成功默认清理临时 profile、pnpm store、shim，保留浏览器证据；`--keep` 额外保留完整成功现场。失败保留全部现场。浏览器套件截止时间现由 `test.timeoutMs` / `--timeout` 控制，父进程另留 30 秒退出宽限。
- 原始日志和 trace 可能含临时认证信息，仅留在本地或临时 CI runner，不配置 GitHub artifact 上传；控制台中的启动 token 会脱敏。自动审批审核曾因此拒绝上传配置，已采用不上传的替代方案。
- [Playwright 官方 CI 文档](https://playwright.dev/docs/ci)用于核对浏览器安装、串行执行和超时；[BrowserContext 文档](https://playwright.dev/docs/api/class-browsercontext)用于隔离 context 与 `addInitScript`。

### 19.4 验收记录

- Windows / Node `24.21.0` / npm dsh `0.2.1-rc.2` / 系统 Chrome。
- 统一本地 CI 入口 `scripts/ci.ps1 -DshCli ...` 已实跑通过：type-check、l1-l3、l4、l5 四阶段全部退出 0；本轮未提交或推送 GitHub。
- L1–L3：201 tests、37 suites，全部通过；四个正式插件真实 tarball 契约均覆盖。
- 完整 L4：前置检查与七个阶段全部通过，含真实 SSE 认证、目标不匹配、tarball 实体拷贝，以及三次服务端口关闭。
- 正式 L5：独立基线和上述四项 fixture 检查均通过；light/dark × en/zh 截图已检查，未发现 slot crash。
- 沙箱内访问本机 socket 受限；真实 L4/L5 在获准的沙箱外运行，仍使用仓库内一次性 home。
- GitHub Actions 远端首次运行、macOS 真机和系统通知显示仍未验证；不修改用户 desktop/web profile，不提交构建产物。

### 19.5 M5 与本地 CI 继续复核（2026-10-28）

本轮保留工作区已有实现，修复测试自身的竞态与报告缺口：

- **会话准备竞态**：新的浏览器上下文会恢复上一次选择的会话，其 slot 可能在新 workspace/session 创建完成前已经可见。原先启动异步准备后只等 DOM，会提前通过；现在等待 `openWorkspace()` 完成并检查新 `sessionId`，再验证 slot。
- **刷新与权限断言不足**：刷新后除检查单个 slot 外，还验证英文文案、真实 Host 回声和递增计数。权限 stub 记录 `navigator.userActivation.isActive`，要求权限请求发生于用户手势；拒绝权限后同时触发审批和完成事件，确认无 SSE、无通知。
- **L5 失败报告不完整**：构建、浏览器编译、CLI 定位原本在报告保护范围外，失败会留下上一次的汇总。现在这些阶段也生成本次失败报告；重目录清理纳入成功条件，清理失败不会写 `ok=true`。浏览器启动或 context 准备失败也会写入 `results.json`。
- **浏览器完成性门禁**：父 harness 原本只检查子进程退出码；现在还读取 `results.json`，要求基线一项、fixture 四项全部成功，缺项、重复或失败结果均拒绝通过。
- **本地 CI 失败路径回归**：新增 `verification-reports.test.ts`，在隔离的临时仓库中使用真实 CI/L5 编排与模拟阶段，覆盖非零退出、异常、后续阶段不得启动、选项传递、报告脱敏、L5 早期/清理失败及浏览器结果缺失。不会覆盖真实运行的 `last-report.json`。

本轮验证：

- `build.ps1 -Check` 与浏览器 TypeScript 编译通过；L1–L3 **210 tests / 37 suites / 210 pass / 0 fail**，新增 9 个回归用例。
- `scripts/ci.ps1 -DshCli <npm dsh>` 完整实跑通过，四阶段退出码均为 0；报告：`.tmp/ci/run-W3wdCN/report.json`。
- 完整 L4 八项记录（前置检查及七阶段）通过；L5 基线及四项 fixture 检查通过，证据：`.tmp/l5/run-Bb7Ulu/`。五份非预期浏览器错误列表均为空，已查看 light/en 与 dark/zh 截图；已知宿主 Explorer 图标 404 例外继续单独记录。
- 单独用不存在的 `CHROME_PATH` 检查启动失败：退出 1，生成 `browser-start` 失败结果，不需要启动服务或浏览器。
- 仍仅验收 Windows / Node `24.21.0` / npm dsh `0.2.1-rc.2` / 系统 Chrome；远端 CI、macOS 真机及操作系统通知外观未验证。本轮未提交、推送或上传产物。

### 19.6 本机配置第二阶段（2026-10-30）

首次运行前先安装 workspace 依赖，再执行 `config init`。构建、打包、安装、状态和测试共用 `core/command-context.ts`；PowerShell 入口只负责 Node 启动与参数转发。`DSH_CLI` / `DSH_PNPM` / `DSH_E2E_BROWSER` / `CHROME_PATH` 继续兼容，优先级低于命令行、高于本机 JSON；详见 [配置方案 §12](local-configuration-design.md#12-第二阶段实现与使用)。

L4/L5 从本机 JSON 取工具和测试参数，始终使用一次性 home/profile、测试 patch 和 pnpm store。`test.timeoutMs` 控制外部操作与浏览器场景的截止时间；不读取个人 Web YAML。CI 在 runner 内通过 example 初始化，不依赖开发者的本机配置。

此阶段 Windows 类型检查及 249 项 L1–L3 通过；完整 L4、L5 分别通过。另用新安装入口在同一临时 profile 验证 link → tarball → link，确认 spec 与实际链接状态匹配、本机配置字节不变，测试 home/store 清理完成。L5 证据位于 `.tmp/l5/run-2owMgf/`，安装切换报告位于 `.tmp/phase2-switch-At2HTV/report.json`，均不入库。当时尚未确认远端通过；后续修复及远端结果见 §19.7。

### 19.7 远端 CI 验收（2026-10-30）

验收基线为提交 [`d9f2a1253150a147ecd11d533fb333cc3f2cd2f0`](https://github.com/mbda9091/dsh-plugin/commit/d9f2a1253150a147ecd11d533fb333cc3f2cd2f0)，由 push 触发 [Plugin tests / run 41061844806](https://github.com/mbda9091/dsh-plugin/actions/runs/41061844806)。GitHub Actions API 确认整次运行和两个 job 均为 `completed / success`，整体完成时间为 2026-10-30 21:28:15（Asia/Shanghai）。

| 平台 | Job | 结果 | 完成时间（Asia/Shanghai） |
|---|---|---|---|
| `windows-latest` | [124083255245](https://github.com/mbda9091/dsh-plugin/actions/runs/41061844806/job/124083255245) | success | 2026-10-30 21:28:15 |
| `macos-latest` | [124083255709](https://github.com/mbda9091/dsh-plugin/actions/runs/41061844806/job/124083255709) | success | 2026-10-30 21:19:00 |

两个 job 均完成：Node 24 与固定 pnpm/DSH 工具链安装、`pnpm install --frozen-lockfile`、从 example 初始化 runner 本机配置、Playwright Chromium 安装，以及 `node scripts/bootstrap.mjs ci --keep`。该入口按顺序运行类型检查 → L1–L3 → L4 → L5，任一步失败都会返回非零退出码。

远端验收前修复了三个可复现问题：

- `68e6988`：pnpm 11 因未审批 esbuild 安装脚本而失败；在 workspace 的 `allowBuilds` 中只允许 esbuild。全新源码副本冻结安装、类型检查与构建通过，lockfile 未改变。
- `1ad66a3`：macOS 上模拟 Windows shim 时，反斜杠路径未按 `.cmd` 语义展开；统一路径分隔符并保留字面 `$` 字符，覆盖两种目录变量和启动器。本机 251 项 L1–L3、真实 L4 通过。
- `d9f2a12`：Windows runner 的 GNU tar 将 `D:` 误认成远程主机；解包改在压缩包目录执行，只传相对文件名。本机 GNU tar、BSD tar 各自的 48 项 L2 均通过，随后两个平台远端 CI 全部通过。

验收范围和保留边界：

- 已覆盖：runner 配置初始化、插件构建及真实 tarball 契约、隔离 profile 的 DSH 安装/加载/目标守卫、HTTP/SSE、Chromium 基线与 slot/主题/locale/通知逻辑。
- L5 替换操作系统 Notification API，因此不证明原生授权弹窗、系统通知外观、真实窗口聚焦或桌面 `/restart`。Windows 专属测试在 macOS 按条件跳过，不把 job 成功当成所有平台专属行为都已执行。
- macOS 的普通 Node DSH Web 与 Chromium 已有真实 runner 证据；日常 `start.ps1` / 系统默认浏览器和桌面 Electron 的使用体验不由此覆盖。
- 本次沿用不上传原始日志、截图、trace 的策略；工作流成功是指定提交的证据，后续提交需重新通过各自的检查。

## 20. 当前未完成事项

基础构建、配置第一/二阶段、L1–L5 已完成。P0 已移除 PowerShell 入口，并通过 Windows 独立验收及迁移提交的 Windows/macOS 远端 CI（§7.5）。以下区分待实现、按需建设和验收边界。

| 事项 | 当前状态与下一步 | 依据 |
|---|---|---|
| TS 脚本收尾与 PS 退场 | **已完成**：Node/TS 主入口、帮助/文档/调用方迁移，移除 PS 入口；Windows 本机 252 项测试与真实 L4/L5 通过，迁移提交 `ab745e9` 的 Windows/macOS CI 均通过 | 本文 §7.5、[本机配置方案 §14.10](local-configuration-design.md#1410-powershell-兼容层移除计划) |
| 环境统一与开发隔离 | **M1/M2 已实现，M3–M6 待实施**：M1 双平台配置 fast 通过、功能 CI 准备失败；M2 Windows 已复验，远端 CI 待执行。补当前基线的两平台 fast/real/功能证据后推进持久开发环境 | [开发环境方案 §9.5](development-environment-plan.md#95-m1m2-提交后-ci-核查与-windows-复验2026-10-31) |
| 本机配置第三阶段 | **维护机制已设计，尚未实现**：保留字段归属、预览、备份、repair/migrate 与故障恢复设计，按 P1 的新配置职责调整字段与迁移；不作为 TS 收尾前置。当前新增命令不可用 | [本机配置方案 §14](local-configuration-design.md#14-第三阶段具体设计修复与格式升级) |
| M6 / UI 组件测试 | **条件性待建设**：首个真实 React/JSX UI 组件需要时，引入 `src/client.tsx` 构建和 Vitest 组件测试，并复用现有 Playwright L5；不为了完成里程碑而新增插件或迁移全部 Host 测试 | 本文 §8、§10 |
| 插件场景 UI 徽章/页面 | **可选、暂不实施**：场景元数据、目录、安装过滤、运行时守卫已完成；将来有展示需求时再做插件管理器伴生 UI | [插件场景方案](plugin-targets.md) 阶段 3 |
| 原生通知与日常使用验收 | **待补人工证据**：独立 Chrome/Edge、macOS 的原生权限弹窗、系统通知、点击聚焦/切会话及多标签页接管；加载即申请权限改动后的原生流程也需复验。已有 Windows Codex 内嵌浏览器证据保持有效，但不推广到其他环境 | [通知方案 §11.11–§11.15](notification-host-design.md#1111-原生浏览器通知验收2026-10-28asiashanghai) |
| 桌面端 L5 与更深的恢复场景 | **当前延期/未覆盖**：Electron 壳、真实重启、Toast/声音不进现有 Web CI；Host 重启后跨进程恢复待审批、后台冻结/勿扰等场景需要另定需求和验收方案，不能因 CI 通过而视为已覆盖 | 本文 §2、§4、§18；通知方案 §11.11 |

P0 与环境 M1/M2 实现已完成；下一步补 M2 两平台 CI 证据，再按独立开发环境方案推进 M3–M6（对应 P1–P4 的后续部分），各阶段分别验收。其余按真实 UI 或使用场景需求安排；`headless` / Linux 当前是保留场景，两个桌面插件不适配 Web 是明确选择，不计为本轮未完成建设。
