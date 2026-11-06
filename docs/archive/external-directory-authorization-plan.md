# 工作区外写入审批方案（已废弃）

> 状态：已废弃。
> 废弃日期：2026-11-06。
> 原因与决定来源：用户在本会话明确决定，方案过于复杂且不好用，不再采用或维护。
> 历史完成范围：M1–M3 曾实现并记录 Web/macOS 宿主集成验证；M4 批次结果依赖当时任务根验收材料，本次未回读，不补记整篇完成。
> commit 对账：历史建设提交 `50969e3`，完整正文取自本机 Git 对象 `10e42df0ac08360cc6d31177795d40dd33b30639`；二者不属于当前 HEAD 祖先，不能当作当前实现。当前主分支 `be2043ef973eb78d0d79c613c1f97a3e92a9ef16` 已删除插件；本次废弃决定仅更新文档，无新增代码提交。
> 当前行动：停止本方案所有剩余实施、适配和验收；不恢复 approval-allowlist。保留历史结果，不把废弃等同于建设失败。归档：已归档，2026-11-06；见[归档索引](README.md)。

本次不卸载用户已有 profile 中的插件，不删除授权文件或个人配置。沙箱目录扩展是不同机制，但用户也已独立决定废弃，见[该方案](sandbox-directory-extension-plan.md)。

## 历史方案与实施记录

以下完整保留历史正文，所有“下一步”“待办”和示例仅用于追溯，均已于上述日期关闭为“不再实施（已废弃）”，不得据此继续开发。此前扫描所述“历史正文位置待核实”现已更正：已从上述 Git 对象恢复；不因此声称原始运行报告已重新核验。

# 工作区外写入审批补充方案与迭代记录（v0.4）

> 状态：M1–M3 已实现；M4 macOS + Web 文档/示例/固定包验证入口已完成，具体批次验收以任务根的 `external-directory-authorization-m4-acceptance.md` 为准；其他平台延期 M5。
> 更新日期：2026-11-03（Asia/Shanghai）。
> 当前结论：已实现 profile 内授权文件、project/permanent 精确规则、即时重读、持久次数、独立审批的管理工具及默认脱敏审计。不修改 DSH 内部协议/UI，不支持 session；一次性批准仍由原沙箱执行。真实 Web/macOS 探针已通过，包含工具执行、审批对、provider denial、持久回读和默认清理，未用类型检查替代真实证据。
> 验收基线：本 worktree 未提交改动，workspace DSH 0.2.1-rc.2、Node 24.16.0、macOS。单测/真实探针结果见第 8、9.2 节；不涉及日常 profile 或当前 3080 服务。
> 关联文档：[方案与迭代记录模板](../plan-template.md)、[测试与 Web L5 方案](../testing-plan.md)、[dsh 插件开发：概念、安装与配置](../dsh-concepts.md)。

## 1. 结论摘要

- **要解决的问题**：当前沙箱已经允许部分工作区外访问；当写入操作需要扩大沙箱权限时，DSH 会通过审批链询问用户。重复批准可信操作影响使用效率。
- **采用的方案**：B3 提供 profile 内授权文件中的预授权规则，B2 提供用户直接编辑/维护授权文件及运行时管理工具的方式；只支持 `project` 和 `permanent`，插件在 `approval/request` 层按路径和作用域匹配，命中后统一返回现有 `allowed-once`，不新增 read 权限控制，也不向沙箱注入目录白名单。
- **可行性结论**：只要真实审批请求能通过 `callId` 关联到包含规范化目标路径的工具调用信息，B2+B3 对文件审批可行；若路径只存在于未暴露的 UI/内部 payload，插件无法安全实现路径加白，只能退回已有的工具参数精确匹配。
- **目录信息结论**：审批请求 `ApprovalRequestEvent` 只有 `toolName`、`callId`、`reason` 等字段，没有独立的目录字段；对应 `tool/call` 事件可以取得原始参数。bash 参数包含 `command`、`workdir` 和沙箱升级参数，但不包含命令运行后实际写入的文件列表。
- **本轮边界**：实现 M1–M3 的审批补充，不限制读取，不支持 session/UI/任意目录全局放行。宿主集成测试用 synthetic assistant 广告和 driver tool/call，执行真实工具、审批、沙箱及持久回读；不宣称真实 LLM/人工点击端到端。
- **当前接口**：write/edit 为 `file_path`；bash 为 `command`、`workdir`；沙箱参数为 `sandbox_permissions`；project identity 为不可变 `agent.session.header.cwd`；默认文件根为宿主 `profileContext.dir`。配置已冻结，详见 §4.3 和插件 README。
- **下一步**：M4 收尾仅针对 macOS + Web 文档/示例和固定包；其他平台明确延期 M5。本轮固定包仅在隔离 home 验证，不安装日常环境。

