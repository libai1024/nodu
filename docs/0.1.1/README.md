# Nodu 0.1.1 文档

2026-10-19 开发基线。请先读[交接文档](HANDOFF.md)与[版本说明](RELEASE.md)。旧研究与分阶段审查保留当时结论；当前实现状态以交接、新精简 UI 验收和第五次硬件记录为准。

| 内容 | 文档 |
| --- | --- |
| 接手与未完成事项 | [HANDOFF.md](HANDOFF.md) |
| 本版变更与已知限制 | [RELEASE.md](RELEASE.md) |
| 环境、构建与启动 | [GETTING_STARTED.md](GETTING_STARTED.md) |
| 产品范围与设计 | [PRODUCT.md](PRODUCT.md)、[DESIGN.md](DESIGN.md)、[桌面 UI](desktop-ui.md) |
| 功能对照与框架选型 | [功能基线](feature-baseline.md)、[Electron 框架](electron-framework-evaluation.md) |
| 设备接口与容量 | [设备复用](device-reuse.md)、[容量边界](device-capacity-status.md)、[烧写计划](device-flash-plan.md) |
| 相机与示例 | [相机诊断](camera-ide-diagnosis.md) |
| 当前硬件结果 | [探针执行计划](flash-probe-execution-plan.md)、[集成审查](flash-probe-integration-review.md) |
| 源码与协议审查 | [当前固件接口](current-firmware-id-audit.md)、[官方 ISP](automatic-flash-source-audit.md)、[host](flash-probe-host-review.md)、[target](flash-probe-target-review.md) |
| 构建、许可与原件保全 | [运行库](flash-probe-runtime-audit.md)、[许可](device-flash-probe-license.md)、[状态保全](flash-probe-state-preservation.md)、[执行前复审](flash-probe-preexecution-review.md) |
| 品牌与概念图研究 | [名称](brand-name-research.md)、[界面简报](surface-brief.md)、[提示词](image-prompts.md) |

验收证据继续位于仓库 `artifacts/` 和 `.impeccable/review/`，通过相对链接引用。原始 UI 文本、日志与板端私有备份仅本地保留。工具目录中的冻结审查材料留在原路径，避免改变已固定的摘要和构建输入。
