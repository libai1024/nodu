# Nodu AI 辅助教学实施方案

2026-10-23。设计分支：`codex/ai-tutor-design`；开发分支：`codex/ai-tutor-foundation`；C 功能基线：`1209ffd`。

已按用户要求开始实施：完成 M0 隔离探针、课程 Schema 2 与迁移基础模块；存储模块尚未接产品入口。真实 AI、双模式侧栏与代码虚影仍待后续阶段。具体已完成范围和复测命令以[开发记录](DEVELOPMENT.md)为准；设计稿中的模拟效果不代表产品能力。

- [完整 UI 评审方案](UI-PROPOSAL.md)：先读这一份，包含推荐布局、两模式、辅助功能及待共同确定的取舍。
- [开源侧边栏复用选型](OPEN-SOURCE.md)：Theia AI、Cline UI 与完整插件的能力和适配边界。
- [教学交互设计](INTERACTION-DESIGN.md)：教学/提问双模式、高光批注、步骤浮窗与 AI 快速开关。
- [代码虚影跟写与逐行 AI 检查](LINE-GUIDANCE.md)：最新交互要求，默认展示代码，完成一行自动检查一行。
- [完整实施方案](IMPLEMENTATION.md)：产品边界、UI、前端、Node 后端、Rust、证据链、模型、课程及验收。
- [路线图](ROADMAP.md)：阶段、任务、依赖、估算和发布门槛。
- [任务清单](roadmap.csv)：可用于后续开发跟踪。
- [交互设计稿](ui-prototype.html)：可体验教学/提问、代码高光批注、虚影跟写、步骤浮窗与 AI 快速开关；静态示例，不连接模型或设备。
- [调研来源](SOURCES.md)：本地证据与官方资料，区分已实现与设计建议。
- [设计检查记录](DESIGN-REVIEW.md)：文档和原型检查结果，实施风险。
- [开发记录](DEVELOPMENT.md)：本轮代码、测试、限制及下一批交付。
- [Rust 与 WASI 探针](M0-RUST-PROBE.md)：真实 C AST、类型生成、CRC 正反例和平台缺口。
- [AI 与聊天组件探针](M0-AI-PROBE.md)：受控 Provider、组件复用和依赖选择。

推荐顺序：先修正 T1 的计划、状态和界面，建立本地检查与运行证据，再接入只读教学 Agent；课程生成与教师平台后置。首个闭环以 STM32F103C8T6 为主，F407 做移植验证，不以特定开发板作为工程入口。