## 2. 范围

### 2.1 目标

- G1：用户可以为可信的外部写入工具调用配置精确审批加白，命中后不再重复人工批准。
- G2：沿用 DSH 沙箱现有读写边界；插件只改变审批结果，不改变沙箱是否允许该操作。
- G3：不对外部读取新增限制。外部读取继续由现有沙箱、工具和操作系统权限决定。
- G4：规则支持 `project` 和 `permanent` 作用域，可限制工具、原始参数、工作目录、沙箱升级模式、次数和有效期，并写入审计日志。
- G5：运行时可以通过受保护的插件管理工具增加、撤销和查看授权；规则变更立即影响当前进程，无需修改 patch 或重启 DSH。
- G6：未命中、参数不完整、无法解析或非精确场景继续走原审批流程，失败保持 fail-closed。

### 2.2 非目标与延期项

| 事项 | 本轮处理 | 原因或后续触发条件 |
|---|---|---|
| 新增外部目录 read 权限模型 | 明确不做 | 当前沙箱已有外部读取能力，本插件不应在其上再加一层读取限制 |
| 新增外部目录 write 权限模型 | 明确不做 | 沙箱已有写入判定；需求是免除重复审批，不是授予新的写权限 |
| 按实际访问目录的通用授权 | 暂不支持 | 审批请求没有目录清单；任意 bash 的实际访问路径无法由插件可靠推断 |
| 外部程序执行授权 | 明确不做 | 不是当前需求，且会扩大权限风险 |
| 任意 bash 命令通配放行 | 明确不做 | `command` 仅是字符串，通配会把审批权限扩大为任意命令执行 |
| session 作用域 | 明确不做 | 当前只需要 project/permanent；避免引入进程内临时授权生命周期 |
| 审批 UI 扩展、插件设置页 | 明确不做 | 采用 B2+B3，用户直接维护 profile 授权文件并使用管理工具；保持插件可插拔且不依赖 DSH UI 扩展点 |

### 2.3 适用场景与协作边界

- 适用对象：DSH 的文件审批请求，以及能够从 `callId` 关联到目标路径的 `write`、`edit` 等结构化变更工具；bash 仅在真实请求提供可安全匹配的路径或完整命令字段时纳入规则。
- 环境范围：当前仅支持 **Web + macOS**，manifest/locale/守卫与此一致。Windows 及所有 Desktop 组合延期到 M5，届时分别适配和验收后才扩展声明。
- 与其他能力的分工：DSH 沙箱负责实际路径和文件系统访问边界；`approval-allowlist` 负责判断一次审批请求是否自动通过；操作系统负责最终用户权限。
- 完成定义：命中精确规则的审批请求自动获得一次性批准，并仍由原沙箱执行；未命中规则和无法确认目标的请求继续审批或拒绝；外部读取行为不被插件改变。

## 3. 现状与问题

| 对象 | 当前行为或已有能力 | 问题与影响 | 依据 |
|---|---|---|---|
| 审批请求类型 | `ApprovalRequestEvent` 暴露 `toolName`、可选 `callId`、`reason`、展示文案和信号，没有目录/目标路径字段 | 插件不能直接从审批请求读取“实际写入了哪些目录” | DSH `@deepseek-ai/dsh-user-approval` 0.2.1-rc.3 `lib/types/types.d.ts` |
| 持久工具调用 | 插件可用 `callId` 回查 `tool/call`，取得工具名和 JSON 原始参数 | 可匹配参数中显式出现的路径、命令、工作目录和沙箱模式；不能由此推断脚本内部的最终文件访问 | `approval-allowlist/src/index.ts`、`src/rules.ts` |
| bash 沙箱升级 | bash 在执行前从参数读取 `sandbox_permissions`/`justification`，调用 `approveEscalation`；审批请求只绑定 `toolName: bash`、`callId`、`reason: justification` | 审批时知道“这次 bash 请求扩大模式”，但不知道命令运行后实际会写哪些路径 | DSH `@deepseek-ai/dsh-tool-bash` 0.2.1-rc.3 `lib/index.js`；`dsh-sandbox` `lib/types/escalation.d.ts` |
| fs 写入/编辑 | `write`/`edit` 共享 `FsSandboxController`，参数包含升级字段，目标文件路径由工具参数提供；升级在实际 mutation 前审批 | 对结构化操作可以同时匹配工具、目标路径和升级模式，适合本插件的精确加白 | DSH `@deepseek-ai/dsh-tool-fs` 0.2.1-rc.3 `lib/types/sandbox.d.ts`、`lib/index.js` |
| 现有插件 | `mode: allow` 命中规则时返回 `allowed-once`，支持参数子集、`maxUses`、`expiresAt`、审计 | 已具备主要审批层能力，但应补充对升级字段/目标路径的使用说明和测试 | `approval-allowlist/src/index.ts`、`README.md` |

