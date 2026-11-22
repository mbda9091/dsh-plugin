# 本地安全扫描

本仓库使用 my-py-utils 的 `repo-security` 管理安全扫描工具及 Git 原生 hook，要求 Git **2.54.0 及以上**。

准备 Git、uv 和 `repo-security` 命令后，在仓库根目录安装或重装：

```sh
repo-security setup .
repo-security doctor .
```

安装会按锁文件准备 Python 3.13、Semgrep 和 Presidio，并校验固定版本 Gitleaks 的下载摘要。工具及本机安装记录保存在 `.security/.venv/`、`.security/bin/` 和 `.security/install-manifest.json`，不入库。

`repo-security setup .` 在仓库本地 Git 配置中注册 `hook.repo-security.command = ./.security/hooks/pre-commit`、`hook.repo-security.event = pre-commit`。提交时自动扫描本次暂存变更，发现问题或安装未就绪时阻止提交。不创建 `.git/hooks/pre-commit` 分发器或 `pre-commit.d/10-security` 链接。

克隆已审阅的 `.security/` 文件后，也可以使用 `.security/setup.sh` 安装工具并注册原生 hook；此入口不更新仓库中的安装代码。需要更新或重装标准文件时使用 `repo-security setup .`。

手动扫描命令：

```sh
# 本次暂存变更
repo-security scan . --mode staged

# 当前提交
repo-security scan . --mode head

# 所有本地引用可达的提交历史
repo-security scan . --mode history
```

Gitleaks 检查密钥，Semgrep 使用本地规则检查代码，Presidio 检查个人信息。规则分别位于 `.security/gitleaks.toml`、`.security/semgrep.yml` 和 `.security/policy.json`。仓库原有自定义规则由安装记录保留；推送前没有自动 hook 检查，完整历史检查需手动执行。
