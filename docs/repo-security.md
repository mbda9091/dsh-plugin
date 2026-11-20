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
仍继承主检出活动旧安全分发器时，应在所属主检出迁移，不能从子工作树删除共享入口。
如果工作区已经核对现有检查并提供独立 hooksPath，子工作树可以单独接入；未在该工作树生效的共享旧入口保持原样，主检出继续使用自己的检查。

本工具的旧安全入口确认所有权后删除；旧 hooksPath 从实际存放它的配置文件清理。涉及共享和工作树两个配置文件时，先备份并锁住两者，再启用原生守卫和清理旧值。来自 include、全局或存在多值歧义的旧设置须先审阅，安装器不会擅自清理。

原来停用的项目检查继续停用。如果移除旧目录设置会启用默认目录中被遮蔽的传统脚本，旧值会替换为 `/dev/null`；原来活动的项目检查已通过原生注册接入。已有的显式全局 hooksPath 管理器按其配置恢复继承，不会被新增本地值遮住。本工具停用的旧分发器仍会删除，其项目成员不会因此被启用。

脚本与规则入库；`.security/.venv/`、`bin/`、安装清单和机器生成的迁移适配脚本不入库。
安装不会配置 DSH profile 或运行插件业务。本轮验收范围为 Linux x64 / WSL2；原生 macOS 不在本轮验收范围内。
