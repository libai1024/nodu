# 0.2.1 效果图

静态 HTML 示意图，1440 × 900，深色主题。不是运行截图，不代表已实现。颜色、工具栏标志取自 [2026-10-21 品牌提案](../../../brand/proposals/2026-10-21/)，品牌会话定稿后需要同步。

| 文件 | 画面 | 对应设计 |
| --- | --- | --- |
| [01-start.html](01-start.html) | 开始页 | [UI-DESIGN §5.1](../UI-DESIGN.md#51-开始页u3) |
| [02-new-project.html](02-new-project.html) | 新建项目向导 | §5.2 |
| [03-toolkit.html](03-toolkit.html) | 设置中的 STM32 工具包信息、工具包损坏说明卡 | §5.3、[TOOLKIT-DISTRIBUTION §6](../TOOLKIT-DISTRIBUTION.md#6-首次使用与完整性检查) |
| [04-workbench.html](04-workbench.html) | C 工作台：编译错误、悬停解释、问题列表 | §3、§6、§7.1 |
| [05-uart-isp.html](05-uart-isp.html) | 串口 ISP：任务条、引导卡、监视器让出串口 | §3.5、§7.2、§8.3 |
| [06-device-diagnose.html](06-device-diagnose.html) | 设备弹层（专业模式）与下载诊断卡 | §4、§8.5 |

共用文件：`mockup.css`（令牌暂用值与组件样式）、`icons.js`（占位图标与工具栏标志）。字体引用仓库内的 Plex 与 Plex Mono。

## 生成 PNG

在仓库根目录执行（需要已安装 `desktop/node_modules`）：

```bash
desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron docs/0.2.1/mockups/render.cjs
```

也可以只生成指定画面，例如在命令末尾加 `04-workbench`。输出为同名 `.png`，与 HTML 放在同一目录。

本次在 Claude 的沙箱中无法启动 Electron 或 Chromium（macOS mach port 权限被拒绝），所以仓库里还没有 PNG。六个画面已在 Browser 窗格中以 1440 × 900 打开检查过版面。
