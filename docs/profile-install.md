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

安装先检查当前 tarball 的源码快照、工具链和内容哈希。匹配则输出 `reuse-tarball`，不编译或打包；仅编译输出有效时输出 `reuse-build`，只打包；否则输出 `rebuild`。版本号相同不代表内容相同；损坏的包拒绝使用。源码快照包含文档和 Git 状态，使用保守整批复用。bootstrap 编译脚本自身的步骤仍保留。

tarball 默认归档到 `~/.local/share/dsh-plugin/releases`；可用 `--archive-root <绝对路径>` 指定独立持久目录。仍被 profile 引用的包不得随意删除。安装报告记录逐包结果和配置状态；失败可能已经安装部分包，不自动卸载或回滚。

默认配置位于：

```text
<home>/profiles/<profile>/mbda9091/cordis.patch.yml
```

首次生成，后续仅补缺失插件行；已有同 ID 配置完整保留，包括禁用状态、`!!js` 和注释。不重写 profile 根 patch，不生成个人模型、凭据或白名单授权。改写前备份到同目录 `.bak`，旧备份另存唯一副本。复杂且无法无损追加的 YAML 会拒绝修改。

该子目录不会被 DSH 自动扫描。用户可在自己的 Web 启动命令中传 `--patch <配置绝对路径>`；显式 patch 的优先级高于 profile/home 配置，config 为整段替换，请自行决定加载顺序。安装不申请通知权限、不重启宿主，也不声称功能已验收。

`stable-install --manifest ...` 继续用于严格交付，要求已有匹配的验收记录，不自动生成此配置。完整验收仍通过 `pack`、`verify-artifacts`、`stable-install` 完成。

自有包名前缀改为 `@mbda9091/`。若目标仍安装同名 `@local/` 插件或根 patch 引用旧包名，直接安装预检会拒绝；先通过宿主支持方式处理旧包和个人引用后重试，避免两个 scope 插入同一 loader ID。旧开发环境需要显式 `dev-web reset --yes` 后重新 `dev-install`，不会自动删除开发数据。
