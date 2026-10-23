# M0 Theia AI 与聊天组件探针

日期：2026-10-23。范围：M0-01、M0-05 的隔离可行性验证。使用官方固定发布包，不修改应用 package/lockfile，不安装全仓依赖，不调用真实模型或硬件。

## 结论

采用 **Nodu 薄 UI + Theia 受控模型适配 + Node 网关**。已实测 Theia 1.76.0 的真实 DI 注册、模型委托、取消及贡献过滤机制，可在调用模型前检查后端授权的上下文与能力。此结论不代表通用 Theia Delegate 自带授权控制。

不直接启用 `ai-chat-ui` 默认前端模块。它包含通用模型、上下文、能力、变更集以及插入代码操作，与当前教学侧栏边界差异较大。`@cline/ui@0.1.0` 的消息/滚动原语可以独立复用，已在现有 React 上打包并实际渲染，但该版本没有输入组件，也没有教学状态、引用校验或消息传输；本阶段不把它加入应用依赖。

M0-01：后端边界可行性已通过，正式端点、工作台贡献隔离和生产网关仍需集成验证。M0-05：完成发布包核查、Cline 隔离渲染与打包；Theia 完整聊天 Widget 未装载，browser/Electron 完整集成未验证。不能据此把两套侧栏的全部验收项目标为通过。

## 基线与实测

- 探针运行 Node `24.21.0`、宿主 React `19.3.1`、Theia `1.76.0`；终端默认 Node 25 未用于本次合同执行。
- 应用清单没有直接列出 AI 依赖，但现有 lockfile/node_modules 已通过 `plugin-ext` 等传递依赖包含 `ai-core`、`ai-core-ui`、`ai-mcp`。不能把“未直接声明”写成“尚无 ai-*”。`ai-chat`/`ai-chat-ui` 未安装。
- 包下载后按 npm 元数据 SHA512 校验，再仅提取常规文件；未运行包生命周期脚本。固定来源及完整性值见 [短证据清单](probes/ai-probe-results.json)。
- [真实边界探针](probes/ai-boundary.cjs) 通过 11 项断言：仅暴露受控模型、批准上下文可达假模型、重放拒绝、上下文替换拒绝、前端工具拒绝、server tools 拒绝、端点/settings 覆盖拒绝、旧 epoch 拒绝、取消传至 Provider、贡献身份过滤、初始化后不能补注册过滤器。实际假模型收到 2 次调用，网络请求与硬件操作均为 0。
- 使用已有 `esbuild` 打包 Cline 发布入口，构建图中 React 只有宿主一份，Monaco 输入为 0。这只证明该隔离构建没有重复，不等于正式全量依赖图已通过。
- 浏览器实际显示 350px 消息区域，验证 Enter 提交、教学/提问外层切换、深浅主题映射、假流追加及停止后空闲状态。HTML 形状字符串按文字显示。输入框、模式和停止状态属于 Nodu 探针外层，不应记为 Cline 提供的能力。
- 尚未验证 OS 中文输入法组合、上滚后持续流的跟随策略、完整工作台/Electron、真实 HTTP 取消、全量 Markdown 渲染、生产 bundle 增量。这些仍是后续门槛。

## Provider 与默认贡献边界

实际路径是 `LanguageModelProvider` → `DefaultLanguageModelRegistryImpl` → `LanguageModelFrontendDelegateImpl` → `LanguageModel.request`。本次使用真实类和 Inversify Container，只有最终模型是假实现。Registry 中不注册原始模型，仅注册包装后的模型；包装器检查一次性后端 grant、上下文和 epoch，并拒绝请求自带工具、server tools、deferred tool IDs 和 settings。

`LanguageModelFrontendDelegateImpl` 会把前端传入工具映射到客户端 `toolCall`，因此不能把“走过 Theia RPC”当成已获得只读保证。正式实现应让 Nodu 网关构造模型请求，服务端独立校验上下文、工作区、版本、预算与展示工具 schema。前端可选择的模型注册表里不能同时暴露绕过网关的原始实例；过滤按钮也不能替代这一边界。

`ai-openai@1.76.0` 的 `OpenAiLanguageModelsManagerImpl` 直接 `new OpenAiModel(...)` 并写入 Registry，模块中虽声明 `OpenAiModelFactory` 标识，但未绑定成可重绑的工厂。因此不能仅假定 rebind 一个 Factory 就能拦截全部路径。可复用 `OpenAiModel` 类并在 Node 适配层私有持有，再通过受控模型调用；不要加载默认 manager/RPC 后将原始模型额外公开。上游默认 `maxRetries=3`、runner `maxChatCompletions=100`，正式适配需按 Nodu 有界请求策略显式收敛。本次只核对其源码，未实例化真实 OpenAI 端点。

