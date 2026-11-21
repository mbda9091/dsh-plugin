# 本地提交安全检查

本仓库使用 repo-security 0.3.0 的原生 Git hook，只自动检查 pre-commit。
需要 Git 2.54.0 及以上、uv 和首次安装所需的网络。Git 过旧、缺失或版本无法识别时，安装入口告警并终止，不创建环境或降级使用旧分发器。

首次克隆或拉取已审阅的安全资源更新后执行：

```sh
.security/setup.sh
repo-security doctor .   # 已安装 repo-security CLI 时使用
```

standalone 安装入口不依赖全局 repo-security CLI；每个检出使用自己的扫描器环境。
setup 通过真实工具和合成检测样本后才标记就绪，安装中断或就绪检查失败会阻止提交；处理报错后重跑同一入口。

已有原生 hook、传统 hook、hooksPath 和项目规则保留。setup 只把自己的安全主注册放在管理配置末尾，不重排其他检查；重复执行不会增加重复扫描。
Git 仍可在安全项之后执行传统入口或后来添加的检查，因此扫描保证覆盖调用时的提交索引，包括部分提交，不承诺覆盖后续 hook 再次暂存的内容。

```sh
git hook list pre-commit
git hook run pre-commit
.security/run staged
.security/run head
.security/run history
```

提交前运行 Gitleaks、Semgrep 和 Presidio；失败会阻止提交。手动历史扫描需显式执行，不自动安装 pre-push。
规则文件 `.security/policy.json`、`gitleaks.toml`、`semgrep.yml` 随仓库维护，例外必须限定到已审阅的值及文件，不能为通过扫描整体排除测试或文档。

linked worktree 必须由工作区预先开启 `extensions.worktreeConfig` 并准备隔离配置；安装器不自动改变共享扩展或 hooksPath。
安装器只管理本工具的扫描资源与原生注册，不扫描其他工具的 hook 目录，不删除旧入口，不迁移项目检查，也不改写 hooksPath。其他工具继续管理自己的安装与配置。

不支持的安装清单、已有资源冲突或禁用状态会在写入前报告并停止，不执行自动清理。若 hooksPath 指向本工具的 `.security/hooks`，会造成原生与传统入口重复调用，setup 保留配置并报告冲突，由用户另行处理。

脚本与规则入库；`.security/.venv/`、`bin/` 和安装清单不入库。
安装不会配置 DSH profile 或运行插件业务。本轮验收范围为 Linux x64 / WSL2；原生 macOS 不在本轮验收范围内。