- 已有可复用能力：审批 waterfall、`callId` 回查、原始 JSON 参数子集匹配、一次性 `allowed-once`、次数限制、过期和 JSONL 审计。
- 已确认约束：`approval/request` 的 `reason` 不是可靠的目录事实；不能仅靠 reason 文本匹配；命令加白不会改变沙箱执行策略；沙箱升级本身仍要求一次审批结果。
- 已确认事实：当前 DSH 自带沙箱 API 的升级请求是“按调用一次性扩大模式”，不是“按目录授权”；其 `EscalationRequest` 只有 requested mode、justification、effective mode 和 subject。

## 4. 具体方案

### 4.1 总体设计与职责

采用“B2 配置维护 + profile 授权文件 + 运行时管理工具 + B3 预授权匹配 + 原沙箱执行”的模型：

```text
profile cordis.patch.yml（只负责启用插件和基础配置）
  ↓
profile/approval-allowlist/grants.json（B2：用户可直接维护）
  ↕
approval_allow / approval_revoke / approval_list（运行时管理）
  ↓
插件加载 project/permanent 规则（B3）
  ↓
沙箱触发审批，插件用 callId 回查 tool/call 与路径信息
  ├─ 规则命中且作用域匹配：返回现有 allowed-once
  └─ 未命中/信息不足：next()，继续原审批链
  ↓
DSH 原有 sandbox policy 继续执行实际访问控制
```

关键语义：B2 是授权文件和管理工具的人工维护入口，B3 是实时规则匹配能力；不支持 `session`，不需要 UI，也不改变 DSH 审批结果类型。`allowed-once` 只表示本次审批请求通过，不把工作区外目录加入新的沙箱白名单。

| 部分 | 职责 | 输入与输出 | 本轮改动 |
|---|---|---|---|
| DSH sandbox | 判断工作区外操作是否需要升级、实际执行并拒绝越界访问 | 工具调用、沙箱 policy、实际文件/进程行为 | 复用，不修改 |
| `write`/`edit` 工具 | 提供结构化目标路径，并在 mutation 前发起升级审批 | 文件路径、内容/编辑参数、升级字段 | 复用；file_path 单目标契约已确认 |
| `bash` 工具 | 提供 command、workdir、升级模式，在进程执行前发起审批 | command、workdir、sandbox_permissions、justification | 复用；只支持精确规则 |
| `approval-allowlist` | 根据 `callId`、路径信息和 project/permanent 作用域做自动审批决策 | 授权文件、审批请求、工具调用、当前项目身份 | 已有审批基础；已扩展规则模型、持久化和作用域匹配 |
| 授权文件 | 保存 project/permanent 规则，支持运行时增删改查 | `<profile>/approval-allowlist/grants.json` | 已实现；原子写入，校验失败暂停自动授权 |
| 管理工具 | 运行时增加、撤销、查看授权规则，不依赖 UI | 工具参数；输出操作结果 | 已实现；root agent、独立审批和卸载取消，避免自授权链路 |
| 审计日志 | 记录规则命中、工具、callId、原始参数和结果 | JSONL | 已有；注意原始参数可能包含敏感信息 |

### 4.2 关键行为与异常路径

1. profile 的 `cordis.patch.yml` 只负责启用插件和基础配置；B2 授权文件位于 profile 内，用户可直接编辑，B3 在插件加载时校验并建立索引。
2. 运行时通过受保护的管理工具增加、撤销或查看 `project`/`permanent` 规则；变更成功后立即替换内存索引，并原子写回授权文件。
3. 工具按 DSH 原有逻辑确定 standing sandbox policy；工作区外写入需要升级时，工具携带 `sandbox_permissions` 和 `justification` 发起审批。
4. 审批服务将请求写入 `approval/asked`，并把 `toolName`、`callId`、`reason` 传给 waterfall；其中 `reason` 对 bash 通常是 justification，不是目录清单。
5. 插件通过 `callId` 回查同一会话中的 `tool/call`，解析原始参数，并取得当前 project identity；规则只匹配真实存在的显式字段。
6. 结构化 `write`/`edit`：匹配规范化目标文件路径、工具名和必要的沙箱参数；`project` 要求 project identity 匹配，`permanent` 不做项目作用域限制。
7. `bash`：只有真实请求能安全提供目标路径，或用户配置了完整精确命令时才允许加白；不能声明“允许该命令写入目录 X”并据此覆盖脚本内部任意访问。
8. 命中规则返回 `allowed-once`，由原 `approveEscalation` 继续得到一次调用级 sandbox mode；未命中调用 `next()`，保留原审批。
9. 任何无 `callId`、找不到 `tool/call`、JSON 无法解析、规则不完整、超出次数或过期的请求都不自动放行。
10. 沙箱仍可在审批通过后因实际路径、系统权限或 provider 策略拒绝；该失败不能被插件改写为成功。