`ai-chat-ui` 的默认模块注册视图、Command/Menu/Toolbar/Frontend 贡献；默认输入配置包含 Context、Pinned Agent、ChangeSet、Capabilities，代码响应动作含 `InsertCodeAtCursorButtonAction`，变更集含接受动作。若将来复用整模块，必须在容器初始化时通过 `FilterContribution` 过滤每类入口，并复核 action/renderer 绑定；不应采用 CSS 隐藏。当前探针使用真实过滤器类验证机制，但没有声称已清除完整运行工作台的所有贡献。

薄 UI 路线直接使用项目组件及独立 Tutor 协议，不需要激活上游聊天模块。必要时复用小 renderer；升级时重点回归 DI token、模型 request/取消契约、默认注册路径和工具权限，而不是依赖上游私有 UI 结构。

## 发布内容、体积与许可

| 固定包 | gzip 字节 | 解包常规文件字节 | 文件数 | 声明许可 |
| --- | ---: | ---: | ---: | --- |
| `@theia/ai-core@1.76.0` | 506277 | 2855971 | 558 | EPL-2.0 或带 Classpath exception 的 GPL-2.0-only |
| `@theia/ai-chat@1.76.0` | 466695 | 2805604 | 442 | 同上 |
| `@theia/ai-chat-ui@1.76.0` | 517447 | 2739513 | 507 | 同上 |
| `@theia/ai-openai@1.76.0` | 117541 | 667168 | 102 | 同上 |
| `@cline/ui@0.1.0` | 23049 | 100035 | 13 | Apache-2.0 |

以上为实际 npm 压缩包及常规文件计数，不是应用安装包增量，也不含全部传递依赖。上游许可证和必要通知应保留；未进行全量应用 SBOM 审核。

Cline 的发布 `exports` 只有 `components/agent-chat`、对应 CSS、4 个 theme CSS 路径及 package.json，没有 root、composer、Markdown 或 message-scroller 导出。运行依赖为空，React 与 Tailwind 为可选 peer；当前探针仅引入 agent-chat CSS、局部映射颜色/字体 token，不引入 theme 全局 reset。发布 JS 仅引用 React 及 jsx-runtime。

实测全部 Cline agent-chat 原语独立 minify ESM 为 **7926 字节**，React external 后 gzip 为 **2757 字节**；原始 agent-chat CSS **8207 字节**。包含探针外层和 ReactDOM 的预览 JS 为 **229264 字节**。这些值不能当作未来应用的 tree-shaking 或最终安装增量。Theia 完整 UI 构建增量未测，不给估算值。

## 复跑与证据

从仓库根目录运行，现有 desktop/node_modules 必须已经可用；脚本不调用 npm install：

```sh
/opt/homebrew/opt/node@24/bin/node docs/ai-tutor/probes/ai-boundary.cjs
python3 docs/ai-tutor/probes/fetch-ai-packages.py
/opt/homebrew/opt/node@24/bin/node docs/ai-tutor/probes/build-ai-preview.cjs
python3 -m http.server 4218 --bind 127.0.0.1 --directory artifacts/ai-tutor-m0/ai-probe
```

Node 路径为本机 Node 24 路径，其他机器改用对应 Node 24 可执行文件。最后一步仅用于打开 `http://127.0.0.1:4218/` 手工查看隔离组件，不连接 Nodu 工程或模型。

版本库保留 `probes/` 中源脚本、预览源和短证据清单；下载包、完整 npm tree、生成 bundle、截图在 `artifacts/ai-tutor-m0/ai-probe/`，由该目录 `.gitignore` 排除。截图 `cline-dark.png`、`cline-light.png` 是本机验证证据，界面仅为探针，不是产品设计稿。应用 package/lockfile 未改动。

官方来源：[Theia ai-core 固定发布元数据](https://registry.npmjs.org/@theia%2fai-core/1.76.0)、[ai-chat-ui 固定发布元数据](https://registry.npmjs.org/@theia%2fai-chat-ui/1.76.0)、[ai-openai 固定发布元数据](https://registry.npmjs.org/@theia%2fai-openai/1.76.0)、[Cline UI 固定发布元数据](https://registry.npmjs.org/@cline%2fui/0.1.0)。实现核查以对应实际发布 tarball 内的 `src/`、`lib/` 和 `dist/` 为准。
