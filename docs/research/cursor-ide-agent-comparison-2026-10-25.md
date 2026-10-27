# Cursor IDE Agent：功能、交互、使用方法与 Nodu 逐项对照

研究日期：2026-10-25。

## 结论

Cursor IDE Agent 是能够自主检索、编辑文件、执行工具、依据结果继续工作的编程代理；Nodu 当前是具备工程上下文、对话历史、本地确定性检查和学习任务的嵌入式教学助手。两者的聊天外观已有不少重合，但执行主体、权限、变更审阅和任务完成的语义不同。

Nodu 不是“只差几个按钮就能成为 Cursor Agent”：当前模型网关明确不支持工具调用，后端聊天协议只提供文本回复与教学结果。更合适的判断是：**对话基础部分实现；教学能力有独立价值；通用工程 Agent 执行闭环尚未实现。**

本轮仅研究并新增此报告，没有修改产品代码、用户设置或分支，没有向 Cursor 发送模型任务，也没有重新运行 Nodu 测试。

## 1. 对照范围与证据边界

### 1.1 Nodu 基线

- 最新集成分支：`codex/nodu-02-integration`。
- 提交：`ba63cd6`，2026-10-25 12:27。
- 源码工作目录：`/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio`。
- 当前会话工作目录的 `codex/ai-tutor-foundation` 不是最新实现，本报告不以旧分支判断功能缺失。
- 仓库已有的 [43 项对话对照记录](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/docs/design/conversation-cursor-comparison-20261025.md) 用作本机观察的历史证据；本轮重新核对关键源码，未将旧文档中的“待升级”机械当作最新状态。

### 1.2 Cursor 范围

研究对象是 **IDE 编辑器内的 Agent 侧栏及本地执行能力**，不是把独立 Agents Window、Cloud Agents、CLI 都算作 IDE 的已验证行为。

- 本轮实际联网读取 Cursor 官方文档、帮助和 IDE 发布说明。概览、输入、权限、计划和审阅等关键内容还用浏览器读取页面正文交叉核对。
- 本地已有观察记录对应 Cursor **3.24.12**。本轮未重新操作原生 Cursor 验证全部交互。
- 官方 IDE 发布说明当前列到 **3.27**，但相关版本段落未提供发布日期；因此只表述为“检索时文档所列”，不据此推断本机已安装该版本。
- **3.25** 对会话栏行样式及运行中消息默认行为有调整，不能套用到 3.24.12 的实机截图。
- 某些官方索引返回 `.md` 链接，但对应地址实际 404；正文以成功读取的网页路径为依据。

### 1.3 状态用语

- **已有**：当前源码有对应逻辑，不意味着本轮重新做了端到端实测。
- **部分**：存在相似能力，但范围或语义不等价。
- **未实现**：当前 Nodu AI 链路没有该能力；不等于底层 Theia 完全没有通用编辑器功能。
- **有意不同**：教学产品的主动约束，不应简单视为缺陷。
- **待核实**：互联网材料或历史观察不足，不从外观推断。

## 2. 先把四个概念分开

1. **IDE 布局**：编辑器、工程树、终端、Agent 侧栏如何排列。IDE 中也可以有常驻 Agents 会话列表，并不专属于独立 Agents Window。
2. **任务模式**：Agent、Ask、Plan、Debug 等决定任务的处理方式。
3. **运行权限模式**：Auto-review、Allowlist、Run Everything 决定工具何时自动执行、何时需要审批。它与 Ask/Plan 等不是同一个选择器。
4. **模型选择**：决定由哪个模型处理任务，不自动赋予模型文件、终端或硬件操作权。

把“选了一个更强模型”“加了 Agent 模式菜单”“侧栏长得像 Cursor”当作已经实现代理，是本项目对齐时最需要避免的误区。

## 3. Cursor IDE 的功能与使用方式

### 3.1 主要任务模式

