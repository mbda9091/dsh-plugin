# @local/notify-core

`desktop-notify` 与 `notify-web` 的共享内容层：通知标题/正文格式化、中英文文案、`turn/end` 原因到通知内容的映射。它不是 DSH 插件，没有 bundle、targets 或运行期安装；两个插件在构建时用 esbuild 把它内联进各自的产物。

只放纯函数和类型，不依赖 Node、浏览器或 Cordis，方便 Host 与 Client 共用。
