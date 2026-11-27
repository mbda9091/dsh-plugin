# Codex 订阅登录

在 DSH 的模型设置页提供 ChatGPT 账号授权面板，复用宿主已有的 `openai-codex` OAuth、凭证保存和刷新。主／子 Agent、工具及审批继续由 DSH 执行，不调用 Codex CLI，不修改 DSH 内部代码。

## 适用场景

仅 **Web · Linux**，DSH `0.2.2-rc.5`、普通 Node 24。本机浏览器授权；macOS、Windows、Desktop、远程浏览器回调及无浏览器部署不在首版范围。

## 使用与安装

运行仓库的 `node scripts/dev.mjs build`，在 Plugins 页面安装本目录绝对路径；外部安装也可用 `node scripts/install.mjs install --profile <名称> --only @mbda9091/codex-login`。开发使用 `node scripts/dev.mjs dev-install` 和 `node scripts/dev.mjs dev-web --no-open`，只进入受管 home。

外部安装器将本插件的默认超时配置补入目标 profile 的 `mbda9091/cordis.patch.yml`，保留已有配置；插件 bundle 本身不修改模型路由。开发 home 的授权不会随安装迁移，日常 home 需自行登录。

打开 Settings → Models，先通过宿主设置添加 OpenAI Codex，保持 API Key 为空、使用原生端点及协议，再在页面下方登录。按原生提示选择浏览器或设备码方式；设备码是否开放由账号或 workspace 设置决定。成功显示“已保存授权”后，在正常会话选择该 provider 的模型验证推理。

## 配置

`loginTimeoutMs?: number`：本插件登录尝试上限，默认 `600000`（10 分钟）；原生流程可能更早结束。

## 已知限制

- 已保存授权只表示本地 grant 存在，不证明套餐、额度或模型可用。
- 重新登录会覆盖同一凭证键；失败或取消不主动删除旧授权。
- 本地退出只删除 `llm-pi-ai/openai-codex` 记录，可能影响同一 home 的其他 profile，不撤销服务端授权。在途请求、取消后的迟到保存和跨进程竞争沿用宿主行为。
- 刷新页面会丢失本页登录句柄；原尝试结束或超时后可重试。不在浏览器持久存储授权链接、设备码或回答。
- 插件卸载保留授权及模型配置；需要删除授权时先点“本地退出”。Host 更新后按宿主提示重启。
- 真实账号登录、推理、审批、子 Agent、重启及自然刷新必须单独验收；模拟交互不证明这些能力。
