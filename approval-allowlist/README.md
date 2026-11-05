# @mbda9091/approval-allowlist

按**精确工具调用参数**免除重复审批。默认 `observe`，不会自动放行；不修改 DSH 的 sandbox policy，不新增目录读写权限。

## 适用场景

- 当前仅支持 **macOS + Web** 的 Host 进程，`dsh.targets` 为 `surfaces: [web] / platforms: [mac]`。
- Windows 和所有 Desktop 组合延期到 M5；安装过滤会跳过不兼容目标，直接加载时守卫在任何副作用前拒绝。
- 安装：在 Plugins 中安装本插件目录，或使用仓库的受管开发/固定产物安装命令。Host 代码更新后需重新构建并重启，不会自动更新已加载代码。

## 配置

bundle 只插入插件行；用户在 profile 的 `cordis.patch.yml` 配置：

```yaml
- id: approval-allowlist
  config:
    mode: observe
    rootOnly: true
    grantsFile: ./approval-allowlist/grants.json
    log: true
    logArguments: false
```

- `grantsFile`：相对**宿主 `profileContext.dir`**，默认 `approval-allowlist/grants.json`；可以覆盖为该 profile 内的绝对路径，不允许越界。没有 profile 身份时禁用文件规则和管理工具，不回退到 cwd 或环境变量。
- `mode`：`observe` 记录命中但继续原审批；`allow` 命中时返回 `allowed-once`。
- `rootOnly`：默认 true；缺失 agents 服务不能证明根身份，不自动放行。
- `log`：默认 true；`logFile` 默认系统临时目录的 `dsh-approval-allowlist.log`。
- `logArguments`：默认 false，仅写工具、callId、规则 id、参数键、SHA-256 与决策，不写内容、命令、reason 或路径。临时真实事件采集才显式设 true；该模式会泄露原始输入，请使用隔离日志并及时清理。
- `rules`：旧 inline 子集规则仍兼容，次数按插件加载计数；不建议用于新的持久授权。旧规则是可信配置，不具备新文件规则的严格字段要求。管理工具名称永远不自动批准。

授权文件示例（必须替换成真实的绝对路径）：

```json
{
  "version": 1,
  "rules": [
    {
      "id": "project-result",
      "scope": "project",
      "projectRoot": "/Users/me/project-a",
      "tool": "write",
      "path": "/Users/me/shared/result.json",
      "arguments": {
        "file_path": "/Users/me/shared/result.json",
        "sandbox_permissions": "workspace-write"
      },
      "maxUses": 1,
      "note": "one result write"
    },
    {
      "id": "exact-export",
      "scope": "permanent",
      "tool": "bash",
      "arguments": {
        "command": "node scripts/export.mjs --output /Users/me/shared/out.json",
        "workdir": "/Users/me/project-a",
        "sandbox_permissions": "workspace-write"
      }
    }
  ]
}
```

## 规则与生命周期

- `id` 唯一且必填（字母、数字、下划线、连字符，1–100）；`scope` 只支持 project/permanent，不支持 session。
- project 身份为不可变 `agent.session.header.cwd`，不是工具的 workdir、进程 cwd 或后续 cd；permanent 跨项目。不推断 Git 根目录。
- write/edit 只支持单一绝对 `file_path`，`path` 必须与它逐字一致；bash 必须固定完整 command、绝对 workdir 和 sandbox_permissions。没有通配/目录递归授权。
- 路径拒绝 dot segment、相对路径；Windows 拒绝缺少盘符的 root-relative 路径。结构化文件规则不自动批准对当前 profile 内文件的写入（包括经符号链接指向它的目标）。
- `arguments` 为非空 JSON 子集，数组/标量深度相等；额外实际参数可存在。文件内容不限，必要时把内容/old_string/new_string 等加入子集。
- `maxUses` 省略或 0 表示不限；正安全整数限制次数。文件规则的 `used` 在返回批准**之前**在文件内累加，重载/重启不重置；后续沙箱执行失败仍算已批准一次。用户直接编辑/恢复文件可能重置次数，这是可信人工配置，不是防篡改账本。
- `expiresAt` 是可解析时间字符串，建议带时区 ISO-8601，达到过期时刻即失效。
- 每次审批和管理操作重新读取文件，无 watcher/轮询。删除或清空文件立即撤销；坏 JSON/非法规则/重复 id 整份拒绝，保留上次索引仅供内部诊断，**不继续使用旧授权**。
- 写入通过同目录临时文件原子 rename，管理变更和计数使用排他 `.lock` 文件；冲突/写失败不批准。进程崩溃可能留下 lock，确认没有活跃写者后由用户清除，不自动抢占。
- 多进程插件写者遵守锁；直接外部编辑不遵守该锁，不能保证与其并发合并。请勿一边手工编辑一边调用管理工具。

