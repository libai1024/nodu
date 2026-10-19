# Nodu 0.1.2

日期：2026-10-19。状态：**开发基线 / 交接版本**，本地 Git 标签为 `v0.1.2`（交接时创建）。根 `VERSION`、四个 npm workspace 与锁文件统一为 `0.1.2`，保留内部 `scope-*` 名称兼容。

## 本版内容

只包含简洁模式 UI 修订；设备、固件、图像分析与品牌能力不变。

- **工具栏**：中部不再重复项目名，仅在设备级错误时显示可点击的错误警告（打开设备日志）；右组固定为控制台、视觉图标 + 分隔线 + 最右“简 / 专”分段模式开关（`role="group"`、`aria-pressed`、点击已激活段无操作）。
- **运行 / 停止**：运行中显示旋转图标 +“运行中”+ `aria-busy`，主色降不透明度而非灰色禁用；停止图标在运行 / 忙时为错误色，不可停止时降为 0.35 不透明度无边框。
- **设备 chip**：电路板图标改为 6 px 状态点（灰未连接 / 琥珀连接中 / 绿已连接运行 / 红设备级错误）；未连接为虚线边框。
- **编辑器装饰**：简洁模式隐藏面包屑行，编辑器标签条 30 px；专业模式不变。模式切换经 `refitMainTabBars` 重测 Lumino 标签区尺寸提示，跳过不可见区域。
- **设备浮层**：简洁模式单一连接控件（连接 / 取消 / 断开按阶段显示）；“固件与恢复”隐藏但保持挂载，烧写进行中仍显示；草稿与设备会话跨模式保留。
- **视觉面板**：简洁模式去掉重复标题；相机控制合并为单一开关（冻结 / 继续 / 启动相机），有帧时附重启相机图标；工具条单行承载缩放、导出格式与截图；帧元信息改为图面左下角非交互徽标（`#序号 · 宽 × 高`，蒙版时附 `· LAB`）；分析折叠摘要增大点击区。
- **控制台**：stderr 按条标红；“清空”为视图本地（不影响专业输出通道与浮层）；Enter 执行、Shift+Enter 换行、Ctrl/Cmd+Enter 执行、IME 合成中 Enter 忽略；输入框 `resize:none`、1–4 行自动增长；“执行”为图标按钮。
- **错误归因**：`NoduDeviceModel` 新增 `errorOperation`，区分用户代码异常与设备级故障——REPL / RAM 脚本报错不再使 chip 变红或占用工具栏警告；视觉面板错误段仅显示相机 / 预览操作失败。

## 验证与限制

`npm run compile` 0 错误；`node --test backend-validation.cjs image-analysis.cjs` 20 项通过（6 后端 + 14 图像）；固定 Python worker suite 100 项通过；`npm run build:electron` browser / node / electron 均 0 错误；`impeccable detect --json` 对全部改动文件返回 `[]`。4195 隔离实例在野火 K210 CAM / GC2145 上验收：连接、RAM 运行相机脚本、真实帧徽标、运行中工具栏、REPL `1/0` 不归因设备错误、设备级错误仍触发警告、模式与面板回归。证据与指纹见 [verification.md](../../artifacts/ui-minimal/20261019-refine/verification.md) 与 [provenance.json](../../artifacts/ui-minimal/20261019-refine/provenance.json)。

- REPL / 脚本报错在控制台会显示两次文本（一条来自设备 stderr，一条来自 `reportError` 的日志记录）——既有行为，本版未改。
- 真实拼音输入法合成中 Enter 未实测；已用合成 `isComposing` 事件验证忽略路径。
- `refitMainTabBars` 依赖 Lumino DockLayout 私有 `_root` / `sizers` 结构；Theia / Lumino 升级时需重检。
- 截图（及原始 0.1.1 截图）中窗口左上角紫色徽标属 Theia / Electron 标题栏区域，非本扩展元素，未改动。
- 0.1.1 全部限制继续适用：Flash 身份 `DE/E7`、容量未认证、未完整备份、未烧写；无安装器 / 签名 / 自动更新；Windows 未实机验证。
