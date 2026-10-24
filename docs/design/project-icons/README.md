# Nodu 图标库 · 项目与芯片

源码素材位于 `desktop/scope-extension/style/project-icons/`，图标组件位于 `desktop/scope-extension/src/browser/nodu-project-icon.tsx`。SVG 随应用打包，支持离线和深浅主题。

| 用途 | 组件 / 样式 | 规格 |
| --- | --- | --- |
| 最近项目、示例项目 | `<ProjectIcon tag="STM32F103" />` | 40 px，厂商 Logo + 右下角型号 |
| 文件缺失 | `<ProjectIcon tag="STM32F103" missing />` | 保留型号，左上角警告 |
| 编辑器型号旁 | `<ChipMark tag="STM32F103C8T6" />` | 默认 18 px，`.nodu-chip-label` 内为 16 px |
| 通用芯片入口 | `.nodu-chip-entry-icon` / `chip.svg` | 24 px，四侧引脚、1.5 px 线宽 |
| 未指定芯片 | `<ChipMark />` | 通用芯片轮廓 |
| 状态栏型号 | `.nodu-chip-status` + 厂商类 | 16 px，仅表达项目目标 |

连接状态继续使用独立状态点，厂商 Logo 不表示设备已连接。型号文字已完整显示时不重复添加型号角标；小尺寸图标保留悬浮说明和无障碍标签。

工作台的最近项目与参考项目使用 `ProjectIcon`，新建项目型号旁使用 `ChipMark`。其余设备入口、工具栏和状态栏可按上表接入；图标存在不表示相应硬件流程已验收。

编译扩展后运行 `node docs/design/project-icons/build-preview.cjs` 更新 `index.html`。使用浏览器打开即可查看主题与尺寸对照。厂商素材来源见 `desktop/scope-extension/style/project-icons/README.md`。
