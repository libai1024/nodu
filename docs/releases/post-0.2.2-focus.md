# 全局点击焦点外框修复（2026-10-24）

基线：`de67821`，工作分支：`codex/nodu-02-integration`。本次为 0.2.2 发布后的源码修复，没有修改已发布标签或安装包。

## 原因与修改

Theia 的全局 `:focus:not(iframe)` 和按钮 `:focus` 规则也会给鼠标点击、页面切换后程序恢复焦点的控件画蓝色外框。此前 Nodu 只增加了 `:focus-visible` 样式，没有消除继承的 `:focus` 外框，所以问题不限于工作台。

- 共用样式只取消 `:focus:not(:focus-visible)` 的 outline，保留真实焦点、键盘导航和文本编辑状态。
- 文件树的行及空态另有独立外框规则，按相同方式处理；选中背景不变。
- 工作台搜索、问题筛选、目标选择和 AI 输入容器按可见焦点显示外层提示，避免鼠标点容器内按钮时整块高亮。
- AI 文本域使用输入容器的单层边框标记编辑状态，消除内外双圈。

没有修改快捷键、焦点恢复逻辑、菜单行为、编辑器选区或项目文件。

## 验证

- 扩展 TypeScript 编译通过。
- `node --test scope-extension/test/launcher.cjs scope-extension/test/launcher-view.cjs`：39 项通过。
- `theia build --mode development` 在 `desktop/electron-app` 完成 browser、node、electron 三部分构建，均零错误。
- `git diff --check` 通过；独立代码复核未发现键盘焦点可见性回归。
- Impeccable 检查提示的三个逐行教学状态左边框属于既有规则，不在本次差异中，未连带修改。

使用隔离 profile 的真实 Electron 源码预览验收：

| 场景 | 结果 | 截图 |
| --- | --- | --- |
| 深浅主题工作台鼠标点击 | 无额外焦点外框 | `launcher-pointer-dark.png`、`launcher-pointer-light.png` |
| 工作台 Tab 导航 | 键盘外框保留 | `launcher-keyboard-dark.png` |
| 新建输入和鼠标取消 | 输入编辑状态保留，返回入口无多余外框 | `form-input-light.png`、`form-cancel-light.png` |
| 键盘打开原生文件对话框并取消 | 焦点返回打开入口，键盘提示保留 | `dialog-keyboard-return.png` |
| 极简模式文件树点击及方向键导航 | 点击仅显示选中背景，键盘导航有外框 | `tree-pointer-light.png`、`tree-keyboard-light.png` |
| 设置弹窗切换深色主题 | 选中状态正常，无额外点击外框 | `settings-pointer-dark.png` |
| 专业模式深色文件树 | 点击选中背景正常，无多余外框 | `professional-tree-pointer-dark.png` |
| 专业模式 AI 文本输入 | 保留外层编辑边框，消除内层重复框 | `professional-composer-single-focus-dark.png` |

截图存于执行机器的 `~/.codex/nodu-focus-20261024/`，使用本任务自建测试工程，没有编辑源文件、调用模型或操作硬件。此验证覆盖上述界面，不等同于全部功能回归；Windows 未实测。本预览没有加载完整语言插件，出现过 clangd 未注册提示，不作为本次样式验收结果。

已发布的 0.2.2 安装包仍保持原内容；本次未重新打包或上传。
