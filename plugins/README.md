# 活跃插件

| 插件 | 用途 | 专属测试 |
|---|---|---|
| [notify-web](notify-web/README.md) | 浏览器提问、审批及完成通知 | `test/src/plugins/notify-web/` |
| [role-agent](role-agent/README.md) | 专属角色、记忆与成长 | `test/src/plugins/role-agent/` |

除 common 外，每个直接子目录是一个自包含 npm 包和 Cordis bundle，通过自己的 package.json 声明 dsh.bundle 与适用场景。构建、目录生成和安装只发现这里的活跃包；共享代码放在 plugins/common/，停更包移入根 archive-plugins/。

所有构建、测试与安装命令仍在仓库根执行。源码目录的绝对路径可用 `node -p "require('node:path').resolve('plugins/notify-web')"` 获取。曾安装旧源码目录链接的外部 profile 需重新安装新路径；现有固定归档安装不受目录搬迁影响。

测试目录说明见 [test/README](../test/README.md)，仓库规则见 [AGENTS](../AGENTS.md)。
