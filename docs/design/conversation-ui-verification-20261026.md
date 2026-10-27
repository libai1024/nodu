# 会话 UI 改版验收

日期：2026-10-26。基线：`codex/nodu-02-integration`，HEAD `ba63cd6bac3ce1aafed17ce5c56b61bd2b8c8a44` 加本轮未提交改动。

## 验收结论

**本轮会话 UI 改版通过本地验收。** TypeScript、AI 回归、工作台回归和 Electron 开发构建通过；深浅色宽窄面板已做实际视觉检查；正式桌面运行中验证了重命名、归档、重载恢复及草稿保留。

这不等于新安装包发布，也不等于完整 Agent 功能验收。未提交、未推送、未重打 DMG/ZIP；未执行板端编译、烧录或硬件测试。

## 交付范围

- 会话短标题显示，优先自定义名称，再从问题首句、草稿或引用文件回退。
- 本地重命名，保留完整可编辑名称；标题脱敏和输入校验。
- 可恢复归档；归档不删除消息、草稿或引用，归档中的当前对话仍可阅读和恢复。
- 列表双行信息、相对时间、草稿/回复失败/已停止/正在回复状态。
- 搜索提示、空结果、模式筛选、独立行管理菜单。
- 键盘导航、重命名弹层焦点、中文输入法 Enter 保护。
- 旧 schema 1 会话兼容，跨窗口元信息保护与保存失败重试。

保留教学、硬件工具栏和现有 composer，不增加没有真实执行能力的 Agent/Review/账号界面。

## 自动化与构建

使用 Node 24 执行当前工作树：

| 项目 | 命令 | 结果 |
|---|---|---|
| TypeScript + AI 回归 | `npm --prefix desktop/scope-extension run test:tutor` | 367/367，0 失败、0 跳过 |
| 工作台回归 | `npm --prefix desktop/scope-extension run test:workbench` | 112/112，0 失败、0 跳过 |
| Electron 开发构建 | `npm --prefix desktop/electron-app run build` | browser/node/electron 三阶段均 0 errors |
| 代码格式边界 | `git diff --check` | 通过 |
| 独立组件样例 | `node desktop/scripts/conversation-review/build.cjs /tmp/nodu-conversation-review-20261025` | 构建成功 |

两个测试集存在重叠，不把 367 与 112 相加作为独立用例数量。

本地完整输出：
- [AI 测试日志](conversation-ui-acceptance-20261026/tutor-tests.log)
- [工作台测试日志](conversation-ui-acceptance-20261026/workbench-tests.log)
- [Electron 构建日志](conversation-ui-acceptance-20261026/electron-build.log)
- [可追踪结果与构建指纹](conversation-ui-acceptance-20261026/results.json)

`*.log` 被仓库现有规则忽略；摘要和 SHA-256 留在 results.json。最终桌面前端构建时间为 2026-10-26 16:13:14 +08:00；其后只调整验收启动场景及文档，没有改产品实现。

## 视觉验收矩阵

使用真实 `TutorPanel`、`ChatHeader`、`ConversationSidebar` 和正式主题 tokens/CSS。组件样例的数据为本地内存样例，不是在线模型回复；发送函数拒绝调用。

| 主题/宽度 | 验证内容 | 结果 |
|---|---|---|
| 浅色 620px | 420px 聊天 + 200px 列表、代码块、草稿、选中态 | 通过 |
| 浅色 460px | 260px 聊天 + 200px 列表、长标题、换行、发送区 | 通过 |
| 深色 460px | 正文/次要文字、代码块、菜单及重命名弹层 | 通过 |
| 深色 620px | 最终独立进程确定场景、列表与消息层级 | 通过 |
| 正式桌面浅色 | 真实本地草稿、标题、搜索框、归档按钮、恢复后的列表 | 通过 |

DOM 实测：浅色 620px、浅色 460px、深色 460px 的聊天和面板 `scrollWidth - clientWidth` 均为 0；列表宽度均为 200px。代码块内部横向滚动是预期行为，不计为整体溢出。

现场截图由 Computer Use 返回并已显示在会话内，没有伪造本地 PNG 文件。证据编号不是文件路径：

- 浅色宽栏：`frame-d4f26ebd`
- 浅色窄栏：`frame-0e646919`
- 深色窄栏：`frame-025c5231`
- 深色重命名：`frame-808721c8`
- 最终深色宽栏：`frame-24c24630`
- 正式桌面重载后恢复归档：`frame-1c66383e`

