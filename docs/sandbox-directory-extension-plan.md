# 沙箱目录扩展方案与迭代记录（v0.3）

> 状态：草案（待实施）。
> 更新日期：2026-11-04（Asia/Shanghai）。
> 当前结论：实现收敛为「只追加可写目录」；文档按模板记录。尚未实现。
> 验收基线：无（本轮未提交代码）。
> 关联文档：[方案模板](plan-template.md)、[dsh 概念](dsh-concepts.md)、[审批白名单](../approval-allowlist/README.md)（独立能力，本方案不涉及）。

## 1. 结论摘要

- **要解决的问题**：`opencli` 每次启动都写工作区外的 `~/.opencli`（日志、daemon、缓存、登录态），`workspace-write` 沙箱直接拒绝；模型只能改成 `danger-full-access` 重试，于是每次调用都弹一次审批。
- **采用的方案**：插件装饰 `ctx.sandbox.confine()`，在 Seatbelt profile 末尾追加 `(allow file-write* (subpath "<目录>"))`。命令仍在沙箱内执行，只改变「能写哪里」。
- **本轮边界**：仅 macOS + Web、仅 `workspace-write`；只做目录追加，不做命令匹配、不改审批、不改会话模式。
- **当前进展**：方案定稿，未实现、未验收。
- **下一步**：实现最小插件并在真机验证 A1（见第 10 节）。

## 2. 范围

### 2.1 目标

- G1：配置 `~/.opencli` 后，`opencli` 在 `workspace-write` 会话中可直接写该目录，不再触发审批。
- G2：未配置的路径仍不可写；删掉配置或卸载插件后立即恢复原边界。

### 2.2 非目标与延期项

| 事项 | 本轮处理 | 原因 |
|---|---|---|
| 按命令区分（只给 opencli 放宽） | 明确不做 | 需要命令解析与判据；先用全局目录跑通 |
| 审批代答（返回 `allowed-once`） | 明确不做 | 放行后命令在沙箱外，隔离更差 |
| 审计文件、`observe`/`allow` 模式 | 明确不做 | 只留一行启动日志 |
| 提示词片段、`pre-execute` 门禁 | 明确不做 | 与「只扩目录」无关 |
| Windows / Linux | 延期 | 仅实现 Seatbelt，其他 runner 原样返回 |
| `read-only` 模式下放宽 | 不做 | 会话已选最严模式 |

### 2.3 适用场景与协作边界

- 适用对象：本仓库插件；`dsh` Host 的沙箱包装层。
- 环境范围：**macOS + Web**（`surfaces: ["web"]`、`platforms: ["mac"]`），dsh `0.2.1-rc.2`。
- 与其他方案的分工：`approval-allowlist` 继续负责审批代答，本插件不读取也不修改它的配置。
- 完成定义：A1–A4 全部通过。

## 3. 现状与问题

| 对象 | 当前行为 | 问题与影响 | 依据 |
|---|---|---|---|
| `dsh-sandbox` 策略 | `writableRoots(policy)` 固定返回 `[workspaceRoot, /tmp, tmpdir()]`，无配置项 | 无法追加工作区外目录 | `dsh-sandbox/lib/index.js` |
| `dsh-sandbox-local`（Seatbelt） | `confine()` 返回 `[sandbox-exec, -p, <profile>, --, …argv]`，profile 是字符串 | 可在 `-p` 后追加规则 | `dsh-sandbox-local/lib/index.js` |
| `opencli` 写足迹（实测） | 启动创建 `~/.opencli/{opencli.log, daemon/, cache/, extensions/}`；认证命令写 `database.db` | 全部在工作区外 | 2026-11-04 本机 `HOME` 重定向实测 |
| 会话日志样本 | 15 次 bash / 6 次升级审批，均为 opencli | 人工确认负担 | `session.v4 6.jsonl`（本机） |

- 已有可复用能力：`ConfinedArgv` 契约、`assertTarget` 写法、L1 测试骨架、`scripts/bootstrap.mjs` 门禁。
- 已确认约束：插件自包含、运行时零依赖；`sandbox-exec` 已被标记弃用但仍随系统提供。
- 待验证假设：追加到 profile 末尾的 allow 能覆盖前置 `(deny file-write*)`（SBPL 后匹配生效）。

## 4. 具体方案

### 4.1 总体设计与职责

```
apply(ctx, config)
  └─ 装饰 ctx.sandbox.confine(argv, policy, signal)
       ├─ 调原 confine 得到 ConfinedArgv
       ├─ policy.mode !== 'workspace-write' → 原样返回
       ├─ argv 里没有 '-p'（非 Seatbelt）→ 原样返回
       └─ 在 profile 字符串末尾追加 (allow file-write* (subpath "<dir>")) × N
```

| 部分 | 职责 | 本轮改动 |
|---|---|---|
| `sandbox-directory-extension/src/index.ts` | `apply()`：校验目录、安装装饰、启动日志 | 拟新增 |
| `src/profile.ts` | 纯函数：目录校验、profile 追加 | 拟新增 |
| `src/targets.ts` | `assertTarget(ctx, name)` | 拟新增 |
| `package.json` / `tsconfig.json` / `cordis.patch.yml` / `locale/*` / `icon.svg` / `README.md` | 包元数据 | 拟新增 |

拟新增目录：

```
<repo>/sandbox-directory-extension/
├── package.json
├── tsconfig.json
├── cordis.patch.yml
├── src/{index,profile,targets}.ts
├── locale/{en,zh}.json
├── icon.svg
└── README.md
```

