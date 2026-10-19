# 0.1.2 精简模式 UI 修订验收

2026-10-19，macOS。截图来自 4195 隔离 Electron 实例的实际渲染（CDP `Page.captureScreenshot`，本机 `screencapture` 无 TCC 权限；不含原生标题栏）。

## 实例与硬件

- 实例：端口 4195，远程调试 4196，工作区 `/tmp/nodu-refine-ws`（`desktop/examples/gc2145-camera` 副本），Electron 用户数据 `/tmp/nodu-refine-user`，启动器 `/tmp/nodu-refine-app`。
- 硬件：野火 K210 CAM / GC2145，`/dev/cu.usbserial-3120` 空闲时使用；RAM 运行 `camera_preview.py` 收到真实 320 × 240 帧；结束时已断开并归还串口。未烧写、未写板端文件。
- 4188 / 4189 / 4192 / 4193 / 4194 既有窗口未重载。

## 工具栏与布局

- 项目名从工具栏中部移除；中部仅在设备级错误时显示 `nodu-toolbar-alert`（点击打开设备日志，单行省略，≤760 px 隐藏）。
- 右组顺序为 `[控制台][视觉] │ 简/专`；分段控件 `role="group"`，`aria-pressed` 反映当前模式，点击已激活段无操作。
- 运行中按钮显示 `codicon-loading` 旋转 + “运行中” + `aria-busy`，主色 0.7 不透明度而非灰色禁用；停止图标在运行 / 忙时为错误色，`!canStop` 时 0.35 不透明度无边框。
- 设备 chip 以 6 px 状态点替代电路板图标：灰 = 未连接（虚线边框）、琥珀 = 连接中、绿 = 已连接 / 运行、红 = 设备级错误。
- 简洁模式隐藏面包屑行（`.theia-tabBar-breadcrumb-row`），编辑器标签行实测 30 px；专业模式保留面包屑（22 px 行，标签条 57 px）。模式切换经 `refitMainTabBars` 重测 Lumino 尺寸，不可见标签条跳过不写尺寸。

## 设备浮层

- 简洁模式单一连接控件（未连接显示“连接”，连接中显示“取消”，其余显示“断开”）；“固件与恢复”整体 `hidden` 但保持挂载，烧写进行中仍显示；专业模式固件入口不变。
- 浮层表单持续挂载，串口 / 路径草稿跨开关与模式切换保留。

## 视觉面板

- 简洁模式去掉“设备相机”标题，保留状态徽标；相机控制合并为单一开关（预览中→冻结 / 有帧→继续 / 无帧→启动相机），有帧时附“重新启动相机”图标按钮。
- 图像工具条单行：左 = 相机控制，右 = 缩放 + PNG/JPEG + 截图图标；帧元信息行移除，改为图面左下角非交互徽标 `#序号 · 宽 × 高（· LAB）`，缩放 / 滚动时仍在视口内。
- ROI / 直方图 / LAB 折叠摘要 12 px、最小高 34 px。

## 控制台

- 每条日志独立 `<span>`，stderr 用 `--theia-errorForeground`；“清空”为视图本地 `clearedAt`，不影响专业输出通道与浮层。
- 输入：Enter 执行、Shift+Enter 换行、Ctrl/Cmd+Enter 执行、IME 合成中 Enter 忽略（`isComposing` / keyCode 229）、`stopPropagation` 不触发编辑器运行；`resize:none`，1–4 行自动增长；“执行”为 codicon-play 图标。

## 错误归因（errorOperation）

- REPL `1/0`：chip 保持绿色、无工具栏警告，stderr 仅在控制台标红；控制台图标红色提示保留。
- 设备级错误（`读取板端目录` 于无效路径）：chip 红点 + 中部警告 + 浮层错误块均出现。
- 视觉面板错误段仅显示启动相机 / 预览操作失败。

## 回归

- 简洁↔专业切换保留未保存文本、光标、设备连接与浮层草稿；编辑器标签存活。
- 编辑器 `⌘Enter` 触发 `scope.run-current`（未连接时提示“请先连接设备”）；控制台 Enter 只执行 REPL。
- 文件 / 控制台 / 视觉按钮 `aria-pressed` 与实际可见性同步。

## 未覆盖

- 真实 macOS 拼音输入法合成中 Enter 未实测；已用合成 `isComposing` 键盘事件验证忽略路径。
- Windows 实机、原生窗口最小尺寸拖拽手势未实测。
- 本目录截图不含原生标题栏；`screencapture` 窗口级截图因权限不可得。

截图清单与 SHA-256 见 [provenance.json](provenance.json)。已移除 `vision-frame2.jpg`（与 `vision-frame.jpg` 重复的早期抓拍）。