### 4.3 接口、配置与使用方式

B2 已实现：宿主 `profileContext.dir` 下的 `approval-allowlist/grants.json`，可通过 `grantsFile` 覆盖到同 profile 内的路径，不从环境或 cwd 推断。每次审批/管理重新读取；未知字段、重复 id 或非法规则拒绝整份文件。管理工具使用同一文件、排他锁和原子 rename；有限次数先持久化 `used` 再返回批准。完整当前契约见 插件 README（历史路径 `approval-allowlist/README.md`，见 Git 快照 `10e42df0ac08360cc6d31177795d40dd33b30639`；当前文件已删除）。以下示例可配置，但未安装到日常环境：

```yaml
- id: approval-allowlist
  config:
    mode: allow
    rootOnly: true
    grantsFile: ./approval-allowlist/grants.json
    log: true
```

`<profile>/approval-allowlist/grants.json`：

```json
{
  "version": 1,
  "rules": [
    {
      "id": "project-result",
      "scope": "project",
      "projectRoot": "/Users/me/project-a",
      "tool": "write",
      "path": "/Users/me/shared-data/project-result.json",
      "arguments": {
        "file_path": "/Users/me/shared-data/project-result.json",
        "sandbox_permissions": "workspace-write"
      },
      "note": "allow this project to write the external result"
    },
    {
      "id": "exact-export",
      "scope": "permanent",
      "tool": "bash",
      "arguments": {
        "command": "node scripts/export.mjs --output /Users/me/shared-data/out.json",
        "workdir": "/Users/me/project-a",
        "sandbox_permissions": "workspace-write"
      },
      "maxUses": 1,
      "note": "allow one exact export command"
    }
  ]
}
```

运行时管理工具已提供：

```text
approval_allow({"rule":"完整规则 JSON 字符串，不含 id/used"})
approval_revoke({"id":"规则 id"})
approval_list({})
```

只允许活跃 root agent；新增/撤销必须独立通过原 ApprovalService，插件永远不自动批准自身管理工具；取消、卸载、服务缺失或拒绝不写盘。`projectRoot` 必须等于调用 session 原始 cwd。

`path` 是插件规则字段，不是工具参数；write/edit 必须同时固定 `arguments.file_path` 且与 path 原串一致。拒绝相对/dot-segment/Windows root-relative 路径；结构化目标不得落入当前 profile。bash 固定完整 command/workdir/sandbox mode，不解析脚本内部实际访问。

不提供以下配置语义：

```yaml
# 不支持：这不是现有插件或 DSH 能可靠执行的语义
externalDirectories:
  - path: /Users/me/shared-data
    allowAllWrites: true
```

原因是当前审批层没有实际文件访问清单，无法证明任意命令只会写入这个目录。

### 4.4 兼容、迁移与回退

- 兼容影响：未配置 `mode: allow` 或没有匹配规则时，现有审批行为不变；外部读取不受影响。
- 迁移顺序：先以 `observe` 记录真实 `tool/call` 参数和审批请求，再在 profile 内创建合法的 `grants.json`，为一个结构化写操作配置 `project` 或 `permanent` 规则，确认后逐步扩展。
- 回退方式：将插件切回 `observe`、撤销管理工具生成的规则或移除 `grants.json` 中的匹配项；所有请求回到原审批链，不需要修改沙箱配置。
- 隔离与清理：授权文件放在用户 profile 内，不写入 bundle；写入采用临时文件 + 原子替换，解析失败保留上一份有效索引仅供诊断，但暂停自动授权，不能沿用旧授权；测试使用临时目录和一次性 home，避免影响真实 profile、会话和工作区。
- 安全边界：插件不得把 `reason` 当作目录事实，不得使用空对象/宽通配规则，不得承诺对任意 bash 内部写入提供目录级保证。

### 4.5 验证设计

M1–M3 已进入实现与验证；以下验收项保留为出口条件，结果和覆盖边界见第 8、9.2 节：

