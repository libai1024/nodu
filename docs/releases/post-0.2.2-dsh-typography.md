# DSH 字体与间距精修

2026-10-25（北京时间）。基线 `9295ff7`；分支 `codex/nodu-02-integration`。

## 实现

沿用上一轮的设置结构、功能与 Nodu 主题色，参考 DeepSeek Harness 提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`：

- [设置窗](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-settings-general/src/client/SettingsRoot.module.css)：800 px 最大宽高、188 px 导航列、54 px 标题行，四周至少 24 px；高度随视口收缩，内容独立滚动。
- [模型设置](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-settings-models/src/client/ModelsSection.module.css)：14/22 正文、16/24 中等字重标题、12/18 辅助文字、36 px 表单、28 px 图标操作。模型 ID 保留 code 语义，视觉改为系统 UI 字体。供应商浅边框与 16 px 圆角，模型行去分隔线，悬停提供定位反馈。
- 通用与 AI 分类统一 36 × 20 px 开关；通用行、页脚和正文对齐，增加分组间距。
- 输入框采用 14/22 排版，工具行与上下文为 12 px；统一左右文字边距，弱化模式按钮背景，窄侧栏允许工具栏换行。保留可见焦点、Enter/Shift+Enter、IME、停止与草稿行为。
- 修复设备表单全局 `input:not(...)` 规则覆盖 AI 表单的问题；作用域限定在专业设置，没有修改设备表单。供应商动作使用自己的样式类，避免通用文本按钮的 `11px !important` 覆盖。

## 验证

- `npm run test:workbench`：105 项通过。
- `node --test test/tutor-chat-interaction.cjs test/tutor-context-picker.cjs`：14 项通过。
- TypeScript 编译通过；最终 Electron browser/node/electron 构建均 0 errors。
- 实际 `Nodu Review.app`（端口 24368）验收：明亮/暗色通用与 AI 设置、添加模型弹窗及 Esc 返回、连接设置展开与滚动、约 980 × 720 CSS px 窗口、约 300 px 侧栏中英文多行草稿换行。
- 最终复查确认明暗主题表单使用轻填充背景和新圆角；窗口恢复原大小，主题恢复明亮，测试草稿清空且未发送，停留在 AI 设置供检查。
- 机械扫描仅报告已有代码编辑器行状态的三条 `border-left: 2px`；它们是教学行诊断标记，不是本次新增的卡片装饰，保留。
- 更新原有尺寸断言；“不使用 transform 改变固定定位包含块”的断言收窄到设置窗本体，允许开关子元素清除旧 transform。

## 验收异常与范围

首次尝试刷新误按 Cmd+R，该应用将它绑定为运行（编译并烧录）。界面返回“没有检测到 ST-LINK”，未完成烧录；随后改用命令面板中的“重新加载窗口”。本次没有执行模型连接测试，没有更改凭据。未进行安装包制作、发布或推送。

## 本地证据

`/Users/wangwei/.codex/nodu-dsh-polish-20261025`：

- `general-light.png` / `general-dark.png`：通用排版。
- `ai-light-final.png` / `ai-dark-small-final.png`：最终表单与列表。
- `composer-dark-final.png`：最终紧凑工具行；`composer-dark-narrow.png`：多行草稿换行（最后的工具行字号修正前）。
- `connections-small.png`、`model-dialog-light.png`：连接展开与嵌套窗口（表单背景优先级修正前）。
- `workbench-final.log`、`composer.log`、`build-final.log`、`design-scan.json`。
