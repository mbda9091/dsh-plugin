# 本地安全扫描

本仓库使用 my-py-utils 提供并入库的安全扫描脚本及 Git 原生 hook，要求 Git **2.54.0 及以上**和 uv。自动初始化和提交扫描不依赖全局 `repo-security` 命令。当前安装脚本支持 Linux/macOS；原生 Windows 未支持。

准备上述工具、Node 24 和 pnpm 11.28.5 后，新 clone 的仓库只需照常安装依赖：

```sh
pnpm install --frozen-lockfile
```

根 `package.json` 的 `postinstall` 先运行 `node scripts/git-hooks.mjs setup` 校验当前 checkout 并注册独立的测试清理 pre-push，然后自动执行 `.security/setup.sh`；清理 hook 与原安全 hook 并存，安全失败仍使安装失败。清理 hook 先注册不代表安全环境已准备成功。缺少 Git/uv、下载失败、校验失败或 hook 注册失败时，脚本打印原因并返回非零，`pnpm install` 随之报错；不能把依赖已下载当作安全配置成功。修复原因后重新运行安装命令即可。使用 `--ignore-scripts` 会跳过自动配置；`git clone` 本身不执行初始化脚本。

GitHub Actions 在冻结安装前准备 uv 并检查、按需升级 Git。`TOOL-04` 的无 Git 元数据源码副本显式移除副本自身的根 `postinstall`，保留依赖构建脚本；它验证依赖隔离，不代表新 clone 的 hook 验收。

安装脚本会按锁文件准备 Python 3.13、Semgrep 和 Presidio，并校验固定版本 Gitleaks 的下载摘要。首次安装可能需要联网，重复执行脚本会校验并复用本地工具。pnpm 11.28.5 在依赖未变化的重复安装中可能跳过 `postinstall`，因此它不是每次安装时的健康检查。工具及本机安装记录保存在 `.security/.venv/`、`.security/bin/` 和 `.security/install-manifest.json`，不入库。

安装脚本在仓库本地 Git 配置中注册 `hook.repo-security.command = ./.security/hooks/pre-commit`、`hook.repo-security.event = pre-commit`。提交时自动扫描本次暂存变更，发现问题或安装未就绪时阻止提交。不创建 `.git/hooks/pre-commit` 分发器或 `pre-commit.d/10-security` 链接。

需要单独修复扫描环境时，也可以直接运行 `.security/setup.sh`；此入口不更新仓库中的安装代码。需要更新或重装标准文件时，可选用全局 `repo-security setup .`；完整诊断可选用 `repo-security doctor .`。

手动扫描命令：

```sh
# 本次暂存变更
.security/run staged

# 当前提交
.security/run head

# 所有本地引用可达的提交历史
.security/run history
```

Gitleaks 检查密钥，Semgrep 使用本地规则检查代码，Presidio 检查个人信息。规则分别位于 `.security/gitleaks.toml`、`.security/semgrep.yml` 和 `.security/policy.json`。仓库原有自定义规则由安装记录保留；推送前没有自动 hook 检查，完整历史检查需手动执行。