| 验收项 | 对应目标 | 场景与预期行为 | 验证方式 | 覆盖边界 |
|---|---|---|---|---|
| A1 | G1/G2 | profile 内 `project` 规则命中后返回 `allowed-once`；其他项目不命中 | 真实 DSH Web/macOS + 工具事件/审批日志 | 依赖稳定 project identity |
| A2 | G1/G2 | `permanent` 规则跨项目/会话命中；撤销后立即失效 | 真实工具调用 + 运行时管理工具 | 不证明任意 bash 的内部路径 |
| A3 | G5 | 管理工具新增、撤销、列出规则，当前进程立即生效并持久化到 profile 文件 | 管理工具集成测试 | 需验证 root agent 限制和原子写入 |
| A4 | G6 | 无 callId、无 tool/call、参数 JSON 错误、过期和超次数均继续原审批 | 单元测试 + 审批联调 | 不证明底层沙箱 provider |
| A5 | G1/G6 | 精确 bash 命令可放行；同命令改动参数、workdir 或升级模式不命中 | 真实 bash 工具调用 | 不证明脚本内部实际写入路径 |
| A6 | G2/G3 | 审批自动通过后，未授权的实际路径仍由沙箱拒绝；插件不改变 sandbox denial | 真实临时目录对照实验 | 需要可触发真实 provider 拒绝 |
| A7 | G4 | 审计记录工具、参数、callId、决策和原因，不泄露不必要内容 | 日志断言与人工检查 | 原始参数可能含敏感信息，需确定脱敏策略 |

## 5. 里程碑

| 阶段 | 交付内容 | 前置依赖 | 出口条件 | 当前状态与证据 |
|---|---|---|---|---|
| M1 | observe 采集 write/edit/bash 和身份 | 一次性真实 DSH Web/macOS | 明确目标路径、workdir、sandbox 字段和项目身份 | 宿主集成字段已确认；synthetic 调用广告、真实工具与持久回读，非 LLM E2E；§9.2 |
| M2 | profile 授权文件、project/permanent 与实时管理 | M1 字段确认 | A1–A5；默认 observe；非法文件 fail-closed | 已实现；L1–L3 回归通过；独立审批管理成功路径为集成模拟，非人工点击；§9.2 |
| M3 | 真实沙箱联调与回退 | M2；隔离 home/目录 | A6–A7；不改 standing policy | 真实 fs/b​​ash + 审批 + provider denial 已通过；最终清理复验见 §9.2 |
| M4 | macOS + Web 文档、可随包分发示例、迁移/回退和固定 tarball 验收 | M3 | targets、README、locale一致；固定包安装/字节/真实能力通过，报告绑定哈希 | 实现完成；批次验收状态见 §9.3 指定的任务根持久记录 |
| M5 | Windows 与 Desktop 适配和各平台验收 | 用户再次启动；对应执行链路可用 | 分别声明/验证平台、路径和sandbox差异后才扩展targets | 延期；当前不支持、不安装、不认领通过 |

## 6. 决策记录

| ID | 决策与理由 | 考虑过的替代方案 | 日期 | 状态与关联 |
|---|---|---|---|---|
| D1 | 本插件只补充外部写入审批免除，不重做 read/write 权限模型；因为当前沙箱已经承担访问边界 | 增加外部目录 read/write grant；会重复实现并改变现有沙箱语义 | 2026-11-03 | 已定；§1、§2 |
| D2 | 审批加白按 tool/call 原始参数精确匹配，不按 reason 文本或“实际目录”推断 | 让插件解析任意 shell 命令；无法可靠覆盖脚本、重定向和子进程行为 | 2026-11-03 | 已定；§3、§4 |
| D3 | 采用 B2+B3：用户直接维护 profile 内授权文件，插件通过运行时管理工具增删规则并预先匹配；不做插件设置页或审批 UI 改造 | B1 审批现场增加授权按钮；当前没有稳定的可插拔审批动作扩展点 | 2026-11-03 | 已定；§1、§4.1 |
| D4 | 作用域只支持 `project`、`permanent`；当前审批统一返回已有 `allowed-once` | 支持 `session`；会引入额外的临时授权生命周期，但不是当前需求 | 2026-11-03 | 已定；§2.2、§4.2、§4.3 |
| D5 | 审批通过后仍由原 sandbox policy 执行，不修改底层权限 | 插件直接扩展 sandbox 允许目录 | 2026-11-03 | 已定；§4.1 |

## 7. 风险与开放问题

### 7.1 风险

