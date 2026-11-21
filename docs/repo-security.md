# 本地安全扫描

本仓库使用 [my-py-utils 仓库的 repo-security](https://github.com/mbda9091/my-py-utils/tree/main/packages/repo-security) 提供安全扫描。要求 Git **2.54.0 及以上**，版本不达标时安装会告警并终止。在仓库根目录执行以下命令安装：

```sh
.security/setup.sh
```

安装后，Git `pre-commit` 自动执行安全扫描，发现问题时阻止提交。工具的安装要求和维护说明见上述 repo-security 文档。
