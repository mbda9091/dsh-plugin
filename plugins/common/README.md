# 插件共享代码

这里是构建期共享库，不是可安装的 DSH 插件。

| 目录 | 用途 |
|---|---|
| notify-core/ | 通知文案、locale、纯格式化逻辑 |
| notify-host/ | 通知事件监听、状态过滤和资源清理 |

包名保留 @mbda9091/notify-core、@mbda9091/notify-host。插件通过 workspace 包名引用，构建时内联；不写跨插件目录的相对运行时 import。build 先构建这些共享库，再构建活跃插件。common 容器及其子包不进入插件 CATALOG 或安装集合。

对应通知回归位于 test/src/plugins/notify-web/；通用构建与安装回归仍在 test/src/common/。