### 4.2 关键行为与异常路径

1. **加载**：`apply()` 校验 `allowedDirs`，安装装饰，打印一行生效目录。
2. **每次 spawn**：装饰读取 `policy` 与 `argv`；只在 `workspace-write` 且存在 `-p` 时追加，其余原样返回。
3. **目录校验**（非法项丢弃并告警，不影响其他项）：必须绝对路径（支持 `~/` 展开）、已存在、是目录；不能是 `/`、`$HOME` 本身，不能含 `.`/`..` 段。
4. **失败**：`confine` 抛错原样向上抛；未知 runner 原样返回，不阻断执行。
5. **无状态**：不写文件、不改会话；卸载即恢复。

### 4.3 接口、配置与使用方式

```ts
export interface Config {
  /** 工作区外可写目录；绝对路径，支持 ~/ 展开。 */
  allowedDirs?: string[]
}
```

写在 profile 的 `cordis.patch.yml`：

```yaml
- id: sandbox-directory-extension
  config:
    allowedDirs:
      - ~/.opencli
```

生效后：`workspace-write` 下任何命令都能写 `~/.opencli`；其他路径仍受原边界限制。

### 4.4 兼容、迁移与回退

- 兼容：不改审批、不改会话模式、不与 `approval-allowlist` 交互。
- 迁移：安装后在 profile 加配置即可；无需改动其他插件。
- 回退：删除配置项（重启/HMR 生效）或禁用插件行，立即回到原生沙箱。
- 隔离：无持久数据；不写 profile 以外的配置。

### 4.5 验证设计

| 验收项 | 对应目标 | 场景与预期行为 | 验证方式 |
|---|---|---|---|
| A1 | G1 | `opencli --version`（`workspace-write`）成功且无审批，日志文件更新 | 真实宿主 |
| A2 | G1 | `docs-cli markdown +create` / `+fetch` 成功，回读一致 | 真实宿主（会创建线上文档） |
| A3 | G2 | `touch ~/probe` 仍被拒，`rm -rf ~` 仍失败 | 真实宿主 |
| A4 | G2 | 删除配置后 `opencli` 恢复弹审批 | 真实宿主 |

## 5. 里程碑

| 阶段 | 交付内容 | 出口条件 | 当前状态 |
|---|---|---|---|
| M1 | 最小插件（校验 + 装饰 + 追加） | A1 通过 | 待开始 |
| M2 | 纯函数单测与构建门禁 | `build --check`、`test` 通过；A3、A4 通过 | 待开始 |

## 6. 决策记录

| ID | 决策与理由 | 替代方案 | 日期 | 状态 |
|---|---|---|---|---|
| D1 | 只装饰 `confine()`，不装饰 `resolve()` | 装饰 resolve 以便按命令匹配——本轮不需要 | 2026-11-04 | 已定 |
| D2 | 目录全局生效，不按命令 | 按命令匹配需解析器与判据，复杂度高 | 2026-11-04 | 已定 |
| D3 | 保留最小校验（绝对/存在/非根/非家目录） | 完全不校验——误配即把家目录交给所有命令 | 2026-11-04 | 已定 |
| D4 | 无审计、无模式、无提示词 | 先跑通，按需要再加 | 2026-11-04 | 已定 |
| D5 | 仅 Seatbelt；其他 runner 原样返回 | 同时做 bwrap/ACL——未验证 | 2026-11-04 | 已定 |

## 7. 风险与开放问题

### 7.1 风险

| ID | 风险 | 影响 | 应对 | 状态 |
|---|---|---|---|---|
| R1 | 目录对所有命令可写，不只是目标程序 | 任何命令都能写这些目录（如改 `~/.opencli/extensions`） | 用窄目录；文档明示；这是本方案的取舍 | 已接受 |
| R2 | profile 不是 `-p <profile>` 形状（其他 runner / 上游改动） | 追加失效，退回原审批（安全方向） | 找不到 `-p` 原样返回 | 待验证 |
| R3 | 其他插件替换 `sandbox` 服务 | 装饰丢失，退回原审批 | 启动日志标记；必要时重挂 | 待验证 |

### 7.2 开放问题

| ID | 问题 | 解决方式 | 当前结论 |
|---|---|---|---|
| Q1 | 追加的 allow 是否覆盖前置 deny | M1 用 `opencli --version` 与 `touch ~/probe` 对照 | 未决 |
| Q2 | `opencli` 能否只给 `log/daemon/cache`（SQLite 是否要写同目录 db） | M1 期间逐项试 | 未决 |

## 8. 验收状态

> 截至：2026-11-04。验收对象：无（未实现）。

| 验收项 | 实现状态 | 验收结果 |
|---|---|---|
| A1 | 未实现 | 未执行 |
| A2 | 未实现 | 未执行 |
| A3 | 未实现 | 未执行 |
| A4 | 未实现 | 未执行 |

验收结论：本轮未满足完成定义。

## 9. 实施结果与修正

尚未实施。

## 10. 当前未完成事项与下一步

| 事项 | 分类与状态 | 下一步 |
|---|---|---|
| 最小插件与真机验证 | 待实现 | 实现 `src/index.ts` + `src/profile.ts`，配置 `~/.opencli`，跑 A1 |
| 单测与门禁 | 待实现 | A1 通过后补 L1 用例与 `build --check`/`test` |
| Q1 / Q2 | 未决 | 与 A1 同批确认 |

执行顺序：实现 → A1 → 单测/门禁 → A2–A4。