| ID | 风险与触发条件 | 影响 | 应对与验证办法 | 当前状态 |
|---|---|---|---|---|
| R1 | bash 命令内部实际写入路径与参数不可见 | 目录级授权承诺不成立 | 只提供精确命令加白；结构化工具优先；在文档中明确边界 | 已确认；不可通过当前审批字段消除 |
| R2 | `write`/`edit` 参数契约漂移 | 规则示例可能无法命中 | 以真实 schema/宿主 probe 作为版本升级门禁 | 已缓解；当前版本确认 `file_path` 单目标，后续升级需复验 |
| R3 | `reason`/justification 被伪造或过于宽泛 | 误放行 | 永不单独匹配 reason；必须匹配 callId 对应的原始参数 | 已缓解；现有插件已遵循 |
| R4 | 精确规则包含敏感路径或参数 | 审计日志泄露信息 | 配置只由可信用户维护；默认 keys/hash 脱敏已实现；原始参数仅显式 opt-in | 已缓解；探针单独隔离原始日志 |
| R5 | 审批通过但沙箱仍拒绝实际路径 | 用户误以为插件授予了写权限 | README 和验收明确“只改变审批结果”；保留真实 sandbox denial 测试 | 已确认边界 |

### 7.2 开放问题

| ID | 尚待回答的问题 | 影响的决定或阶段 | 解决方式与时点 | 当前结论 |
|---|---|---|---|---|
| Q1 | write/edit 目标字段 | M1/M2 | 真实 schema、工具执行与持久回读 | 已解决：JSON arguments.file_path，单一目标；§9.2 |
| Q2 | 审批来源 | M1/M3 | ApprovalService 与工具结果 | 已解决：sandbox escalation；reason 为 `escalate sandbox to <mode>: <justification>`，不拿它匹配路径 |
| Q3 | allowed-once 是否足够 | M3 | 真实执行对照 | 已解决：可完成单次升级，standing policy 不变；真实外部文件写入通过 |
| Q4 | 工作目录字段 | M1/M2 | schema与session header | 已解决：bash参数workdir；项目身份session.header.cwd |
| Q5 | 多目标操作 | M2 | 原生write/edit schema | 当前只支持单目标write/edit；其他工具与PTC不自动授予 |
| Q6 | 默认路径 | M2 | 宿主ProfileContext | 已解决：profileContext.dir/approval-allowlist/grants.json，只允许同profile内覆盖；无身份则禁用 |

## 8. 验收状态

> 截至：2026-11-03。验收对象：本 worktree 未提交源码构建，不是生产固定 tarball。
> 环境：macOS / Web，workspace DSH 0.2.1-rc.2、Node v24.16.0；测试独立 home/随机端口。真实宿主集成不包含 LLM 推理或人工 UI 点击。

| 验收项 | 实现状态 | 验收结果 | 证据与日期 | 尚未覆盖或失败原因 |
|---|---|---|---|---|
| A1：结构化外部写入精确放行 | 已实现 | 宿主集成通过 | write/edit 真实外部 fixture 变更与 allowed-once；§9.2 | 非 LLM E2E |
| A2：project/permanent 作用域与撤销 | 已实现 | L3/宿主集成通过 | 即时文件撤销、跨项目、持久次数；§9.2 | 直接人工编辑与工具并发不保证合并 |
| A3：运行时管理工具与 profile 授权文件 | 已实现 | L3 通过 | 增/撤/查、独立审批拒绝、root、卸载取消；§9.2 | 真实人工批准点击未执行 |
| A4：失败保持原审批 | 已实现 | 回归通过 | 无 callId/坏参数/坏文件/锁冲突/过期/超次数 | Windows 原生未执行 |
| A5：精确 bash 放行 | 已实现 | 真实 bash 通过 | command/workdir/sandbox 固定匹配；§9.2 | 不推断脚本内部路径 |
| A6：沙箱仍负责实际拒绝 | 已实现 | 真实 provider 通过 | allowed-once 后 FS_SANDBOX_DENIED、无文件、standing read-only 不变 | danger-full-access 本调用可取消 confinement |
| A7：审计 | 已实现 | 回归通过 | 默认 keys/hash；原始参数仅 opt-in；持久审批对回读 | 明确启用 logArguments 时含敏感数据 |

验收结论：**B2+B3 已实现，Web/macOS 的真实工具、审批与沙箱联动得到宿主集成证据。** 这不是 LLM/人工 UI 全链路，也不是桌面/Windows 或固定 tarball 的验收。管理新增成功的批准响应在 L3 为测试桩，不冒充真人操作。

## 9. 实施结果与修正

### 9.1 方案范围收窄与 DSH 回源确认（2026-11-03）

#### 本轮目标与落地内容

