# 日常 Web 独立启动器

Windows、普通 Node 24、Web 形态的独立进程管理工具，不是 DSH 插件，不进入 CATALOG。发行件只有 Node 内置运行时依赖，不包含 Node、DSH 或 pnpm。

仓库中执行：

```text
node scripts/bootstrap.mjs daily-launcher prepare --target daily --destination <绝对外部目录>
node scripts/bootstrap.mjs daily-launcher deploy --target daily --destination <绝对外部目录> --dry-run
node scripts/bootstrap.mjs daily-launcher deploy --target daily --destination <绝对外部目录>
```

`prepare` 写 `dist/daily-launcher/<候选>/`；`deploy --dry-run` 不写文件；`deploy` 重新构建候选、核对哈希、检查语法并原子更新外部 `active.json`。部署不启动宿主、不写 profile、不替换 shell 函数。配置快照在 `config/daily-<UUID>.json`，active 同时选择不可变发行件和配置，避免更新一半的配置影响旧版。现有实例 UUID 跨升级保留。

部署后的 `bin/shell-integration.txt` 提供 PowerShell 函数接入内容，`bin/dshweb.ps1` 是直接调用入口。切换已有 shell 函数属于另行安排的 S4；需要备份并验证命令实际解析。仓库 `web` 在存在部署定位记录时委托外部入口，仍需仓库编译；独立运行必须调用外部入口。

独立入口支持 `start`（默认）、`status`、`stop`、`check`。启动选项为 `--no-open|--open`、`--port`、`--host`；默认 127.0.0.1:3080。工具版本、真实路径、入口文件和 Node 字节绑定在快照中，不跟随仓库版本或 PATH。状态查询和停止只依赖已部署配置及认证控制通道，不检查 pnpm/DSH 是否仍存在。禁止按记录中的 PID 强杀进程。

`check` 检查依赖 spec、真实目录、运行时资源和 home/profile 的 `cordis*.yml/yaml`。源码引用和缺失本地来源列为 blocked；动态表达式、其他本地配置资源及未知链接列为 review。存在任一种发现或失联记录时退出 1；不会输出 YAML 值、凭据或会话内容。它不能静态证明任意 JS/YAML 动态行为，迁移前必须处理 review 项。

发布失败时旧 release 保留。`receipts/<UUID>/deployment.json` 保存 previous/next 指针及源码、工具、逐文件哈希。恢复前确认运行实例已停止，核对 previous 指向的 JS 和配置哈希，将 previous 写到同目录临时文件再重命名为 `active.json`；运行外部 `check` 后重启。未知 runtime/lock 不能直接删除，必须先确认 supervisor 和子进程均已退出。协议 v1 的 dispatcher 固定；其字节变化会拒绝覆盖，需显式使用新部署目录和安排入口切换。

构建期从 `scripts/.build/core` 内联纯参数化的进程控制、子进程及配置契约；`lib/` 是类型检查/开发中间产物，不是独立发行件。部署消费 esbuild 的自包含 `.mjs`，元文件门禁拒绝任何非 `node:` 外部 import。共享包管理配置/cache/store 保留；不提供操作系统安全沙箱或自动工具升级。
