# Hindsight 本地部署＋DeepSeek 抽取

本轮部署方案：Hindsight、PostgreSQL/pgvector、embedding 和重排全部在本机运行；生成式 LLM 使用 Hindsight 的 `deepseek` provider。DSH 对话和 P3 角色成长复盘保持宿主独立 route，不读取这里的密钥或自动切换供应商。本机 Linux/WSL 已使用 host-network 覆盖启动真实服务，并通过合成抽取／中文召回 smoke；后续已补中文40项、角色短轨迹及恢复验收，结果与边界见 [M3](../../../../docs/companion/role-agent-m3-acceptance.md)；长期收益未证明。

## 固定基线

| 组件 | 配置 |
|---|---|
| Hindsight | `1.2.1`，Compose 固定多架构镜像 digest |
| 数据库 | PostgreSQL 18＋pgvector，固定镜像 digest；不发布数据库端口 |
| 生成式 LLM | `provider=deepseek`，官方 `https://api.deepseek.com`；初始模型 `deepseek-flash`，关闭 thinking，可用 `HINDSIGHT_LLM_MODEL` 显式调整 |
| embedding | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`，384维，固定 HF revision，CPU |
| 重排 | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`，多语，固定 HF revision，CPU |
| 角色成长 | 继续使用 DSH P3/P4；Hindsight 自动 observations／consolidation 在服务和角色 bank 两层关闭，插件不调用 reflect |

两个本地检索模型是首轮可复现基线，不是中文效果胜出的结论。它们有各自的输入长度限制，长材料的截断及相关性须在真实语义40项中验证；切换模型须记录维度与 revision，并执行重建／重编码验收，不能混用旧向量。

2026-11-15 已从镜像仓库读取两个镜像 digest、从 Hugging Face 读取两个模型 revision；发布身份核对不证明镜像与此前调研的固定源码完全一致；后续已执行本机镜像与模型推理，结果见下文。

## 准备与启动

需要 Docker Engine／Docker Desktop（Linux containers）和 Compose v2+。默认没有 GPU 要求；为本地检索和数据库预留内存，实际峰值与延迟待测。首次需联网拉取镜像和模型；运行期 LLM 必须访问 DeepSeek，按 API 使用量收费，相关对话材料会出本机。

在本目录复制 `env.example` 为 `.env`，填写三个非空值：DeepSeek API key、本地服务独立 key、随机十六进制数据库密码。`.env` 已由仓库忽略；两个 key 用途不同，插件只需要本地服务 key。不向 Compose 传入整份 DSH 环境，也不复用日常 profile。示例使用非隐藏文件名，以满足仓库固定包不携带隐藏文件的约束；真实 `.env` 不打包。

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d
docker compose --env-file .env ps -a
```

`models` 是一次性准备任务，只下载固定权重，不接收 DeepSeek key；成功退出后才启动 Hindsight。运行服务从只读模型卷加载并设定 Hugging Face／Transformers 离线模式，不在查询中请求远端 embedding／重排 API。启动 Hindsight 可能触发供应商验证请求，也可能计费。

Linux／WSL 若只能通过宿主 `127.0.0.1` 上的代理联网，默认 bridge 容器不能直接复用该地址。本目录提供显式的 `compose.host-network.yaml`（需 Compose 2.24.4+）；先在当前 shell 设置已有 `HTTP_PROXY`／`HTTPS_PROXY`，所有生命周期命令统一使用以下文件对：

```sh
docker compose --env-file .env -f compose.yaml -f compose.host-network.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.host-network.yaml up -d
docker compose --env-file .env -f compose.yaml -f compose.host-network.yaml ps -a
```

该覆盖仅让模型准备和应用使用 host 网络及显式代理；API／管理界面仍绑定 `127.0.0.1`，数据库额外映射到 `127.0.0.1:55432`（可用 `HINDSIGHT_DB_PORT` 改端口）。不修改系统代理、Docker daemon 或防火墙。普通 Docker bridge 环境继续使用默认配置；Docker Desktop 不默认套用此 Linux 覆盖。停止、备份和恢复命令也须带同一文件对，防止无意重建不同网络配置。

API 为 `http://127.0.0.1:8888`，管理界面为 `http://127.0.0.1:9999`，均只监听本机；端口可在 `.env` 调整。API 开启 bearer 认证，管理界面转发同一本地 key。若 DSH 自身在容器里，需单独设计容器网络，不能照搬回环地址。

