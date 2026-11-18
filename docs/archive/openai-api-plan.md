# OpenAI API Key 接入（简版）

> 完成：是
> 状态：已完成
> 完成日期：2026-11-18（Asia/Shanghai）
> 实现 commit：不适用：无仓库代码变更；配置在本机 profile，未入库
> 归档：已归档，2026-11-18；[归档索引](README.md)
> 当前结论：内置 `llm-pi-ai` 的 `openai` 路由已接入平台 API Key；配置在 profile 根 patch，原 `--patch` 覆盖层已置空；用户确认待执行项完成、使用正常。
> 验收基线：2026-11-18 用户确认；未附独立日志/截图。

## 结论

- 用 DSH 内置的 `llm-pi-ai` 适配器，路由名 `openai`，走 OpenAI 平台 API Key；不新增插件、不改仓库代码。
- Web 设置页只读写 profile 根 patch：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`。要让页面设置和配置文件保持一致，profile 根 patch 必须是 `llm-pi-ai` 这一行的**最后一层**——home 或 `--patch` 不能再定义同一个 id。

## 最终配置

`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（本机为 `macos-web`）里：

```yaml
- id: llm-pi-ai
  config:
    providers:
      # 该行原本还有其他 provider；这里只列新增的 openai
      openai:
        displayName: OpenAI
        apiKeyEnv: OPENAI_API_KEY
```

`openai` 的协议、端点、模型目录都用 pi-ai 内置 catalog 默认值：`openai-responses`、`https://api.openai.com/v1`、`gpt-6.1-*` 等。

## 实施结果与验收

**2026-11-18**

- `llm-pi-ai` 的 provider 配置（含新增的 `openai`）已合并进 profile 根 patch；原 `--patch` 覆盖层 `mbda9091/model-providers.cordis.patch.yml` 置为 `[]`。
- 备份：`cordis.patch.yml.bak-20261118-before-provider-merge`、`model-providers.cordis.patch.yml.bak-20261118-before-merge`。
- `dsh --profile macos-web --dump-config` 校验：`llm-pi-ai` 只有一行，来源为 profile patch。
- 用户确认：移除 `--patch`、重启 DSH、在 Models 页填入 API Key 后，模型可选择、实际使用正常。
- 未单独记录：工具调用与平台 Usage 的独立证据；不据此宣称逐项验收。

## 注意

- 模型目录：pi-ai 1.5.0 自带 `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-astra`、`gpt-6-luna`、`gpt-6-sol`；`gpt-6.2-*` 需要在模型目录手工加行（`models` 会整体替换该路由目录）。
- codex 品牌模型已退役，实际使用 `gpt-6.x`。
- 不要让 home 或 `--patch` 再定义 `llm-pi-ai`，否则 Web 设置页保存会报 `overridden by a home patch or command-line overlay`。
- 回滚：恢复上面的两个备份并重启；或在 Models 页删除 OpenAI 行。

## 关联

- 通用规则：[dsh-concepts.md](../dsh-concepts.md) §4.6
- 方案模板：[plan-template.md](../plan-template.md)
