# Nodu 0.1.2 交接

日期：2026-10-19。产品 **Nodu · 见微**，主色 `#4F7CFF`，面向嵌入式初学者。本版为 0.1.1 之上的简洁模式 UI 修订；未变内容直接引用 0.1.1，不重复正文。

## 当前状态

| 项目 | 状态 |
| --- | --- |
| 精简模式 UI 修订 | 已完成，4195 隔离实例 + K210 硬件验收 |
| K210 REPL、RAM 运行 / 停止、文件、真实相机 | 沿用 0.1.1 验收结论，本版回归通过 |
| 图像工具 | ROI、像素、直方图、PC LAB、复制、缩放、导出沿用 0.1.1；本版仅调整工具条与徽标 |
| 身份、完整备份、烧写 | 当前 `DE/E7` 拒绝；容量未认证，未完整备份，未烧写（同 0.1.1） |
| Windows、其他芯片 | 未实机验收；STM32F103C8T6、ESP32-C3 / S3 为后续范围 |
| 安装器、搭芯联动 | 未交付 |

## 环境与启动

同 0.1.1：[开发说明](../0.1.1/GETTING_STARTED.md)。4188 / 4189 / 4192 / 4193 / 4194 为既有现场窗口；4195 是本版验收用隔离实例（工作区 `/tmp/nodu-refine-ws`，用户数据 `/tmp/nodu-refine-user`，调试端口 4196），临时路径不是固定入口。

## 界面约定（替代 0.1.1“界面约定”一节）

- 默认只有编辑器；44 px 顶部工具栏统一常用操作。
- 左组：品牌、文件、运行 / 停止、设备 chip（6 px 状态点：灰未连接虚线边框 / 琥珀连接中 / 绿已连接运行 / 红设备级错误）。
- 中部：不显示项目名；仅在设备级错误时出现错误警告按钮，点击打开设备日志。
- 右组：`[控制台][视觉]` 图标按钮 + 1 px 分隔线 + 最右“简 / 专”分段控件；`aria-pressed` 反映当前模式，点击已激活段无操作。
- 设备 chip 打开常驻浮层；简洁模式浮层只有单一连接控件与文件管理，固件区隐藏但保持挂载。
- 用户代码异常（REPL / RAM 脚本）只在控制台显示 stderr；chip 红点与工具栏警告仅用于设备级错误（`errorOperation` 区分）。
- 编辑器内 `Cmd/Ctrl+Enter` 运行当前缓冲区；控制台内 Enter 只执行 REPL、Shift+Enter 换行、IME 合成中 Enter 忽略。
- 简洁模式隐藏面包屑，编辑器标签条 30 px；专业模式保留 Theia 全部装饰。
- 日志不自动展开控制台；设计理由与过程说明写注释，不铺在 UI。

细节见[桌面 UI](desktop-ui.md)。实际截图：[默认](../../artifacts/ui-minimal/20261019-refine/simple-default.jpg)、[设备浮层](../../artifacts/ui-minimal/20261019-refine/popover-connected.jpg)、[控制台 stderr](../../artifacts/ui-minimal/20261019-refine/console-stderr.jpg)、[视觉与编辑器](../../artifacts/ui-minimal/20261019-refine/vision-frame.jpg)。

## 代码位置（本版改动）

| 路径 | 职责 |
| --- | --- |
| `desktop/scope-extension/src/browser/scope-workbench.tsx` | 工具栏（警告、分段开关、运行 / 停止状态、chip 状态点）、`refitMainTabBars`、模式类提前应用 |
| `src/browser/nodu-device-client.ts` | `errorOperation` 字段与 lastError 归因守卫 |
| `src/browser/nodu-device-panel.tsx` | 单一连接控件、固件区简洁模式隐藏 |
| `src/browser/scope-widgets.tsx` | 视觉面板标题 / 相机开关合并、`leading` 工具条、相机错误过滤 |
| `src/browser/nodu-image-tools.tsx` | `leading` 属性、单行工具条、图像徽标 |
| `src/browser/nodu-console-widget.tsx` | stderr 分条、本地清空、键盘语义、自动增长 |
| `style/layout.css`、`device.css`、`image-tools.css` | 上述全部样式与简洁模式面包屑 / 标签条高度 |

`src/`、`resources/` 简写均相对 `desktop/scope-extension/`。其余代码位置表沿用 [0.1.1 HANDOFF](../0.1.1/HANDOFF.md)。

## 后续顺序

1. **0.1.3**：P2 项（简化状态栏、未连接空状态）+ MaixPy IDE 功能对齐，规划中。
2. flash-probe 接续不变：`DE/E7` 身份、原件复核与有界诊断按 [0.1.1 HANDOFF 硬件现场与接续](../0.1.1/HANDOFF.md#硬件现场与接续) 执行。

## 验证与证据

```sh
npm run compile
node --test scope-extension/test/backend-validation.cjs scope-extension/test/image-analysis.cjs
~/.nodu/python/bin/python -m unittest discover -s scope-extension/test -p 'worker*_test.py'
npm run build:electron
```

结果见 [validation.json](validation.json) 与 [验收记录](../../artifacts/ui-minimal/20261019-refine/verification.md)；截图指纹见 [provenance.json](../../artifacts/ui-minimal/20261019-refine/provenance.json)。已知限制见 [RELEASE.md](RELEASE.md)。

## 许可、Git

同 0.1.1：新增源码 MIT，第三方许可边界见 [0.1.1 HANDOFF](../0.1.1/HANDOFF.md#许可与分发)。基线分支 `main`，提交后创建注释标签 `v0.1.2`。后续版本新增目录，不覆盖 0.1.1 / 0.1.2 交接事实。
