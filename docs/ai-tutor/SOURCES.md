# 核查来源与选型依据

核查日期：2026-10-23。当前仓库基线 `1209ffd`。以下区分已读源码、上游能力与本项目拟议设计；本轮没有安装或运行新增 AI/Rust 依赖，没有调用真实模型。

## 本地依据

| 文件 | 核对结论 |
| --- | --- |
| [历史教学设计](../0.2/AI-TUTOR-DESIGN.md) | 自顶而下计划、L0–L3、只读 Agent、contract、T1–T4 是继承基础；板卡假设与现状描述需要更新 |
| [历史 Agent 调研](../0.2/TEACHING-AGENT-RESEARCH.md) | 采用 Theia AI 基础，不默认引入 ai-ide；项目资料不能升级工具权限 |
| [计划类型](../../desktop/scope-extension/src/common/nodu-tutor-plan.ts) | schema1，board 字段，条件目前是 type/text |
| [教学状态](../../desktop/scope-extension/src/browser/nodu-tutor-model.ts) | localStorage、人工 complete、按工程路径和 plan id 存状态 |
| [教学界面](../../desktop/scope-extension/src/browser/nodu-tutor-widget.tsx) | 右栏、首次打开、目前仍有中点文案与多层标题 |
| [编辑器提示](../../desktop/scope-extension/src/browser/nodu-tutor-hints.ts) | overlay + view zone，TODO 锚点，普通可撤销编辑插入标记 |
| [品牌 token](../../desktop/scope-extension/src/browser/nodu-brand.ts) | 原型沿用深浅色、Nodu 蓝、字号与现有代码字体 |
| [前端模块](../../desktop/scope-extension/src/browser/scope-frontend-module.ts) | 当前 DI 注册入口 |
| [后端模块](../../desktop/scope-extension/src/node/nodu-backend-module.ts) | RPC facade 白名单模式可以复用 |
| [embedded 桥](../../desktop/scope-extension/src/node/nodu-embedded-server.ts) | 现有 sidecar 延迟启动和事件发布；教学需新增只读订阅桥 |
| [构建](../../desktop/native/crates/nodu-embedded/src/build.rs) | buildId/inputDigest/bundleSha256 与 stale 已有 |
| [串口](../../desktop/native/crates/nodu-embedded/src/monitor.rs) | monitor.data 当前只有 port/data，尚未带完整证据身份 |
| [前端运行](../../desktop/scope-extension/src/browser/nodu-embedded-model.ts) | 运行分隔行用于显示，不能等同服务端采集证据 |
| [Rust workspace](../../desktop/native/Cargo.toml) | 复用 serde/sha2/ts-rs/proptest；工具链 1.98.1 |
| [桌面包](../../desktop/electron-app/package.json)、[浏览器包](../../desktop/browser-app/package.json) | Theia 1.76.0，已有 plugin-ext；尚无 ai-* |
| [F407 验证](../0.2.1/0.2.1.1-REVIEW-2026-10-23.md) | 真实双探针下载通过；F407 UART/ISP 并未因此通过 |
| [DACIR 同步设计](../design/DACIR-TEMPLATE-SYNC-2026-10-23.md) | 可参考签名版本缓存思路，不复用模板仓库作为课程自动信任来源 |

## 官方资料

| 来源 | 支持的选择 | 限制 |
| --- | --- | --- |
| [ai-core 1.76.0](https://raw.githubusercontent.com/eclipse-theia/theia/v1.76.0/packages/ai-core/package.json)、[ai-chat 1.76.0](https://raw.githubusercontent.com/eclipse-theia/theia/v1.76.0/packages/ai-chat/package.json) | 与现有 Theia 固定同版本集成 | 包清单存在不代表依赖已安装/打包通过 |
| [Theia Agent 接口](https://raw.githubusercontent.com/eclipse-theia/theia/v1.76.0/packages/ai-core/src/common/agent.ts) | 自定义教学 Agent 与上下文 | Agent 声明不自动提供安全隔离 |
| [语言模型接口](https://raw.githubusercontent.com/eclipse-theia/theia/v1.76.0/packages/ai-core/src/common/language-model.ts) | 模型请求、取消、流、结构化输出 | 不同提供方仍需能力合同测试 |
| [ai-openai 清单](https://raw.githubusercontent.com/eclipse-theia/theia/v1.76.0/packages/ai-openai/package.json)、[Node 模型实现](https://raw.githubusercontent.com/eclipse-theia/theia/v1.76.0/packages/ai-openai/src/node/openai-language-model.ts) | 首个协议适配参考/复用 | 不默认启用全部提供方设置和服务器工具 |
| [ai-chat 前端模块](https://raw.githubusercontent.com/eclipse-theia/theia/v1.76.0/packages/ai-chat/src/browser/ai-chat-frontend-module.ts) | 会话服务与 Agent 注册 | 在 M0 验证默认贡献与自定义面板的边界 |
| [Tree-sitter 文档](https://tree-sitter.github.io/tree-sitter/using-parsers/)、[Rust Parser](https://docs.rs/tree-sitter/0.27.1/tree_sitter/struct.Parser.html)、[C grammar](https://docs.rs/tree-sitter-c/0.24.2/tree_sitter_c/) | C 语法解析和 Rust 接口候选 | 不证明宏展开、跨函数数据流或无阻塞 |
| [WASI SDK](https://github.com/WebAssembly/wasi-sdk)、[发布资产](https://github.com/WebAssembly/wasi-sdk/releases) | Clang + WASI sysroot 的受管工具链方向 | M4 必须核对具体平台资产和 digest；尚未锁定 release |
| [Unity](https://github.com/ThrowTheSwitch/Unity) | 轻量 C 单元测试，MIT | 不等同硬件模拟，也不防恶意成绩造假 |
| [Wasmtime 配置](https://docs.rs/wasmtime/50.0.0/wasmtime/struct.Config.html)、[WASI](https://docs.rs/wasmtime-wasi/50.0.0/wasmtime_wasi/)、[安全](https://docs.wasmtime.dev/security.html) | 资源限制与受限 Wasm 执行 | 宿主编译器不由 Wasm 沙箱保护；MSRV/签名/平台尚待验证 |
| [Ajv Schema 文档](https://ajv.js.org/json-schema.html) | 结构化计划/模型输出运行时校验 | schema 校验不能证明教学内容正确 |

这些来源用于技术选型。本方案的 UI、权限模型、数据结构、阈值、任务拆解和验收标准是本项目设计决定；不是上游默认行为或本次已测能力。发布前保存实际 lockfile、供应链摘要及许可证清单，不依赖滚动 latest 文档长期保证兼容。
