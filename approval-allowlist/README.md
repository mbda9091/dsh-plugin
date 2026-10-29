# @local/approval-allowlist

按**精确工具调用参数**为指定命令加白审批，默认只观察、不自动放行。

## 适用场景

- 形态：桌面应用（Electron 壳）或 Web；`dsh` 的 Host 进程。
- 平台：Windows / macOS。
- 声明：`dsh.targets` 为 `["desktop","web"]` / `["mac","windows"]`。

## 安全模型

- 不按 `reason` 文本匹配；`reason` 是给人看的，可被命令内容伪造。
- 通过 `approval/request` 的 `callId` 找到对应的 `tool/call` 事件，比较 `name` 和原始 `arguments`。
- 默认 `mode: observe`：只写审计日志，继续走原审批流程。
- 只有 `mode: allow` 且规则精确命中时才返回 `allowed-once`。
- 默认只允许根 agent；`maxUses` 省略或设为 `0` 表示无限放行，支持 `expiresAt`。
- 规则里的 `arguments` 是子集匹配：对象按键递归匹配，数组/标量必须深度相等；空对象不会命中。

> `allow` 模式等于把某条命令的审批权限交给插件配置。配置文件只应由可信用户维护。审计日志会包含命令原文，可能含敏感参数。

## 配置

配置写在 **profile 的 `cordis.patch.yml`**（用户层），不要写进插件的 `cordis.patch.yml`。插件 bundle 只负责插入行，默认是 `observe`；profile 层在 bundle 之后应用，会覆盖整行配置。

```yaml
- id: approval-allowlist
  config:
    mode: observe          # 先观察；确认后再改 allow
    rootOnly: true
    log: true
    logFile: '<repo>\.tmp\approval-allowlist.log'
    rules:
      - tool: pwsh         # 必须填真实的 shell 工具名
        arguments:
          command: 'node test/e2e/web-l5.mjs'
          workdir: '<repo>'
        note: 'Web L5 spike'
```

`arguments` 只需要写要固定的字段；实际参数多出的字段不影响匹配。

`maxUses` 省略或设为 `0` 时无限放行；正安全整数表示本次插件加载期间最多放行的次数，重新加载后重新计数。负数、小数、字符串、`null`、非有限数及超出安全整数范围的值均非法：加载时打印包含规则索引的错误日志并跳过该规则。其他有效规则仍可匹配；没有有效规则命中时继续原审批流程。配置错误日志不受审计开关 `log: false` 影响。

## 工作流

1. 以 `mode: observe` 安装/启用。
2. 触发一次 L5 命令，正常审批一次。
3. 查看 `logFile`，确认 `tool`、`arguments`、`callId`、`decision`。
4. 把实际 `tool` 和 `arguments` 写进规则，切换 `mode: allow`。
5. 用完把 `mode` 改回 `observe` 或禁用插件。

## 限制

- 只对带 `callId` 的审批请求生效；没有对应 `tool/call` 的请求一律放行给原流程。
- 工具参数 schema 由对应工具决定；插件按 JSON 子集匹配，不做命令语义解析。
- 不能替代沙箱；它只改变审批结果，不改变工具自身的权限边界。
