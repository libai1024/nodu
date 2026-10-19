# Nodu · 见微 0.1.1

面向嵌入式初学者的独立 IDE，基于 Eclipse Theia 1.76、Electron 42.8、React 19 和 TypeScript 5.9。目标平台 Windows / macOS；当前 macOS 已完成 K210 真板与新精简界面验收，Windows 尚待实机验证。

**[0.1.1 交接文档](docs/0.1.1/HANDOFF.md)** · [版本资料](docs/0.1.1/README.md) · [版本说明](docs/0.1.1/RELEASE.md) · [构建与启动](docs/0.1.1/GETTING_STARTED.md)

已有文件编辑、简洁 / 专业布局、串口、REPL、RAM 运行 / 停止、板端文件传输、真实 JPEG 与图像工具。精简模式默认只有编辑器，操作集中到顶部，最右相机按钮开关视觉面板。切换保留代码、光标与设备连接，UI 不放过程说明文案。

当前 Flash 身份读取返回 `DE/E7`，容量未认证，完整备份与烧写未验收。0.1.1 是带已知限制的开发基线，尚无安装器、签名或自动更新。

## 开发运行

准备 Node.js 24 与本机编译工具，在 `desktop/` 执行：

```sh
npm ci
npm exec -- install-electron
npm run setup:device
npm run build:electron
npm run start:electron
```

浏览器目标使用 `npm run build:browser` / `npm run start:browser`。两个目标共享原生依赖，切换涉及 ABI 重建；当前开发现场的未保存窗口应先保留。完整说明见[开发文档](docs/0.1.1/GETTING_STARTED.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `desktop/` | 实际应用、设备服务、测试与示例 |
| `docs/0.1.1/` | 当前版本交接、产品、设计、开发与审查 |
| `brand/` | 蓝色品牌页和 SVG / PNG / ICNS / ICO 资产 |
| `tools/flash-probe/` | 固定来源 RAM reader、构建与许可审查材料 |
| `artifacts/`、`.impeccable/review/` | 分阶段验收证据；原始 UI 文本与日志仅本地保留 |
| `.spec/` | 实施记录，固件实写任务仍未完成 |

`preview/` 为独立 Git 仓库中的早期设计网站，父仓库忽略并保留原样。历史网站压缩包在 `artifacts/`。旧文档路径保留导航，详细内容归入版本目录。

新增源码使用 [MIT](LICENSE)。依赖、字体、RAM reader 与运行库保留各自许可证，详见[第三方 NOTICE](desktop/THIRD-PARTY-NOTICES.md)与[交接许可边界](docs/0.1.1/HANDOFF.md#许可与分发)。
