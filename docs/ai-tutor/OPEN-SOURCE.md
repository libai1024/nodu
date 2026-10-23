# AI 侧边栏开源复用选型

核查：2026-10-23。结论：有可复用组件，但没有核验过可直接安装、同时满足 Nodu 教学需求的现成插件。本次只核对官方源码、文档和发布元数据，没有安装插件或接入模型。

## 1. 推荐路线

**Theia AI 负责会话与模型基础，Nodu 负责教学交互。聊天展示优先评估同版本 Theia UI 复用，同时保留 Cline 独立聊天组件作为候选。** 不整装 Continue/Cline 的自动编程工作流，不让第三方默认布局决定教学 UI。

此前方案把 `ai-chat-ui` 整包排除；本轮修订为“可评估组件复用，但不能原样启用默认贡献”。选择 UI 组件与选择 AI 运行时是两件事：使用 Cline 展示组件也不意味着必须使用 Cline SDK。

## 2. 选项对比

| 选项 | 可复用部分 | 需要适配的部分 | 当前判断 |
| --- | --- | --- | --- |
| Theia AI `ai-core` / `ai-chat` | 模型、Agent、会话与消息基础 | Nodu 网关、教学状态、上下文、行检查 | 基础首选，与当前 Theia 1.76.0 一致 |
| Theia `ai-chat-ui` 1.76.0 | 输入、会话列表、消息与响应渲染等宿主组件 | 默认入口、DI 依赖、工具按钮、双模式、教学头部 | 同源 UI 首选探针；裁剪成本待测 |
| Cline `@cline/ui` | 独立 React 聊天展示组件 | Nodu 样式映射、消息映射、传输与状态 | 有价值的 UI 候选，不要求同时引入 Cline Agent |
| Cline VS Code 扩展 | 完整聊天和自动编程操作界面 | Webview/扩展 API、源码编辑与命令工作流裁剪、教学联动 | 不作为首期教学侧栏基础 |
| Continue VS Code 扩展 / GUI | 聊天、上下文、补全等界面源码 | 宿主消息桥、多个入口、教学状态与权限裁剪 | 不建议新建长期依赖 |

上表“成本”和“推荐”是本项目判断；不是已完成的集成测试成绩。

## 3. Theia 具体能复用什么