## 运行时管理

```text
approval_list({})
approval_allow({"rule":"{...完整规则JSON，不含id/used...}"})
approval_revoke({"id":"规则id"})
```

仅活跃 root agent 可调用。新增自动生成 id；projectRoot 必须等于调用会话的原始 cwd。新增/撤销必须经过一次**独立审批**，本插件不会替这些请求作批准；无审批服务、拒绝、取消或插件卸载均不写盘。其他可信审批插件仍可能回答宿主审批链，因此这不是对不可信 Host 插件的隔离边界。

## M4 固定包交付与迁移（macOS + Web）

随包提供 [空授权文件](examples/grants.empty.json)、[已过期的规则示例](examples/grants.example.json) 和 [observe 配置示例](examples/profile.patch.example.yml)。示例不会自动安装或激活，直接复制规则示例也不会获得有效授权。路径占位符、有效期和沙箱模式均需用户明确替换。

最短验证步骤（在仓库根，普通 Node 24 / 已配置 pnpm 11.28.5）：

```text
node scripts/bootstrap.mjs build --check
node scripts/bootstrap.mjs test
node scripts/bootstrap.mjs pack
node scripts/bootstrap.mjs verify-artifacts --manifest dist/batches/<batch>/manifest.json
node scripts/bootstrap.mjs approval-host-probe --manifest dist/batches/<batch>/manifest.json
node scripts/bootstrap.mjs verify-artifacts --manifest dist/batches/<batch>/manifest.json --check
```

`pack` 生成固定 SHA-256 清单；`verify-artifacts` 完成隔离 tarball 安装、包/加载/能力契约与适用的 Web 测试；`approval-host-probe --manifest` 从已安装固定包运行真实审批工具和沙箱对照，不回退到源码 link。测试 home 是一次性的，默认清理数据但保留本机报告。命令不会安装日常 profile。

正式安装需用户显式选择已绑定目标，并且宿主版本与成功证据一致：

```text
node scripts/bootstrap.mjs stable-install --target <mac-web-target> --manifest dist/batches/<batch>/manifest.json --only @mbda9091/approval-allowlist --dry-run
# 确认预览与目标后，再移除 --dry-run 执行。不要以开发宿主或旧版本证据替代目标验证。
```

升级/迁移：

1. 在实际目标 profile 备份用户 patch 和已有授权文件；不修改 profile 的 package.json，不把模板覆盖整个 patch。
2. 新部署先 observe + 空规则；升级旧 inline `rules` 时逐条迁移，补 id/scope/projectRoot/严格参数，再从用户 patch 移除对应旧规则，避免撤销文件规则后仍被旧规则放行。
3. 管理工具需要原审批 answerer；无 answerer 时新增/撤销失败关闭，可信用户仍可直接维护文件。
4. 更换 Host 包后按宿主提示重启。配置重载后确认 observe 只记录；再审阅规则并切换 allow，测试一条命中和一条不命中。
5. 数据回退：授权文件置为 version 1 / rules 空数组立即撤销文件规则；旧 inline 规则必须同时去掉。配置回退：observe 或禁用插件后按宿主要求重载/重启。不要从备份恢复旧 used 值而意外补回次数。
6. 包回退：选择旧的已验证固定 manifest，经同一安装门禁执行，不手工更换 node_modules，不移除 link 依赖，不假设自动回滚。当前包在 Windows/Desktop 不激活，其他平台适配属于 M5。

验收不包含真实 LLM 请求/人工 UI 点击，管理成功批准以 L3 stub 验证；真实宿主探针覆盖管理列表、独立审批拒绝和无副作用，不冒充真人授权。

## 安全与回退

1. 先 observe，核验真实 tool/call 的字段后再配置 allow。
2. 无 callId、找不到本会话调用、toolName 不一致、参数错误、规则错误、超次数或过期均继续原审批。
3. 回退：删掉规则/文件实时撤销；改为 observe 后按宿主配置重载方式生效。
4. `allowed-once` 只完成一次审批，但宿主仍可能按所选 sandbox mode 扩大本调用权限。尤其 `danger-full-access` 可能取消本次沙箱约束，必须按精确调用的完整风险授权；不能承诺批准后原 workspace-write 边界仍存在。
5. 任意 bash 内部实际访问不可推断；即使 command 精确，脚本文件/环境仍可能改变行为。不要把可写脚本或能修改授权文件的命令视为安全目录白名单。
6. 不处理 PTC 子调用或多目标编辑的自动授权；无法通过当前 tool/call 精确关联时保持原审批。

验证与范围记录见 [工作区外写入审批方案](../docs/external-directory-authorization-plan.md)。
