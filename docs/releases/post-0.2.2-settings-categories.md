# 设置分类与 AI 教学设置验收

日期：2026-10-25

## 变更

- 居中设置窗口左侧统一为「通用 / AI 服务商 / AI 教学」，支持方向键循环及 Home / End 导航。
- 通用保留主题、模式与编辑器偏好；AI 服务商管理供应商、Key、模型与连接参数；AI 教学独立管理编辑指导、代码虚影、代码高光、浮动批注、任务步骤窗和逐行 AI 检查。
- 教学开关复用现有 tutor 状态和保存逻辑，总开关关闭时保留各项偏好。模型配置命令继续通过 `ai` 页面标识直达服务商页，切换分类不卸载供应商表单。
- 参考 AI 设置概念图调整蓝色选中态、页面标题、说明文字和留白，设置窗口为 800 × 680 CSS px，受视口尺寸约束。

## 自动验证

- `npm run compile --workspace @scope/studio-extension`：通过。
- `npm run test:workbench --workspace @scope/studio-extension`：106 项通过，0 失败。
- `npm run build --workspace @scope/electron-app`：通过，browser / node / electron 构建无错误。
- `git diff --check`：通过。

## Electron 验收

使用既有隔离验收 profile 与 `release-final-f103` 工程副本检查：

- 三类页面显示与键盘向下切换、Home 返回通用正常。
- AI 编辑指导关闭后显示偏好保留说明，再次开启后五项偏好仍为开启。
- 通用、供应商、教学页面明亮主题显示正常；教学页面暗色主题显示正常。
- 窗口由 1310 × 873 缩小至约 981 × 721 CSS px，教学内容和开关完整可见，无遮挡；随后恢复窗口尺寸与明亮主题。
- 预览停留在 AI 教学页，总开关与其余偏好恢复验收前状态。本轮未发送模型请求或操作开发板。

截图及构建日志位于 `/Users/wangwei/.codex/nodu-settings-categories-20261025/`：

- `01-general-light.png`
- `02-providers-light.png`
- `03-teaching-light.png`
- `04-teaching-dark.png`
- `05-teaching-compact-dark.png`
- `06-teaching-final.png`