本地应用已使用 Theia 1.76.0，尚无 ai-*。同版本 [ai-chat-ui 清单](https://github.com/eclipse-theia/theia/blob/v1.76.0/packages/ai-chat-ui/package.json) 存在；[ChatViewWidget](https://github.com/eclipse-theia/theia/blob/v1.76.0/packages/ai-chat-ui/src/browser/chat-view-widget.tsx) 组合输入与消息视图，[AIChatInputWidget](https://github.com/eclipse-theia/theia/blob/v1.76.0/packages/ai-chat-ui/src/browser/chat-input-widget.tsx) 提供丰富输入能力。

复用不能只理解成 npm 安装后换颜色。[默认前端模块](https://github.com/eclipse-theia/theia/blob/v1.76.0/packages/ai-chat-ui/src/browser/ai-chat-ui-frontend-module.ts) 注册视图、工具栏、输入配置和代码插入动作等，包清单也声明自动加载的 Theia 模块。M0 需要确认这些贡献能否通过适配、DI 重绑定或 [Contribution Filter](https://theia-ide.org/docs/contribution_filter/) 收敛到唯一入口；仅 CSS 隐藏按钮不能作为能力隔离。

候选做法：Nodu 外层 Widget 固定“教学 / 提问”和步骤区，内部适配消息/输入组件；显式映射消息、引用和取消，教学展示走独立 schema。若必须长期大面积 fork 才能达到要求，就只保留 ai-core / ai-chat，自定义薄 UI，不维护第二套聊天工作台。

包声明许可为 `EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0`。实际采用版本的许可与必要通知收入项目第三方清单。

## 4. Cline：区分插件、SDK 与 UI 包

Cline 当前仓库有独立 `@cline/ui`，不是只能抽取整个 Webview。官方 [采用说明](https://github.com/cline/cline/blob/1619168bdeb570aa233d0f0a9af1d332d83a2816/sdk/packages/ui/ADOPTION.md) 将聊天展示与宿主会话、传输、持久化分开；agent-chat 可在普通 CSS 中映射主题，不强制采用完整 Tailwind 主题。

本日 [npm Registry](https://registry.npmjs.org/@cline%2fui) 实查：

| 发布对象 | 已核对 | 使用限制 |
| --- | --- | --- |
| `latest`：0.1.0 | Apache-2.0；导出 agent-chat 与相应 CSS、theme 入口 | 可作为基础聊天展示探针；不假定具有主分支全部组件 |
| `next`：0.2.0-next.12 | 增加 root、Markdown、工具摘要等入口 | 预发布，不直接作为正式版默认依赖 |
| 主分支固定 SHA `1619168…` | 文档有更多组件，如 message-scroller | 主分支与已发布包导出并不完全一致，不能混作同一能力清单 |

官方 [UI README](https://github.com/cline/cline/blob/1619168bdeb570aa233d0f0a9af1d332d83a2816/sdk/packages/ui/README.md) 将 API 标为尚未稳定。完整 root 组件与 composer 涉及 Tailwind v4；独立 agent-chat 路径较轻。新的 message-scroller 还有 React 19/依赖补丁说明，不能凭现有 React 19 就判兼容通过。具体入口均按所选发布包验证。

Nodu 若采用，只取需要的消息展示和滚动行为，映射现有 token，不导入全局 reset、品牌字体、欢迎动画或另一套按钮。`@cline/sdk` 是 Agent 运行时，不是侧栏 UI；教学首期没有为了 UI 额外引入它的理由。

## 5. Continue 的维护状态与扩展兼容性

Continue 固定 SHA `5522c6f…` 的 [README](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/README.md) 自述仓库不再积极维护、只读。GitHub API 同日 `archived=false`，因此这里不称其为“GitHub 已归档”。README 的最终 2.0.0 与该 SHA 扩展清单版本不一致，不能混成已经核验的发行版本。

其 [VS Code 清单](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/vscode/package.json) 和 [GUI Webview 桥](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/vscode/src/ContinueGUIWebviewViewProvider.ts) 是参考材料；提取界面后仍需维护协议适配。Continue 和 Cline 主仓均声明 Apache-2.0，采用时固定具体版本并保留其必要通知。

Nodu 有 plugin-ext 不等于这些扩展全部可用。[Theia 官方兼容说明](https://theia-ide.org/docs/user_install_vscode_extensions/) 明确部分 VS Code API 可能仅为 stub；版本门槛与实际 Webview、凭证、原生模块和编辑器能力需要分开验证。

## 6. 无论选哪套都需要开发

- 教学 / 提问模式及独立草稿、教学状态恢复。
- 课程步骤、检查本步与证据失效。
- Monaco 高光、浮动批注、虚影跟写与可靠锚点。
- Enter / 离行 / 多行代码对应的逐行 AI 检查队列。
- 显示开关、暂停语义、迟到响应过滤。
- STM32 课程、编译 / 测试 / 运行来源关联。

## 7. UI 定稿后的最小选型验证

M0 使用假模型，不改正式应用默认功能。用同一份教学布局和消息样本，分别验证 Theia 1.76 聊天组件与 Cline UI 0.1.0 的受控复用；不把预发布独有能力当必要条件。

通过标准：现有 React/Monaco 不重复；无多余顶级入口；输入法、键盘、流式滚动、深浅主题可用；只读引用不出现源码应用按钮；显示与暂停状态可控；构建产物与依赖增量可记录；browser/Electron 均能打包。还需记录适配层代码量、升级表面与实际维护负担。

若两者都需大量绕过内部实现，则采用 Theia AI 核心加 Nodu 自定义薄 UI。UI 交互仍按评审稿实现，不随候选库默认设计变化。本轮仅输出这些验证方案，没有运行上述兼容试验。