浏览器截图接口连续超时，因此视觉验收采用原生 Electron 窗口截图；浏览器用于 DOM/布局测量及搜索交互。某些原生捕获出现无障碍树与图片不同步，未将不一致的帧算作成功证据，最终深色宽栏另起确定场景复核。

## 实际交互验收

### 真实组件隔离样例

1. 从会话行打开管理菜单，当前聊天没有被误切换。
2. 重命名为“USART1 串口教学”；标题和列表更新，原消息与“继续解释发送缓冲区的生命周期”草稿保留。
3. 归档当前会话；默认列表隐藏该条目，聊天中出现“此对话已归档”和恢复入口。
4. 在归档列表找到同一条会话并恢复；名称、消息、草稿保留。
5. 忙态样例下新建、切换模式、列表切换和行管理均禁用，composer 保持可编辑并显示停止。
6. 浏览器输入“DMA”只留下匹配对话；输入不存在的文本显示“没有匹配的对话”，教学草稿保持不变。

### 最终完整桌面构建

隔离工程：`/tmp/nodu-ui-acceptance-20261026/project`；隔离 Electron profile：`/tmp/nodu-ui-acceptance-20261026/profile`；端口 24372。

1. 启动最新 Electron bundle，切换专业模式并展开 AI 会话列表。
2. 输入“验收草稿：串口初始化，不发送”，不点击发送。
3. 从行管理菜单重命名为“串口验收 A”；UI 确认名称更新，草稿原文保留，焦点回到搜索框。
4. 归档当前对话；UI 确认列表隐藏该条目、当前对话显示归档提示、草稿仍在，焦点回到搜索框。
5. 通过应用命令面板执行“重新加载窗口”；无源文件保存提示。
6. 重载后确认名称仍为“串口验收 A”、归档标记仍在、草稿原文完全恢复、列表展开状态保留。
7. 点击“恢复对话”，重新显示该会话条目；草稿仍在，最终截图确认。

后续观察时，完整桌面窗口出现了额外的用户消息和不同草稿内容，不能再作为未干扰基线继续验证。主线程随即停止操作该窗口，未清理或覆盖其内容；剩余搜索检查在拒绝模型请求的组件样例中完成。测试轨迹没有调用发送、编译、烧录或硬件控制，但不据此声称该窗口整个存活期间绝无外部活动。

## 本轮发现与修复

| 问题 | 修复及证据 |
|---|---|
| localStorage 写入失败时 metadata 操作正常返回 | 检查 `historyStorageError`，保留 memory 并通知界面，返回可重试错误；存储/model 回归通过 |
| 归档后行按钮消失，焦点缺少落点 | 成功操作回调将焦点移回列表搜索框；正式桌面无障碍状态 `s-180` 确认 focused |
| 中文输入法确认名称可能触发表单提交 | 拦截 composing / keyCode 229 的 Enter；专门回归通过 |
| 新空会话没有持久记录却展示可执行管理 | 检查 `canManageActiveConversation`，未有内容时显示管理提示 |
| 验收记录任务 ID 不符合校验器 | 使用 `task-*` 稳定 ID，并按实际证据回填 |

新增 UI handler 测试覆盖完整名称、成功回调、失败保留弹层、stale busy/loading/workspace 拒绝、IME 和取消；原列表键盘导航与草稿保护测试继续通过。

## 复现方式

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH node desktop/scripts/conversation-review/build.cjs /tmp/nodu-conversation-review
# 独立原生样例：参数最后两项可为 light/dark、460/620。
<electron-executable> desktop/scripts/conversation-review/main.cjs /tmp/nodu-conversation-review dark 620
```

现有本地预览：[会话界面验收](http://127.0.0.1:24371/)。该页面使用隔离样例数据，不是用户工程。

## 验收边界

- macOS arm64 本地开发构建；未验收 Windows/Linux/安装包更新。
- 不宣称 Cursor 像素级复刻；没有多标签 Agent、工具执行器、审批或 Review 变更集。
- 没有删除真实聊天，没有改写原 release-final-f103 工程，本轮未做 Git 提交或推送。
- 独立审查子代理因供应商并发限制未完成，未把它记作通过；最终门禁由主线程测试与 GUI 证据完成。并发子代理未超过 2 个。