- 对应阶段：方案修订；关联 D1–D5、Q1–Q3。
- 实际完成：将原“外部目录 read/write 授权”修订为“工作区外写入审批补充”，并进一步确定采用 B2+B3：用户直接维护 profile 内授权文件，运行时通过管理工具更新规则，插件实时匹配；阅读 DSH user-approval、dsh-sandbox、dsh-tool-bash、dsh-tool-fs 的类型和运行时代码，确认审批请求字段和沙箱升级调用链。
- 相对计划的变化：取消 read 限制、取消插件新增 write 权限、取消审批 UI 扩展和插件设置页；取消 `session` 作用域，仅保留 `project`/`permanent` 与现有 `allowed-once` 结果。

#### 验证结果与证据

- 验证对象与环境：DSH 本体实现 checkout 中的 `@deepseek-ai/dsh-user-approval`、`@deepseek-ai/dsh-sandbox`、`@deepseek-ai/dsh-tool-bash`、`@deepseek-ai/dsh-tool-fs` 0.2.1-rc.3；仓库现有 `approval-allowlist` 源码。
- 执行方式：读取 `ApprovalRequestEvent`、`EscalationRequest`、`FsSandboxController` 类型定义和 bash/fs 运行时调用点。
- 实测结果：静态回源确认：审批请求不带独立目录字段；tool/call 可携带原始参数；bash 的升级审批绑定工具名、callId、justification 和 requested mode；fs 工具的目标路径在工具参数层存在但具体字段需真实事件确认。
- 证据位置：本文件第 3、4、8 节；DSH 本体文件路径记录在第 8 节对应版本说明中。
- 证据边界：足以确认当前插件可做精确调用级审批自动放行的设计可行性，不能替代真实 Web/macOS 运行联调，也不能证明任意 bash 的实际目录可被安全识别。

#### 发现的问题与修正

| 问题 | 原因或证据 | 修正 | 复验结果 |
|---|---|---|---|
| 将插件误设计为外部目录 read/write 权限系统 | 用户澄清当前沙箱已提供外部读取，需求只针对外部写入审批 | 改为只补审批决策，不干预 read/write 沙箱策略 | 方案范围已修订；功能待实现 |
| 假设审批请求天然包含目录信息 | `ApprovalRequestEvent` 只有 toolName、callId、reason 等字段 | 改为从 callId 回查 tool/call 原始参数；对任意 bash 的实际目录识别标记为不可行 | 静态源码确认 |
| 假设自动批准等同于授权外部写入 | `approveEscalation` 仍将结果用于一次调用的 sandbox mode，实际 provider 继续判定路径 | 明确 `allowed-once` 只免审批，不新增沙箱权限 | 静态调用链确认；运行验证待 M3 |

#### 本轮结论与遗留

历史结论（已由 9.2 更正）：**采用 B2+B3 的 project/permanent 版本。** 当时尚未实现；当前已完成字段采集、profile 授权文件、管理工具、配置校验、作用域匹配和现有 `allowed-once` 联调。若未来工具事件不再提供可匹配路径，仍按 fail-closed 保留原审批流程。

### 9.2 M1–M3 实现与 Web/macOS 验收（2026-11-03）

#### 本轮目标与落地内容

- 插件新增严格 v1 文件规则、profile 身份解析、project/permanent、每次读取、原子写入与排他锁、跨重载次数、独立审批管理工具、生命周期取消和默认脱敏审计。保留旧 inline 规则兼容，不增 UI/沙箱白名单。
- 真实宿主探针：`node scripts/bootstrap.mjs approval-host-probe --timeout 45000`。复用仓库一次性生命周期，不访问日常 profile/凭据；默认清理独立 home、shim、workspace，保留日志证据。
- M1 的事实来源为真实宿主工具 schema、ApprovalService 事件、session header 与 storage 回读；测试 driver 合成 assistant 工具广告及 tool/call 生命周期，不调用 LLM，不宣称用户现场全链路。

#### 验证结果与证据

- `node scripts/bootstrap.mjs build --check`：通过。
- `node scripts/bootstrap.mjs test`：通过；最终数量见任务根持久验收记录，完整日志 `<repo>/.tmp/approval-regression.log`（临时）。
- 真实 Web/macOS：`<repo>/.tmp/approval-host-probe/run-WMIOxL/report.json` 6 阶段通过，默认清理成功。observe 4 次调用、allow 14 次调用；`evidence/{observe,allow}/result.json` 的 `persistedReadback=true`。配对核验 asked/decided id 与 callId，存储事件和 live events 相等。
- 验证 write/edit/bash 自动批准且真实执行、文件撤销、project 隔离、permanent 跨项目、bash 三种字段变更负例、真实管理 list 和被拒新增无文件变化。
- A6 对照：standing read-only → allowed-once workspace-write，目标在 session cwd 外，原 FS provider 返回 `FS_SANDBOX_DENIED` 且文件未创建；standing policy 不变。该拒绝是 DSH FS provider fence，不冒充 macOS 内核拒绝。
- 审计默认不含 `content`/命令/reason/路径的回归断言通过；真实探针单独 opt-in 原始日志。完整边界和运行方法见 探针说明（历史路径 `test/approval-host-probe.md`，见 Git 快照 `10e42df0ac08360cc6d31177795d40dd33b30639`；当前文件已删除）。

