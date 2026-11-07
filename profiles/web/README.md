# 开发与测试 Web

日常启动由用户负责。将插件安装到已有 profile 并生成配置，见 [指定 profile 安装](../../docs/profile-install.md)。

开发使用 workspace 锁定的普通 Node DSH `0.2.2-rc.1`，固定 profile `web`，可变数据在 `.local/dsh-dev/`。完整字段、目录归属和异常恢复见 [配置 v2](../../docs/configuration-v2.md)。

## 准备与使用

先准备普通 Node 24、pnpm 11.28.5，运行 `pnpm install --frozen-lockfile`。不读取旧本机 JSON，也不导入旧个人 YAML。

```sh
# 初始化受管开发数据，与旧配置无关
node scripts/dev.mjs dev-web init
node scripts/dev.mjs dev-install
node scripts/dev.mjs dev-web --no-open
```

`dev-web` 显式启动开发环境，默认通过 `--port 0` 分配空闲端口，可显式传 `--port` 覆盖。开发入口只接受 loopback 地址，保留原有生命周期管理。

仓库管理的开发与测试环境分别如下；日常环境由用户管理：

| 用途 | 端口 | 数据目录 |
|---|---|---|
| 开发预览（`dev-web`） | 默认随机空闲端口 | `.local/dsh-dev/home`，停止后保留 |
| 自动化测试（L4/L5） | 每次通过 `--port 0` 由系统分配空闲端口 | `.tmp/<suite>/run-*/dsh-home`，一次性独立数据 |

另一个终端可运行：

```sh
node scripts/dev.mjs dev-web status
node scripts/dev.mjs dev-web stop
# 只预览清理范围
node scripts/dev.mjs dev-web reset
# 停止已核对身份的实例并清理受管数据
node scripts/dev.mjs dev-web reset --yes
```

停止保留配置和调试会话；开发重置会删除受管 home、patch、日志及管理记录，不删除共享包管理数据。已登记插件 link 只解除链接，不递归到源码。缺少归属记录、未知外部链接或无法核对实例身份时停止并诊断。日志和运行记录留在本地，可能包含认证参数，不要提交。

首次 `dev-web` 或 `dev-install` 也会初始化开发环境；重复初始化保留已有内容。模型配置由开发者在此环境中自行设置，工具不复制日常凭据、会话或审批策略。

## 文件与重载

| 文件 | 用途 |
|---|---|
| 命令参数与默认值 | 工具按需解析，浏览器/超时可覆盖；不再需要 local.json |
| `profiles/web/cordis.dev.patch.yml` | 版本化开发模板，仅 HMR 路径支持 `${repoRoot}` |
| `.local/dsh-dev/cordis.patch.yml` | dev-web init 生成的开发 patch；可编辑，重复 init 不覆盖 |
| `.local/dsh-dev/home/profiles/web/` | 通过宿主公开接口初始化的开发 profile；依赖由插件管理器管理 |
| `.local/dsh-dev/owner.json` / `runtime.json` | 目录归属和进程身份记录，不手改 |
| `profiles/web/cordis.patch.example.yml` / `cordis.local.patch.yml` | 保留的旧个人模板/文件；当前命令不读取或生成 |

开发 patch 作为 `--patch` 最后应用：bundle → profile → home → 开发 patch，同一行的 `config` 整体替换。修改前备份，重启生效。不要手工改 profile 的依赖记录。开发模板仅配置明确的插件 `lib/` HMR 范围，不预装通知行或审批规则；新增插件时明确增加产物目录。

`dev-install` 先构建，再安装和验证 `link:` spec 与实际链接位置。HMR 不保证新的 Host 模块已加载：入口导入失败、包替换或 `restart-required` 时，运行 `dev-web stop` 后重新 `dev-web`；Client 更新后刷新页面。通知需要浏览器站点授权，且标签页保持打开。

启动超时、失败或正常中断会停止本次子进程；异常杀死 supervisor 后不按记录中的 PID 自动回收。人工确认 supervisor 和 child 都已退出，再按配置 v2 的恢复步骤处理残留记录。仓库移动或父目录改成 junction 后不会自动认领原数据。

## Windows 上安装依赖时报 `ENOENT scandir ..._tmp_...\node_modules`

此前本机 dsh `0.2.1-rc.2` 的 HMR 将 `path.relative()` 返回的 Windows 反斜杠路径直接交给 picomatch，默认的 `**/node_modules` / `**/.*` 因此可能不匹配。尤其 profile 在 C 盘、仓库在 D 盘时，依赖和隐藏目录都会被监听。监听器持有子目录句柄，pnpm 的 hoisted 安装移动旧依赖目录时先遇到 `EPERM rename`，随后其合并回退又扫描不存在的临时目录，最终显示 `ENOENT scandir`。

本目录的 patch 已将代码监听范围收窄为各插件的 `lib/`，同时显式保留默认排除规则，并补充 Windows 反斜杠规则。这里的 `**\\node_modules` 使用 YAML 单引号，两个反斜杠原样传给 picomatch，用于匹配路径中的一个反斜杠；不要改成单个反斜杠。

更新 patch 后，先停止并重新启动使用本 patch 的 Web 服务，使旧监听句柄释放，再在普通终端重跑原来的 `pnpm install`。如果暂时不需要 Web 服务，也可停止它后直接安装。仅更换终端或退出桌面窗口不够：独立的 Web 服务也可能仍在运行。

不需要删除锁文件、清空 store、修改 ACL 或更换 Node/pnpm。全新 `node_modules` 偶尔成功只是没有触发旧嵌套依赖的移动，不能作为长期修复。

已用 dsh 自带的 chokidar / picomatch、Node `24.21.0`、pnpm `11.28.5` 做隔离对照：

| 条件 | 结果 |
|---|---|
| 原排除规则，监听包含嵌套依赖的目录 | 复现相同 `ENOENT`，原始错误为 `EPERM rename` |
| 关闭该监听器，原失败目录直接重试 | 安装成功，无需清理目录或缓存 |
| 加入本 patch 的 Windows 排除规则，保持监听 | 安装成功，依赖目录没有被监听 |
| 修复后修改插件 `lib/*.js` | 仍收到代码变化事件 |

上游根治应在 HMR 匹配前把相对路径分隔符统一成 `/`，或显式配置 picomatch 的 Windows 路径支持；pnpm 还应保留首次移动失败的原因，避免用后续 `ENOENT` 遮盖它。
