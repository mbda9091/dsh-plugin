# DSH 0.2.2 rc.5 适配与验收记录

> 当前活跃集合已按后续 [app-restart 归档轮次](app-restart-archive-plan.md) 调整为 notify-web、role-agent；本页其余插件范围、批次与测试数量保留为当轮事实。

> 后续范围调整（2026-11-24）：用户确认 desktop-notify 当前没有使用场景，决定停止更新并归档。其源码与专属测试恢复为升级前 rc.1 快照，移出活跃插件集合；本页四插件批次与测试数量保留为归档前历史证据，当前范围及验证见[归档记录](desktop-notify-archive-plan.md)。

> 本轮范围：将活跃插件及开发测试宿主从 `0.2.2-rc.1` 适配到 npm `latest` 的 `0.2.2-rc.5`；desktop-notify 按用户后续决定冻结归档。
> 完成：是（本机 Web 范围，已完成实现提交对账）。
> 状态：已完成。
> 更新日期：2026-11-24（Asia/Shanghai）。
> 完成日期：2026-11-24。
> 实现 commit：`4cc5ca723054d2e6a67120b0cdedd3fe1d52f006`。
> 验收基线：`caf23be4197821c1bf207e0e1e492a508edf26e8` 加本轮工作区改动；固定产物见第 8 节。
> 归档：未归档。

## 1. 结论摘要

三个活跃插件、notify-host 共享库及 Web 测试夹具已经对齐 rc.5；desktop-notify 按用户后续决定恢复升级前快照并归档。通知逻辑改用新版子 Agent 树接口，角色 preset 同步标准工具及技能目录。类型检查、L1–L3、快速环境测试、真实 Web L4/L5 和固定 tarball Web 验收均通过；归档后的集合检查另见归档记录。

## 2. 范围与完成定义

最初范围包括 app-restart、desktop-notify、notify-web、role-agent、构建依赖、锁文件、测试及当前使用指南；最终交付按用户后续决定排除 desktop-notify，并保留最初四插件验收为历史证据。版本使用查询当日的 npm `latest`，`alpha` 标签的 `0.2.3-alpha.2` 不作为本轮目标。完成定义为本机 Web 验收通过并补齐提交对账；Windows 桌面和其他平台的实机验证单独记录覆盖边界。

## 3. 现状与问题

rc.5 移除了 `AgentRegistry.roots()`，并将 `SubagentRuntime.waitForChildren()` 改为 `waitForTreeWork()`。直接升级依赖会使通知共享库编译失败。投影与存储的公开类型使用 Zod `4.6.6`，插件原先固定的 `4.4.3` 无法满足接口。标准 preset 新增 Office 工具与内置技能目录，子 Agent 控制工具也新增 `wait_agent`。

## 4. 具体方案与实现

- 根开发宿主及所有已声明的 DSH 类型依赖精确锁定 `0.2.2-rc.5`，pnpm 生成锁文件；Cordis 继续使用宿主兼容的 `4.1.0`。
- notify-host 提供统一的 `rootAgents()`：读取 live registry，存在 subagents 服务时用 `rootOf(agent) === agent` 判断；归属不可用时保持静默。无 subagents 服务的组合按 Session `origin` 排除委派会话，普通 fork 不因 parentSession 被排除。
- 审批、完成及提问通知共享上述根判断；完成门禁使用 `waitForTreeWork()`，保留旧回合失效、目标完成、待处理输入及卸载清理规则。
- notify-web 与 role-agent 的 Zod 构建依赖同步到 `4.6.6`，仍内联进产物。
- role-agent 同步 rc.5 标准 preset 的 Office 工具与内置技能目录，继续排除子 Agent、workflow 及新增的 `wait_agent`；真实标准工具名和 schema 对账继续生效。
- Web 夹具迁移新的扁平 `startActivation({ parent, prompt, ... })` 参数，替换已移除的 roots 调用。

安装目标仍须与根宿主精确匹配。现有外部环境升级 DSH 后按安装指南重新安装插件并重启已加载 Host；本轮不修改日常 profile、会话或全局 DSH。

## 5. 里程碑

依赖对齐、接口迁移、回归测试、本机 Web 固定产物验收及实现提交对账均已完成。归档后的 300 项测试通过、1 项平台跳过及 28 项环境检查与实现提交字节对账见归档记录。

