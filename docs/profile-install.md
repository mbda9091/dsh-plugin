# 将当前插件安装到已有 profile

日常 DSH 的启动、停止和 profile 创建由用户负责。本命令仅支持本机 macOS/Windows Web，默认安装所有兼容插件，不适配 Desktop。

先准备 Node 24、仓库声明的 pnpm、workspace 依赖及 `config init`。登记已有目标，或在安装时完整提供目标参数：

```sh
node scripts/bootstrap.mjs target bind my-web --dsh-cli /path/to/dsh/lib/bin.js --home /path/to/home --profile custom-web --surface web --platform mac
node scripts/bootstrap.mjs install --target my-web --dry-run
node scripts/bootstrap.mjs install --target my-web
# 只安装一个插件
node scripts/bootstrap.mjs install --target my-web --only @mbda9091/notify-web
# 强制重新编译、打包
node scripts/bootstrap.mjs install --target my-web --rebuild
```

Windows Web 使用 `--platform windows` 和本机绝对路径。也可通过 `pnpm run install-plugins --target my-web` 调用；`pnpm install` 仍是安装仓库依赖。

安装（含 `--dry-run`）先检查目标 DSH 版本，要求与仓库根 `package.json` 中 `@deepseek-ai/dsh` 的精确版本一致（当前 `0.2.2-rc.1`）；不匹配或无法读取版本时，在安装包和写入配置前停止。`stable-install` 仍按验收记录匹配宿主版本。

安装先检查当前 tarball 的源码快照、工具链和内容哈希。匹配则输出 `reuse-tarball`，不编译或打包；仅编译输出有效时输出 `reuse-build`，只打包；否则输出 `rebuild`。版本号相同不代表内容相同；损坏的包拒绝使用。源码快照包含文档和 Git 状态，使用保守整批复用。bootstrap 编译脚本自身的步骤仍保留。

tarball 默认归档到 `~/.local/share/dsh-plugin/releases`；可用 `--archive-root <绝对路径>` 指定独立持久目录。仍被 profile 引用的包不得随意删除。安装报告记录逐包结果和配置状态；失败可能已经安装部分包，不自动卸载或回滚。

默认配置位于：

```text
<home>/profiles/<profile>/mbda9091/cordis.patch.yml
```

首次生成，后续仅补缺失插件行；已有同 ID 配置完整保留，包括禁用状态、`!!js` 和注释。不重写 profile 根 patch，不生成个人模型、凭据或白名单授权。改写前备份到同目录 `.bak`，旧备份另存唯一副本。复杂且无法无损追加的 YAML 会拒绝修改。

通知插件的新配置只展示审批通知、审批延迟、完成通知、错误通知 4 个用户选项。内部通信参数不默认生成，使用插件内置默认值，需要时仍可手动添加到 `config`；参数解释和加载示例见 [通知插件配置](../notify-web/README.md#配置)。旧文件中的完整参数不会被安装器自动删除；希望恢复内置默认行为时，可以自行备份后移除对应字段。

该子目录不会被 DSH 自动扫描。用户可在自己的 Web 启动命令中传 `--patch <配置绝对路径>`；显式 patch 的优先级高于 profile/home 配置，config 为整段替换，请自行决定加载顺序。安装不申请通知权限、不重启宿主，也不声称功能已验收。

`stable-install --manifest ...` 继续用于严格交付，要求已有匹配的验收记录，不自动生成此配置。完整验收仍通过 `pack`、`verify-artifacts`、`stable-install` 完成。

自有包名前缀改为 `@mbda9091/`。命令不检查或清理旧 `@local/` 包、bundle 和个人引用，由用户手动处理；开发环境也不因旧 scope 拦截初始化。

默认配置追加会核对已有行的解析值，保留 YAML 块文本尾部换行；无法无损追加时拒绝写入。2026-11-06 已移除审批白名单插件，当前 Web 安装只选择 notify-web。旧 profile 中的插件与授权文件不自动清理，移除说明见 [已撤销方案](external-directory-authorization-plan.md)。