#### 发现的问题与修正

| 问题 | 修正 | 复验 |
|---|---|---|
| root-only 并不等于人类授权，原型可自授权 | 新增/撤销独立 ApprovalService 请求；管理名称从allowlist排除 | L3拒绝/批准stub路径；真实拒绝无副作用 |
| 授权文件错误时沿用旧索引可能放过已撤销权限 | lastGood仅诊断，坏文件禁用本次自动决策 | L3 corrupt/lock/reload |
| 重载清零次数可多次批准 | 文件内used持久化，wx锁、同步读改写 | L3重新实例化和锁冲突 |
| Windows root-relative并非完整绝对路径 | drive-rooted/UNC限定；拒绝dot segment | Windows用例已加入，本机平台跳过 |
| 插件卸载后待批mutation仍可能写盘 | owner AbortController与调用signal合并，批准后复查 | L3 unload→late-allow仍无写入 |
| profile通过symlink越界或结构化自写授权文件 | canonical祖先隔离；path/file_path原串相同；禁止profile目标 | macOS symlink负例通过 |
| probe初始调用日志未满足v4关系约束 | 明示synthetic assistant广告、step从1开始；真实存储回读作为门禁 | 最终两模式回读通过，先前失败不计入成功 |

#### 本轮结论与遗留

M1–M3 实现完成，并按声明边界完成 Web/macOS 宿主集成验证。**管理成功批准路径仍为 L3 模拟，未做人类点击审批；未做真实 LLM、Windows/桌面、生产固定 tarball 安装。** 不把上述未执行范围写成通过；临时原始日志可能含完整参数和一次性启动 token，应保持本机，勿提交。

### 9.3 M4：macOS + Web 固定交付（2026-11-03）

按用户新边界，本期只声明 macOS + Web：同步 package targets、locale、README、生成 CATALOG、守卫与平台选择测试。L4 根据实际 manifest 过滤插件；Windows 不再强装审批插件，ART-07 不纳入其适用验收集，不把 skip 计为 passed。其他平台适配移到 M5。

交付内容：

- 随包空授权文件、过期规则示例、observe profile 配置；回归保证模板不默认授权。
- README 补固定包生成/校验/安装预览、旧 inline 迁移、次数与回退边界；不自动修改目标配置。
- `approval-host-probe --manifest PATH` 对同一完整清单校验所有包哈希，隔离安装审批 tarball，拒绝链接到源码，加载已安装固定入口，再运行真实工具/审批/provider/持久回读。报告和导出记录绑定 manifest SHA-256、源码 SHA-256、包 SHA-256；无 manifest 仍仅开发源码模式，不能算固定包证据。
- 负例覆盖缺包/错误清单、陈旧源码、任意包字节篡改、安装内容篡改、源码链接和不兼容平台；不更改原 verify-artifacts 门禁。

验证命令见插件 README。**固定批次生成后不再改源码文档，以免使验收失去绑定**；批次 id、哈希、命令退出状态、平台、报告路径及最终验收结论写在任务根（代码 worktree 外）的 `external-directory-authorization-m4-acceptance.md`。该记录不含认证 token，原始日志只留本机 `.tmp`。它是本节的实际验收结果，不把“入口已实现”当作“固定包已通过”。

非目标与证据边界沿用 9.2：非 LLM/人工点击 E2E；仅真实宿主服务集成。不安装日常 profile，不上传/发布，不承诺其他平台或其他 DSH 版本。

## 10. 当前未完成事项与下一步

| 事项 | 分类与当前状态 | 下一步或启动条件 | 依据 |
|---|---|---|---|
| 真实 LLM 调用及人工管理批准点击 | 额外端到端验收未执行 | 需要用户明确选择隔离模型/浏览器验证；不影响当前宿主集成事实 | §9.2 |
| Windows / desktop 适配 | M5 延期 | 明确启动后分别适配并真实验收；当前targets不声明、不安装 | M5 |
| macOS + Web 固定 tarball 交付 | M4 当前范围 | 实际批次验收状态以任务根持久记录为准，日常安装需另行选择目标 | §9.3 |
| 任意bash目录保证、UI、session授权 | 明确不做 | 继续精确调用及现有审批协议 | D2–D4 |

本轮 M1–M3 的代码与声明范围验证已完成；没有安装或修改日常环境，没有提交或推送。
