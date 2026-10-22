# Nodu · 见微 0.1.4

面向嵌入式初学者的独立 IDE，基于 Eclipse Theia 1.76、Electron 42.8、React 19 和 TypeScript 5.9，主要设备服务使用 Rust 侧车。目标平台 Windows / macOS；macOS 已有 K210 真板流程记录，Windows 已完成构建及部分真机冒烟，完整 GUI 与实板串口仍待验证。

**[0.1.4 工作交接](docs/0.1.4/HANDOFF.md)** · [版本资料](docs/README.md) · [遗留清单](docs/0.1.4/remaining-work.md) · [构建与启动](docs/0.1.4/HANDOFF.md#6-环境构建与交付位置)

已有文件编辑、简洁 / 专业布局、串口、REPL、RAM 运行 / 停止、板端文件传输、真实 JPEG 与图像工具。精简模式默认只有编辑器；顶部依次是项目菜单、运行（下拉含“保存到开发板”“设为开机脚本”等）、停止和设备入口，右侧是文件列表 / 串行终端 / 帧缓冲三个面板开关与“更多”菜单（主题、简洁 / 专业模式、命令面板、设置、关于）。专业模式另有“开发板文件”视图。切换保留代码、光标与设备连接，UI 不放过程说明文案。这次 UI 重构是 `6a2ca36` 之上的改动，核对记录见 [ui-layout-20261021.md](docs/0.1.4/evidence/ui-layout-20261021.md)。

当前应用开发版本为 **0.1.4**，仍处于兼容性与稳定性验收阶段，不能宣称已完成 MaixPy IDE 0.2.5 的严格 1:1 验收。完整备份、同版本烧写与回读已在野火 K210 真板验证；相机帧尾不足已有恢复措施，但根因与长期稳定性仍待验证。已有 macOS universal 与 Windows x64 包，最新源码是否包含在现有包内仍需核对。

根目录 `VERSION` 与 `PRODUCT.md`、`DESIGN.md` 仍停留在 0.1.2，属于待同步的历史入口；当前版本判断依据与发布边界见交接文档。

## 开发运行

准备 Node.js 24 与本机编译工具，在 `desktop/` 执行：

```sh
npm ci
npm exec -- install-electron
npm run setup:device
npm run build:electron
npm run start:electron
```

浏览器目标使用 `npm run build:browser` / `npm run start:browser`。两个目标共享原生依赖，切换涉及 ABI 重建；当前开发现场的未保存窗口应先保留。当前构建入口与平台限制见[交接文档](docs/0.1.4/HANDOFF.md)，旧[开发文档](docs/0.1.1/GETTING_STARTED.md)保留历史说明。

## 目录

| 路径 | 内容 |
| --- | --- |
| `desktop/` | 实际应用、设备服务、测试与示例 |
| `docs/0.1.4/` | 当前交接、计划、验收表、遗留与证据；0.1.1 / 0.1.2 / 0.1.3 保留历史记录 |
| `brand/` | 品牌规范 v2（「点亮」标志、电路板配色）：单一来源 `src/`、生成脚本、规范页与 SVG / PNG / ICNS / ICO 资产；v1 归档于 `archive/` |
| `tools/flash-probe/` | 固定来源 RAM reader、构建与许可审查材料 |
| `artifacts/`、`.impeccable/review/` | 分阶段验收证据；原始 UI 文本与日志仅本地保留 |
| `.spec/` | 历史实施记录；最新完成状态按 0.1.4 交接与证据核对 |

`preview/` 为独立 Git 仓库中的早期设计网站，父仓库忽略并保留原样。历史网站压缩包在 `artifacts/`。旧文档路径保留导航，详细内容归入版本目录。

新增源码使用 [MIT](LICENSE)。依赖、字体、RAM reader 与运行库保留各自许可证，详见[第三方 NOTICE](desktop/THIRD-PARTY-NOTICES.md)与[交接许可边界](docs/0.1.2/HANDOFF.md)。