## DSH 接线

将 `.env` 中的 `ROLE_HINDSIGHT_API_KEY` 同值设置为 **DSH 进程环境变量**（Compose 的 `.env` 不会自动导入 DSH）。Host 行配置仍按插件 README 的用户 profile 机制设置：

```yaml
- id: role-agent
  config:
    endpoint: http://127.0.0.1:8888
    apiKeyEnv: ROLE_HINDSIGHT_API_KEY
```

Hindsight 调用 DeepSeek 的 key 留在服务侧。专属 mode、按需 recall、来源检查、更正屏障与角色成长提交规则均沿用原实现。切勿把 DeepSeek base URL 填入插件 `endpoint`。

## 数据、停止与恢复

本目录固定项目名 `role-agent-memory`；数据库卷为 `role-agent-memory_postgres`，模型卷为 `role-agent-memory_models`。隔离试验用独立 `docker compose -p <试验名>`，后续所有命令保持同名；不得与正式数据混用。

`docker compose down` 停止并保留命名卷；`down -v` 会删除数据，不作为日常停止命令。模型卷可通过固定 revision 重新下载；数据库不能用模型缓存替代备份。部署前用 `pg_dump -Fc` 将库备份到容器内临时文件，再用 `docker compose cp` 导出，避免不同 shell 的二进制重定向差异：

```sh
docker compose exec -T db pg_dump -U hindsight -d hindsight -Fc -f /tmp/hindsight.dump
docker compose cp db:/tmp/hindsight.dump /absolute/backup/path/hindsight.dump
```

备份放在仓库外或受忽略的本地目录；DSH home／角色状态与会话日志须一并备份。恢复试验只针对全新的隔离项目：等待新数据库健康，将 dump 用 `compose cp` 复制到新 db 的 `/tmp/hindsight.dump`，在启动 Hindsight 前执行 `pg_restore -U hindsight -d hindsight --no-owner --exit-on-error /tmp/hindsight.dump`，然后启动应用并核对角色绑定和来源。未完成实际恢复试验，不宣称备份已验收。

## 验证边界与来源

本机已通过真实服务 readiness、无凭据拒绝、DeepSeek 异步 retain 完成、中文自然语言查询召回对应 source document，以及合成 bank 清理；管理界面 HTTP 200，未做视觉验证。[脱敏记录](../../../../docs/companion/m3-evidence/hindsight-deployment-smoke.json)仅证明基础链路。后续中文40项、更正／在途恢复／备份还原已运行，见 [M3 真实验收](../../../../docs/companion/role-agent-m3-acceptance.md)。管理界面完整交互和部分中断请求总费用仍未知；按 [M2 §5.3 与 §7](../../../../docs/companion/role-agent-memory-evaluation.md)保留门槛，不把本节 smoke 当作完整结果。这里只改变记忆服务部署，不改变总体角色架构。

- [固定源码的服务配置](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/hindsight-docs/docs/developer/configuration.mdx)：provider、CPU 本地检索、bank 默认开关和认证。
- [上游 PostgreSQL Compose](https://github.com/vectorize-io/hindsight/blob/5318be8ea572aa00ceae636c71c1d8d334f805b6/docker/docker-compose/external-pg/docker-compose.yaml)：应用与独立数据库部署。
- [DeepSeek 当前模型及 API](https://api-docs.deepseek.com/quick_start/pricing/)：显式选择模型，别依赖 Hindsight 的旧默认别名；模型名不代表永远冻结的模型版本，真实验收须记录服务端返回身份。
- [embedding 模型](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42)、[重排模型](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/tree/1427fd652930e4ba29e8149678df786c240d8825)：下载脚本固定同一 revision，不启用远端自定义代码。