## 6. 决策记录

2026-11-24 通过 `npm view @deepseek-ai/dsh dist-tags --json` 确认 `latest` 为 rc.5；阅读 [rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)、[rc.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)、[rc.4](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.4)、[rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5) 发布说明，并核对已安装包公开类型、实现和标准 composition。锁文件中非 DSH 包的增删仅涉及 Zod 版本，未顺带升级其他工具链。

## 7. 风险与边界

本机环境为 macOS arm64、普通 Node `v24.16.0`、pnpm `11.28.5`、系统 Chrome。Windows 桌面及 Linux 实机能力未执行；桌面插件只获得类型、打包及适用的自动化契约证据。角色能力使用脚本化模型与隔离测试后端，不证明真实模型语义、Hindsight 服务或长期成长效果。

本机 Corepack 返回 pnpm `.mjs` 入口，与仓库要求的 `.cjs` 不符；验证使用仓库支持的 `DSH_PNPM` 覆盖，指向已安装的同版本 `bin/pnpm.cjs`，未修改入口解析规则。

## 8. 验收状态与证据

2026-11-24 的本机结果如下；链接为本地忽略目录，清理后可能失效。

- 升级前 L1–L3：334 通过、0 失败、1 跳过；升级后：336 通过、0 失败、1 平台跳过。见[最终测试日志](../.tmp/dsh-rc5-upgrade/test.log)。
- `build --check`、`build`、`install --frozen-lockfile`、`pack` 通过；见[类型检查](../.tmp/dsh-rc5-upgrade/check.log)、[冻结安装](../.tmp/dsh-rc5-upgrade/frozen-install.log)。冻结安装复用了已有系统缓存，不代表冷缓存安装。
- `test-env --suite fast`：28 项全部通过，见[环境报告](../.tmp/environment-tests/run-MNrGJM/report.json)。未运行完整 `ci` 或 `test-env --suite real/all`。
- 普通 L4 全部通过，含角色真实工具执行、SSE、目标守卫和 tarball 安装，见[L4 报告](../.tmp/l4/run-oGNdKW/report.json)。
- 普通 L5：独立基线 1 项、插件交互 10 项全部通过，见[L5 报告](../.tmp/l5/run-FYW34l/report.json)。
- 固定批次 `c0dd3f57-10ab-4aed-8932-4006b074166e` 包含四个插件；macOS Web 的 notify-web、role-agent 通过真实 L4/L5，其他 surface/platform 明确标记 uncovered。见[清单](../dist/batches/c0dd3f57-10ab-4aed-8932-4006b074166e/manifest.json)和[验收记录](../dist/verification/c0dd3f57-10ab-4aed-8932-4006b074166e/web-mac.json)。
- 新增根归属测试覆盖普通 fork、嵌套成员与失去归属；反转 `rootOf` 条件能触发失败，恢复后通过，见[变异验证日志](../.tmp/dsh-rc5-upgrade/mutation.log)。

上述批次为文档写入前的首次固定验收证据。文档回写后另以完整工作区生成批次 `e64ab413-00eb-4eb5-beed-e87aa4d89983`，其[固定 Web 验收记录](../dist/verification/e64ab413-00eb-4eb5-beed-e87aa4d89983/web-mac.json)通过，随后 `verify-artifacts --check` 通过。两批均为归档前四插件快照；归档后的三插件打包与实现提交对账见归档记录，不以会变化的 current 指针替代历史证据。

## 9. 实施结果与修正

类型检查定位并修正了根 Agent 与等待接口、Zod 类型不匹配。真实 L4 的标准工具对账识别到新增的 `wait_agent`，按角色不委派约束补入排除清单。真实 L5 识别到测试后端仍使用旧启动参数，修正后验证通过。期间一次 PTC 提问浏览器等待超时；单独重跑及随后固定 tarball L5 均通过，未据此放宽断言或将超时视为通过。

## 10. 当前未完成事项与下一步

本轮本机 Web 范围及提交对账已完成。Windows 桌面及其他平台的实机验证按对应宿主执行，不以 macOS Web 结果替代；desktop-notify 已停止维护，不再作为当前升级或验收待办。
