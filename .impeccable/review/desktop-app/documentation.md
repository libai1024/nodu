# 桌面 UI 文档记录

日期：2026-10-19。文档依据为当前 `desktop/` 源码、依赖配置、现有设计文件和主任务的 [verification.md](verification.md)。遵循 Impeccable `reference/document.md` 对既有设计记录的保留要求；本轮记录已有设计体系的桌面扩展。

## 更新文件

- [根 README](../../../README.md)：以真实 Theia / Electron 基座开头，提供桌面入口、能力边界和独立静态网站入口。
- [PRODUCT.md](../../../PRODUCT.md)：更新当前产品平台、实际能力和未实现项。
- [desktop/README.md](../../../desktop/README.md)：补齐最终右上角布局图标、普通编辑缓冲区中的参数修改及验收结论；保留 Node 24、安装和 ABI 切换说明。
- [docs/desktop-ui.md](../../../docs/desktop-ui.md)：记录源码职责、布局、状态、参数编辑、设计延续和范围差异。
- 本文件：记录文档处理范围与设计文件保留证据。

## 保留的设计基线

根 `DESIGN.md` 与 `.impeccable/design.json` 仍描述 `preview/dist/` 的静态网站与交互原型，没有将它们的行为、尺寸或能力声明自动提升为桌面规范。石墨 / 矿物青绿视觉语言继续使用。桌面真实编辑、文件系统、终端与双布局是新增产品范围，已单独记录；网站源码和用户编辑缓冲区未纳入文档修改。

本轮文档处理前后 SHA-256：

```text
d0ece81acb3897d1ac4448903d76c27b025ebb0b9a8a9294f0718b1041a25807  DESIGN.md
85169450c090e1f3bd54f86d1ccd42846d154c1eeeefe8edcb10da451216d60d  .impeccable/design.json
```

## 事实边界与图像来源

文档明确区分实际 Theia 文件操作、终端和编辑器，与 `ScopeSession` 的合成播放和 LAB 元数据过滤。“预览参数变更”修改唯一 `GREEN` 元组的未保存缓冲区，可撤销且须手动保存；它没有独立差异面板。硬件始终未连接，串口、REPL、烧录、KPU、K210 仿真和 DACIR 均未实现。

当前布局入口是在运行按钮之后的单个灰色图标，动态名称表达将切换到的模式，提示文字表达当前模式。简洁与专业共享文件缓冲区，切换分别收起或展开左侧与底部区域。没有把旧分段模式按钮写入当前使用说明。

`artifacts/ui-v3/` 为 AI 概念图，来源和提示词随图保存。实际截图的本次文件尺寸读取如下；这些是图像像素尺寸，不是视口测量值：

| 文件 | 像素尺寸 | 用途 |
| --- | --- | --- |
| `simple-1440.jpg` | 1441 × 1000 | 简洁布局与最终图标 |
| `pro-1440.jpg` | 1441 × 1000 | 专业布局与最终图标 |
| `devices-1280.jpg` | 942 × 876 | 设备未连接与本地样本 |
| `terminal-check.jpg` | 942 × 876 | 真实终端命令与结果 |
| `native-macos.png` | 3040 × 1920 | macOS 原生窗口的历史运行证据；早于最终图标调整 |

构建、交互检查及原生窗口保留原因链接到 [verification.md](verification.md)，未重复发起测试或操作用户缓冲区。本文不作独立 UI 审阅裁决；裁决由 [finish-review.md](finish-review.md) 记录。
