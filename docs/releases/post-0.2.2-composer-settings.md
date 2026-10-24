# 专业设置窗与 AI 输入框验收

日期：2026-10-24 至 2026-10-25（北京时间）。基线 `5f1b959`，分支 `codex/nodu-02-integration`。工作树 `/Users/wangwei/.codex/worktrees/nodu-02-integration/k210-studio`。

## 实现

- 专业模式右上角设置改为居中窗口，默认 760 × 560 CSS px，左侧 144 px 分类导航，右侧独立滚动；同一窗口管理通用与 AI 设置。保留 Nodu 字体、颜色、图标及主题变量。
- 通用设置包含主题、模式、字号、自动保存、自动换行、缩进及全部设置入口。极简模式仍用轻量弹出菜单，两个模式设置按钮位置一致。
- AI 供应商改为单列折叠列表；Key 与模型直接呈现，名称、地址、协议放入“连接设置”。切换分类或供应商保留未保存草稿，关闭整个设置窗会丢弃未保存表单。无 Key 时隐藏显示按钮，编辑 Key 后重新遮蔽。
- 右上角齿轮、模型配置命令、输入框“配置”共用同一设置窗。背景 inert、关闭后恢复焦点、Esc、Tab 循环及分类上下方向键已接入；嵌套模型弹窗独立处理键盘。
- 输入框调整为轻边框、紧凑上下文标签、下方工具行；添加代码按钮与模式/模型/发送并列。宽度变化时重新计算多行高度，窄侧栏折叠多余文件标签。继续保留 Enter 发送、Shift+Enter 换行、IME 与停止独立行为。

## 参考范围

按用户要求查阅 DeepSeek Harness 官方源码，固定提交 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，参考其左侧导航、弱选中背景、供应商折叠与连接参数按需展开。没有运行或安装 Harness，也未引入其组件依赖。

- [设置布局](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-settings-general/src/client/SettingsRoot.module.css)
- [供应商列表](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-settings-models/src/client/ModelsSection.tsx)
- [供应商表单](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-settings-models/src/client/ProviderEditor.tsx)

Nodu 仍把常用模型列表直接展示，并保持自己的尺寸、文案与主题。

## 审查中修复

1. 详情持续挂载后，模型开关会把隐藏的连接草稿一并保存。普通配置动作现只使用已保存的 provider；连接“保存”才提交草稿。外部配置更新只同步未修改的表单字段。
2. “获取模型”在卡片或 AI 页面隐藏后完成，会在隐藏区域挂载弹窗导致焦点错误。现保留请求结果，待详情可见时才挂载、聚焦弹窗。
3. Key 保存期间连续 Enter 可能重复提交，旧请求完成会清空新输入。同步互斥锁阻止重复提交，完成后只清理与提交快照相同的输入。

## 自动验证

命令在 `desktop/scope-extension` 执行，构建命令在 `desktop` 执行：

| 验证 | 结果 |
| --- | --- |
| `npm run test:tutor` | 275 通过；输入框调整后的完整教学回归，在最终供应商表单修复前执行 |
| `npm run test:workbench` | 最终 105 通过，包含设置窗、provider、模式与工具栏回归；与教学套件部分重叠，不相加宣称独立用例数 |
| `node --test test/ai-provider-panel.cjs` | 7 通过，已包含于 105 项；生产组件函数覆盖草稿、异步隐藏弹窗及 Key 保存竞态 |
| `npm run compile` | 最终 TypeScript 编译通过 |
| `npm run build --workspace @scope/electron-app` | browser/node/electron 构建均零错误 |
| `git diff --check` | 通过 |

## 实际 Electron 验收

使用独立 `Nodu Review.app`、端口 24368、`launcher-reconcile-profile`，工程为既有验收副本 `release-final-f103`。本次设置 `NODU_TUTOR_EXPLICIT_CREDENTIALS=1`，没有输入真实 Key 或读取历史 Key。启动与源码来自本集成工作树。

- 已操作明亮/暗色、通用/AI 分类、上下方向键、嵌套添加模型与 Esc 返回、关闭后焦点恢复。
- 专业切极简关闭设置窗，极简齿轮仍为轻量菜单；切回专业后，输入框“配置”直接打开统一 AI 分类。
- 自定义供应商编辑名称但不保存，切供应商再返回仍保留草稿；最终修复版中折叠连接区域后切模型开关，供应商标题保持原名，展开仍显示未保存草稿及保存/还原按钮。测试模型开关与草稿均已还原。
- 实际缩小主窗口到约 980 × 720 CSS px，居中窗、关闭按钮、模型控制和底部检查开关未被裁切；结束后恢复原尺寸。
- 输入框实际输入两行中文草稿，宽度缩到约 300 CSS px 后正确换行；上下文菜单可打开和退出，工具行未溢出。仅输入草稿，没有发送，测试结束已清除本次草稿。
- 最终保留专业模式、明亮主题、通用设置窗口供检查。恢复侧栏原宽度。工程 `main.c` / `main.h` SHA256 与验收前一致。

日志有已有 plugin-host `punycode` 弃用告警（ERROR 标签）和 outputView 焦点警告，不宣称应用日志零警告。未进行外部模型验证、编译烧录或硬件操作；未制作新安装包、发布或推送云端。

## 本地证据

目录：`/Users/wangwei/.codex/nodu-composer-settings-20261024`。

- 最终设置：`harness-general-light-final.png`、`harness-ai-light-final.png`。
- 主题与尺寸：`harness-general-dark.png`、`harness-ai-dark.png`、`harness-ai-small-window.png`、`minimal-settings-regression.png`。
- 输入框：`composer-light.png`、`composer-dark-narrow.png`。
- 回归：`tutor-tests.log`、`workbench-final-tests.log`、`compile-final.log`、`build-final.log`。
- 实际应用：`electron-final.log`、`draft-isolation.ax.txt`、`project-source-before.sha256`。

早期 `settings-*-light.png` 是被 Harness 方案替换前的中间版本，不能作为最终截图。所有截图不含凭据。