| 模式 | 使用目的 | 典型操作 | 与 Nodu 的关系 |
|---|---|---|---|
| Ask | 理解代码，不修改文件 | 打开侧栏，选 Ask，附带相关代码后提问 | Nodu 的“提问”方向一致，但没有模型自主工具检索 |
| Agent | 开发、重构、修复、测试 | 提出目标，由 Agent 读取、编辑、执行和验证 | Nodu 尚无通用 Agent 执行器 |
| Plan | 实施前澄清方案 | 研究工程、澄清问题、形成计划，用户修改后 Build | Nodu 教学计划确认不是自动实施计划 |
| Debug | 用运行时证据定位问题 | 提假设、插桩、要求复现、分析日志、修复、复验、清理插桩 | Nodu 有检查和设备观测，不具备此自动调试闭环 |
| Multitask | 并发推进适合独立处理的任务 | 官方帮助描述 `/multitask` 与计划中的 Build in Parallel | Nodu 无对应能力；不等于简单开多个聊天标签 |

依据：[Agent 帮助](https://cursor.com/help/ai-features/agent)、[Ask](https://cursor.com/help/ai-features/ask-mode)、[Plan](https://cursor.com/docs/agent/plan-mode)、[Debug](https://cursor.com/docs/agent/debug-mode)、[Multi-agent](https://cursor.com/help/ai-features/multi-agent)。

补充限制：官方 Agent 帮助称各模式使用独立上下文，切换会开始新的上下文窗口；不能承诺所有版本中切模式必然完整保留同一模型上下文。Nodu 则明确维护 teach/ask 两组消息和活动会话。具体“模式切换”和“会话身份”的产品设计应单独定义。

### 3.2 一次完整 Agent 任务怎么用

1. **打开工程及侧栏。** macOS 默认 `Cmd+I`，Windows/Linux 默认 `Ctrl+I`。需要先理解代码时选 Ask；需要实施时选 Agent；多文件或需求不清时先选 Plan。
2. **说明目标和验收条件。** 例如要求修复哪个行为、哪些文件不可改、必须通过哪些测试。知道相关文件时用 `@` 引用；不知道时可让 Agent 自主搜索。
3. **设置模型与权限。** 模型菜单作用于当前对话后续请求；全局默认模型另设。工具审批在 `Settings > Agents > Approvals & Execution` 配置。
4. **执行过程中查看真实活动。** Agent 根据工具输出继续读取、修改或运行命令，diff 会随修改出现。需要批准的操作停在审批处。
5. **方向不对时干预。** Stop 停止当前工作；运行中补充可排队或引导当前任务，但按键与默认行为要按版本和界面确认。
6. **审阅实际变更。** 普通工程文件修改会在 Agent 工作时直接应用，不能理解成一律等“接受”后才写入。用户在 diff 中检查并拒绝不需要的改动。
7. **验证并保留。** 执行测试、类型检查、lint，再人工审阅。检查点用于撤回 Agent 修改；Git 用于长期版本管理，两者不是替代关系。

### 3.3 Plan 和教学计划为什么不同

Cursor Plan 的目标是让 Agent 后续实施。计划可在聊天或 Markdown 中编辑，默认保存在主目录，也可 Save to workspace。Build 是进入实施的动作。

Nodu 的教学计划由学习者确认后开始跟写；程序定位源码、给出灰色范字，**学习者自己输入代码**，再由系统检查。这里的“开始跟写”不是“批准 AI 自动改整个工程”。

### 3.4 Debug 不是“把错误日志贴给 AI”

Cursor Debug 的官方流程包含：形成多个假设，修改代码加入日志采集，让用户按步骤复现，分析本地调试服务获得的日志，再做有针对性的修复、复验和移除插桩。

Nodu 的终端附件、静态检查、构建记录和串口观测是有用基础，但没有这套由代理组织的插桩与复验循环。它可以解释错误或辅助判断，不能标成已经拥有等价 Debug 模式。

## 4. 功能与交互逐项对照

### 4.1 入口、模式与会话管理

| # | 对照项 | Cursor IDE | Nodu `ba63cd6` | 判断 |
|---|---|---|---|---|
| 01 | 打开 AI 侧栏 | Cmd/Ctrl+I | 专业模式 AI 侧栏；Cmd/Ctrl+Shift+A | 已有，快捷键不同 |
| 02 | 常驻会话列表 | IDE 内可展开 Agents sidebar | 可折叠右侧列表，记住展开状态 | 已有 |
| 03 | 历史浮层 | 与常驻列表是不同入口 | 关闭常驻栏时显示紧凑历史浮层 | 已有 |
| 04 | 新建会话 | 本机记录支持独立会话标签 | 一个前台显示会话；空白时复用 | 部分 |
| 05 | 多标签、关闭再重开 | 本机记录关闭标签不等于删历史 | 没有单会话标签关闭/重开 | 未实现 |
| 06 | 当前项、日期、草稿 | 会话列表提供识别和导航 | 今天/昨天/日期、当前项、草稿标记 | 已有 |
| 07 | 搜索历史 | IDE 有历史选择器；全文范围不可与 Agents Window 混称 | 只匹配标题及最多 120 字预览 | 部分，非全文搜索 |
| 08 | 重命名、置顶 | 本机历史记录确认菜单入口 | 无对应操作及持久字段 | 未实现 |
| 09 | 归档、恢复、删除 | 本机历史记录确认相关入口 | 只有清空当前对话 | 未实现，清空不是删除 |
| 10 | 导出对话 | 本机记录有 Export Transcript | 无导出操作 | 未实现 |
| 11 | 模式菜单 | Agent/Ask/Plan/Debug 等；具体集合随版本变化 | 只有教学/提问 | 有意不同且能力范围更窄 |
| 12 | 切模式后的状态 | 官方帮助称模式上下文独立 | teach/ask 消息、草稿、附件分别恢复 | 部分，不应强行等同 |
| 13 | 每会话模型 | 官方明确模型变更作用于当前对话后续 | 当前窗口选择，并保存为新窗口默认；未按会话保存 | 部分 |
| 14 | 持久保存 | 官方未披露可与 Nodu 对应的固定上限 | localStorage 缓存；该存储前缀下最多 40 条、约 3 MiB，旧项会淘汰 | 部分，非长期档案库 |

源码依据：N1、N2、N3、N4、N5。Cursor 管理菜单的证据来源是已有 3.24.12 实机记录，不代表本轮重新执行了归档或删除。

**版本提醒：**IDE 发布说明 3.25 将侧栏条目改为单行，搜索入口打开 history picker；不能把 3.24.12 的内嵌搜索或草稿摘要当作所有新版的固定规格。

### 4.2 输入、上下文与消息操作

| # | 对照项 | Cursor IDE / 官方说明 | Nodu `ba63cd6` | 判断 |
|---|---|---|---|---|
| 15 | Enter 与换行 | 输入提交；运行中规则另有版本差异 | Enter 发送、Shift+Enter 换行、中文组合态保护 | 已有基础行为 |
| 16 | `@` 候选 | 输入 @ 后出现来源与候选 | 普通 textarea；使用附件菜单 | 未实现真正的 @ |
| 17 | 文件与代码选区 | 文件引用、选区快捷发送 | 当前文件、工程选文件、选区、来源跳转 | 已有但格式受限 |
| 18 | 文件夹、Git、旧聊天、浏览器引用 | @ 支持相应来源 | 仅 file/selection/terminal 三类 | 未实现 |
| 19 | 自动找相关代码 | Agent 根据任务自主搜索、读文件 | 自动提供受限文件清单、关联头文件、芯片/SDK 等；无自主检索工具 | 部分，不能称完全无上下文 |
| 20 | 终端引用 | @Terminals 等入口 | 终端选区或添加时最近 200 行快照，脱敏 | 已有输入能力，不是执行权限 |
| 21 | 引用预算 | 随上下文与模型能力管理 | 当前文件与附件合计最多 6 项、64 KiB；支持类型受限 | 范围不同 |
| 22 | 发送时快照 | 本轮不推断 Cursor 所有附件的采样时机 | 保存本次发送内容快照和引用元信息 | 已有可追溯基础 |
| 23 | 图片粘贴、拖放 | 官方支持 | 无图片输入管道 | 未实现 |
| 24 | 语音输入 | 官方 Prompting 页描述麦克风与转写 | 无语音输入 | 未实现；具体 IDE 版本入口未实测 |
| 25 | 消息与代码块复制 | 消息、代码等可复制 | 整条消息、代码块复制及长代码折叠 | 已有基础行为 |
| 26 | 完整 Markdown | 支持丰富呈现，发布说明涉及表格 | 自定义有限语法；缺表格、标题、普通网页链接等 | 部分，部分限制出于安全 |
| 27 | 编辑旧消息重发 | 3.19 记录后续消息截断；必要时询问是否恢复文件 | “修改后再问”仅把文字放进草稿，不回退上下文或恢复原附件 | 不等价 |
| 28 | 从某消息分叉 | Fork Chat | 无显式用户分叉功能 | 未实现 |
| 29 | 当前对话内查找 | Cmd/Ctrl+F | 无专用查找实现 | 未实现 |
| 30 | 上下文用量 | 上下文圆环及分类详情，接近上限时压缩 | 无真实 token 用量及自动摘要 | 未实现 |
| 31 | 可见历史与模型记忆 | 通过上下文管理压缩旧内容 | 恢复只取完整普通问答，最多 12 条消息且约 16 KB；不会恢复所有附件 | 部分，界面历史不等于模型全记得 |

源码依据：N1、N4、N6、N7、N8。Cursor 输入与上下文依据 [Prompting](https://cursor.com/docs/agent/prompting)。

重要细节：Nodu 的跨窗口冲突保护可能在再次写入时复制会话，这不是用户主动选择某条消息执行 Fork Chat，不能用它宣称已经支持分叉交互。

### 4.3 执行、审批、验证与恢复

| # | 对照项 | Cursor IDE | Nodu `ba63cd6` | 判断 |
|---|---|---|---|---|
| 32 | 自主工具循环 | 搜索、读取、编辑、执行，依据输出继续 | 网关只做一次 completion，拒绝 tool_calls 等 | 核心缺口 |
| 33 | 自动多文件修改 | Agent 可直接修改工程文件 | 教学明确要求用户自己输入；普通对话只输出建议 | 未实现通用 Agent；教学有意限制 |
| 34 | 自动执行终端 | Agent 可调用 shell | 应用有终端，但模型没有执行工具 | 未接入 AI |
| 35 | 工具活动记录 | 展示实际读取、执行、结果等 | 只有生成计划、准备片段、检查等固定产品状态 | 部分，不可伪造工具轨迹 |
| 36 | 工具审批 | 本地 Run Modes、沙箱、审批卡 | 有工程授权与路径校验，无通用代理工具审批系统 | 未实现对应系统 |
| 37 | 运行中消息 | 支持排队或引导当前任务；版本和设置有差异 | 可写草稿，但生成中不发送、不排队 | 未实现 |
| 38 | 多任务后台运行 | 多代理/子代理可并行，需区分界面和隔离 | 生成期间禁新建和切会话；chat/review 两通道不等于多 Agent | 未实现 |
| 39 | 停止 | 停止当前代理任务，不自动撤回已落盘修改 | 取消当前请求、保留部分输出和草稿 | 已有，但停止对象不同 |
| 40 | 失败重试 | 代理任务继续/重试涉及工具状态；精确恢复点未核实 | 原快照重发普通聊天，检查代码/教学版本是否仍适用 | 部分，不是工具执行恢复 |
| 41 | 文件变更审阅 | 实时 diff；拒绝不需要的已应用改动 | 无 AI 变更集与 diff 接受/拒绝流程 | 未实现 |
| 42 | Checkpoint | 本地代码快照；恢复文件，不删除聊天 | 教学进度/草稿持久化，但无 Agent 文件检查点 | 未实现对应回滚 |
| 43 | 自动测试与修复迭代 | 代理可写测试、执行并继续修复 | 固定 AST/纯函数检查真实存在；全工程构建由用户操作 | 部分且执行机制不同 |
| 44 | 运行时调试闭环 | Debug 插桩、复现、日志、修复、复验 | 有构建/下载/串口观测与检查，无自主插桩循环 | 部分基础，模式未实现 |
| 45 | 工程差异代码审查 | Agent Review / @Branch；PR 的 Bugbot 是另一层 | 单行/片段/教学步骤评价，不是全分支变更审查 | 不等价 |
| 46 | Rules / AGENTS.md | 可加载作用域指导；不是安全隔离 | 有固定系统提示与教学策略，无等价用户规则发现链路 | 未实现对应扩展机制 |
| 47 | Skills 与 `/` | 可按需加载或显式调用技能 | 无技能发现、选择、执行管道 | 未实现 |
| 48 | MCP | Agent 可访问外部工具，受审批策略控制 | 模型网关没有 MCP 工具调用链 | 未实现 |
| 49 | 子代理 | 主代理委派，独立上下文，结果回到主会话 | 无模型驱动的子任务编排器 | 未实现 |
| 50 | 联网、浏览器验证、图像生成 | 官方 Agent 文档有相应工具 | 本项目 AI 当前没有这些工具 | 未实现；不指开发时所用的 ZCode 工具 |
| 51 | 嵌入式实物证据 | 通用 Agent 需另接工具和工程规范 | 已区分静态、构建、下载、串口；关联工程与固件标识 | Nodu 专项基础 |
| 52 | 学习者跟写 | 不是本轮核实的 Cursor 原生教学流程 | 范字、定位、逐行检查、暂停、任务步骤 | Nodu 差异化能力 |

源码依据：N7、N9、N10、N11、N12、N13。**IDE 自身能编译或烧录，不代表 AI 能自主调用该能力。**同样，本报告使用的浏览器/文件工具不属于 Nodu 产品的已有功能。

## 5. 三组必须分开的交互语义

### 5.1 停止、编辑重发、分叉、恢复检查点

它们不是同一个“撤销”按钮：

- **停止**：终止正在进行的生成或任务；已发生的文件修改不因此自动消失。
- **编辑旧消息重发**：改变对话分支的起点。Cursor 3.19 的说明明确后续消息会移除，文件则可按提示选择恢复或保留。
- **分叉**：从某个位置建立新对话，保留原对话。
- **恢复检查点**：恢复代码文件状态，官方说明不会删除聊天消息。

Nodu 当前只有停止、普通请求重试、草稿回填和清空聊天。把这些菜单改名，不能替代对话截断、文件版本和回滚逻辑。

### 5.2 “开始跟写”与“批准执行”

Nodu 的目标确认只是进入教学状态；学习者仍需编写代码。本地检查通过不等于模型完成了工程修改，更不等于硬件成功运行。

如果后续增加工程 Agent，建议将其与教学保持独立：

- 提问：解释和只读研究。
- 教学：学习者输入，AI 指导和检查。
- 工程 Agent：在明确授权下修改文件、构建和验证。

这是产品建议，不是当前已实现模式。

### 5.3 会话、教学任务、运行实例

当前 Nodu 教学任务有独立状态，新建/清空聊天不会自动等价于删除教学任务。这一点应保留。

若扩展 Agent，建议分别定义会话 ID、任务 ID 和一次执行的 run ID。否则生成中切换会话、审批旧操作、取消某个请求时容易误伤另一项任务。

## 6. Cursor 权限体系：对照本项目时最重要的部分

以检索到的 [Run Modes 专门页](https://cursor.com/docs/agent/security/run-modes) 为准，而不是沿用旧安全概览的默认描述。

### 6.1 当前三种运行模式

| 模式 | 核心行为 |
|---|---|
| Auto-review | 允许列表直接执行；其他 shell 尽量在沙箱中运行；不走沙箱的调用交分类器审查，必要时询问用户 |
| Allowlist | 允许列表中的操作免确认；可启用 shell 沙箱；不使用 Auto-review 分类器 |
| Run Everything | 自动执行工具，不使用上述沙箱与分类器流程；风险最高 |

专门页的版本记录说明：3.5 已弃用面向新用户的 Ask Every Time；空 Allowlist 可实现类似行为。3.6 将 Auto-review 作为推荐默认。文件删除、外部文件和浏览器等附加保护可另外要求批准，不能把 Run Everything 理解为取消所有保护。

### 6.2 三个不同的边界

- `permissions.json`：影响自动审批判断；用户级和项目级可以合并，团队策略可覆盖。
- `sandbox.json`：限制沙箱命令能触达的路径、网络和资源，不等于提示词规则。
- Read Access：专门页明确 System 是默认，可读工作区外；Workspace 则要求越界读取审批或命中允许列表。不能说 Cursor 默认始终只读当前项目。

Auto-review 分类器可能误判，官方明确它不是安全边界。Rules 同样不能代替后端强制权限。

### 6.3 对 Nodu 的含义

Nodu 现有路径/工程授权比“模型自由读整个系统”更收敛；其纯函数检查也禁止宿主导入、文件、网络等能力。但这些是特定功能的保护，不是完整通用 Agent 沙箱。

对嵌入式产品，更适合的执行分级是：只读研究、补丁预览、授权应用、受限构建，然后才是单独授权的设备操作。烧录涉及目标板 UID、固件摘要、下载方式和擦除范围，应绑定明确证据，不宜照搬宽泛的自动执行开关。此为建议，不是现有实现。

## 7. 用同一项任务看真实差别

### 任务：修复 F103 工程的串口输出问题

**在 Cursor IDE：**

1. 打开工程，以 Ask/Plan 查看现状，引用 `main.c`、串口封装头文件和构建日志。
2. 明确“只修改工程代码并验证构建；不要烧录、复位或操作串口”。
3. Plan 中审阅实现方案，确认后 Build，或直接用 Agent 执行清晰的小任务。
4. Agent 搜索声明、编辑相关文件、调用构建命令，根据真实报错继续修复。
5. 用户查看 diff、测试输出；必要时拒绝修改或恢复检查点。
6. 真板验证单独进行。通用代码 Agent 不应从编译成功推断硬件通过。

**在当前 Nodu：**

1. 切换专业模式，打开 AI，配置模型并选择“提问”或“教学”。
2. 从附件菜单引用当前文件、代码选区和终端输出；没有 `@` 候选。
3. 提问模式得到解释；教学模式得到待确认计划，点击“开始跟写”。
4. 根据源码定位与灰色范字自己输入代码，通过行/片段检查获取反馈。
5. 用户点击 IDE 的编译操作，再按自己的授权操作烧录和串口。
6. AI 可利用与当前保存内容相匹配的构建记录或运行观测继续分析，但不会自主调用编译、烧录或终端来完成整项修复。

**差别不在回复长短，而在谁负责执行、谁掌握权限、如何证明结果。**

## 8. 本项目的改进判断（不是实施承诺）

### 优先级一：先修正“看起来支持、实际语义不同”的地方

- 明确历史搜索不是全文搜索，模型记忆不等于全部可见历史。
- 为长期会话建设可靠存储，避免把最多 40 条/3 MiB 的缓存当永久档案。
- 区分会话模型与窗口默认模型。
- 保留“修改后再问”的准确名字；若做真正编辑重发，必须同步原附件、历史截断和后端上下文。
- 继续保留聊天与教学任务的独立生命周期。

### 优先级二：完善输入和会话工作流

真正的 @ 选择、会话内查找、重命名/置顶/归档/恢复/导出、显式分叉、完整安全 Markdown，都应接入真实数据状态，不能只补菜单。

### 优先级三：单独建设最小工程 Agent

最小有意义的闭环是：自主只读检索、提出补丁、查看差异、确认应用、运行受限验证、返回真实结果。必要基础包括工具协议、执行器、类型化事件、审批、文件版本冲突保护、取消和恢复。

队列、跨会话运行和多代理并行应建立在每个 run 能正确归属、独立停止之后。设备操作更后置，并保留教学模式不自动替学习者写代码的原则。

## 9. Nodu 关键源码索引

下列引用均为最新集成工作目录中的文件；行号以 `ba63cd6` 为准。

- **N1 — 侧栏与输入：** [nodu-tutor-widget.tsx:69](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/browser/nodu-tutor-widget.tsx:69)。发送拦截、模式与模型、输入、停止、常驻会话栏；计划确认在第 17–27 行。
- **N2 — 头部和模型菜单：** [nodu-tutor-chat-controls.tsx:59](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/browser/nodu-tutor-chat-controls.tsx:59)。只有 teach/ask；新建、历史、清空、侧栏开关在第 112–131 行。
- **N3 — 会话列表：** [nodu-tutor-history.tsx:14](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/browser/nodu-tutor-history.tsx:14)。标题/预览搜索；常驻栏在第 60–125 行。
- **N4 — 存储和记忆：** [tutor-conversation.ts:36](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/common/tutor/tutor-conversation.ts:36)。模型历史裁剪在第 48–57 行；持久化上限/淘汰在第 128–176 行。
- **N5 — RPC 与模型范围：** [tutor-ai-protocol.ts:9](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/common/tutor/tutor-ai-protocol.ts:9)。只有 teach/ask；第 44–45 行明确窗口选择与新窗口默认；无通用工具事件协议。
- **N6 — 附件类型和限制：** [tutor-context.ts:4](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/common/tutor/tutor-context.ts:4)，[nodu-tutor-context-picker.tsx:113](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/browser/nodu-tutor-context-picker.tsx:113)。
- **N7 — 工程上下文：** [tutor-workspace-host.ts:108](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/node/tutor/tutor-workspace-host.ts:108)。文件清单、头文件、MCU/SDK、构建与真实检查数据，不是模型自主搜索。
- **N8 — 消息和会话动作：** [nodu-tutor-model.ts:482](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/browser/nodu-tutor-model.ts:482)。终端快照；新建/选择在第 560–581 行；重试/回填在第 591–610 行。[nodu-tutor-messages.tsx:47](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/browser/nodu-tutor-messages.tsx:47) 为有限 Markdown。
- **N9 — 网关核心边界：** [tutor-model-gateway.ts:81](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/node/tutor/tutor-model-gateway.ts:81)。拒绝三种协议的工具内容；第 168 行明确无工具、自动重试或端点回退。
- **N10 — 对话后端：** [tutor-chat-session.ts:60](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/node/tutor/tutor-chat-session.ts:60)。无可执行工具；第 13–15 行区分静态反馈与真机，第 136 行进行一次模型完成调用。
- **N11 — 教学任务：** [nodu-tutor-task-window.tsx:18](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/browser/nodu-tutor-task-window.tsx:18)，[tutor-goal-session.ts:11](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/node/tutor/tutor-goal-session.ts:11)。学习者输入、计划和检查，不执行模型工具。
- **N12 — 本地确定性检查：** [tutor-pure-runner.ts:54](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/node/tutor/tutor-pure-runner.ts:54)。受限纯函数编译执行，不是开放 shell。
- **N13 — 硬件观测：** [tutor-runtime-evidence.ts:6](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/node/tutor/tutor-runtime-evidence.ts:6)。只收集观测，不控制设备；绑定固件、运行和用户选择的串口。
- **N14 — 快捷键：** [nodu-tutor-hints.ts:500](/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio/desktop/scope-extension/src/browser/nodu-tutor-hints.ts:500)。代码/终端选区 Cmd/Ctrl+Alt+L；侧栏 Cmd/Ctrl+Shift+A；检查 Cmd/Ctrl+Alt+Enter。

## 10. 官方来源与冲突处理

1. [Agent overview](https://cursor.com/docs/agent/overview)：工具、检查点、排队与各界面的运行中补充、会话查找。
2. [Agent mode help](https://cursor.com/help/ai-features/agent)：IDE 入口、选区快捷键、模式、修改直接应用、恢复检查点。
3. [Ask mode](https://cursor.com/help/ai-features/ask-mode)：只读问答与模式入口。
4. [Prompting agents](https://cursor.com/docs/agent/prompting)：@、图片、语音、模型、上下文管理；新版 Custom Modes 明确写 Agents Window/CLI，不将其算作已验证的 IDE 功能。
5. [Plan mode](https://cursor.com/docs/agent/plan-mode)：计划创建、编辑、存储和实施。
6. [Debug mode](https://cursor.com/docs/agent/debug-mode)：插桩、复现、日志、修复和清理。
7. [Run Modes](https://cursor.com/docs/agent/security/run-modes)：当前本地工具运行权限、沙箱、读取边界与模式变更记录。
8. [Agent security overview](https://cursor.com/docs/agent/security)：文件直接落盘、提示注入风险等；默认运行模式的旧描述不覆盖专门页的新版本记录。
9. [Terminal tool](https://cursor.com/docs/agent/tools/terminal)：执行与 Run Modes/沙箱的关系；未从此页推断 shell 的所有生命周期细节。
10. [Reviewing and testing](https://cursor.com/learn/reviewing-testing)：实时 diff、Review/Find Issues、测试与人工审查。
11. [Agent Review](https://cursor.com/docs/agent/agent-review)：专门审查入口。与 Learn 页入口描述不同，且自动触发时机表述不一致；不在本报告承诺统一自动审查时点。
12. [Rules](https://cursor.com/docs/rules)：用户/项目/AGENTS.md 与作用域。
13. [Skills](https://cursor.com/docs/skills)：自动或显式技能调用。
14. [MCP](https://cursor.com/docs/mcp)：外部工具与审批。
15. [Subagents](https://cursor.com/docs/subagents)：委派、上下文与权限；上下文独立不等于工作树隔离。
16. [Multi-agent](https://cursor.com/help/ai-features/multi-agent)：Multitask、并行构建与独立 Agents Window 的边界。
17. [IDE release notes](https://prod.cursor.com/docs/release-notes/ide)：3.19 的旧消息编辑/分叉、3.25 的侧栏和运行中引导行为。

### 两处不能照抄旧教程的细节

- **运行中 Enter 的含义：**概览页保留 Enter 排队、Cmd+Enter 立即发送的说明；同页明确某些“双击 Enter / Tab 排队”行为属于网页/Agents Window，CLI 又不同。IDE 3.25 发布说明则称新安装默认引导当前任务，已有安装保留原设置。使用时应核对版本和设置，不能给所有用户一个绝对按键结论。
- **默认审批模式：**安全概览仍有默认逐次批准的描述，Run Modes 专门页有明确版本变更记录。当前功能说明采用专门页的 Auto-review / Allowlist / Run Everything，不把已弃用的 Ask Every Time 当作所有新安装仍可选的模式。

## 最终判断

本项目最值得对齐 Cursor 的是“任务有明确对象、操作有真实记录、修改可审阅、执行可停止、结果有证据”的工作方式，而不是照搬全部菜单。Nodu 应继续保留教学中学习者自己编写代码、静态反馈与硬件证据分开表达的特点；若增加工程 Agent，应作为有独立权限和执行基础的新能力建设。
