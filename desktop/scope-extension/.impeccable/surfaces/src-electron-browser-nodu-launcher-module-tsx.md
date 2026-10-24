---
version: 1
slug: "src-electron-browser-nodu-launcher-module-tsx"
primary_target: "src/electron-browser/nodu-launcher-module.tsx"
related_targets: ["style/launcher.css"]
---

# Nodu 独立启动工作台

- Scope: Electron 无工程启动窗口；visitor mode = Operate。
- Audience/job: 嵌入式学习者要快速继续最近项目、创建或打开工程、从真实课程副本开始。
- Product truth: 保留 Nodu 品牌、项目窗口路由、最近项目存储与示例复制服务；启动页新建项目在当前窗口内联完成，IDE 内其他入口沿用原新建对话框；不增加虚构导航、数据或功能声明。
- References: PyCharm Welcome / Projects 与 IntelliJ IDEA recent-project navigation；采用其清晰的侧栏、项目主列表和直接操作，不复制配色或商标。

## Direction contract

THESIS: 项目本身就是首屏；用成熟 IDE 的导航与列表密度替代两个按钮加空白列表的占位式页面，拒绝营销 hero 和卡片 dashboard。

OWN-WORLD: Nodu 芯片墨/丝印白中性层、Nodu 蓝主动作与选中、真实点亮标志、Scope Plex、Codicon、4–6px 控件圆角；无渐变、投影卡片和装饰插画。

STORY: 用户立即看到品牌与“项目”，可新建/打开，也可搜索并继续最近项目；第二个真实入口提供参考项目副本。加载、空白、无匹配、缺失、错误与忙碌状态都有明确下一步。

FIRST VIEWPORT: 默认 960×640，左侧约 200px 品牌与“项目/参考项目”导航，底部主题切换；右侧顶部标题和新建/打开操作，其下搜索与全宽最近项目列表。项目行包含类型符号、名称、芯片、路径、时间和移除。760×500 保持双区并收紧间距。

FORM: JetBrains Projects 式双区工作台，是用户明确指定的成熟工具界面标准；保持 Nodu 自身品牌与项目内容。seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Finish record

- Verdict: ship（独立 scoped finish reviewer 对最新追加修改再次判定，无阻断问题）。范围仍为本 surface 重设计（`src/electron-browser/nodu-launcher-module.tsx` 与 `style/launcher.css`），属现有品牌 v2 体系内的一个 surface，不是新视觉世界；全局 PRODUCT.md 与 DESIGN.md 未改。
- 最终实现要点：
  - 一体化窗口，无独立原生标题栏（`titleBarStyle: hidden` + `trafficLightPosition`），顶部独立拖动区避开红绿灯；左下仅太阳/月亮纯图标主题切换。
  - 缺失项目为轻量“文件夹不存在”小标签；搜索图标与文字流内分离、无外围线，清除按钮正常。
  - 无项目时不显示 0 计数/搜索/顶部重复按钮，也不渲染占高度的空列表；三个起始操作直接位于标题下。
  - 新建项目使用当前窗口内联 NewProjectForm，IDE 内其他入口保留原对话框；已实测创建成功打开工程与取消返回。
  - “学习示例”全部改为“参考项目”：整行单按钮，右侧仅链接式“创建副本 ›”，无说明文案；已实测整行复制并打开。
  - 移除“从内置课程创建独立副本……”等说明性文案，保留真实项目摘要、操作、状态与错误。
- 最新验证：launcher 单测 14/14、tutor 189/189 通过；Electron browser/node/main build 0 errors；`check:brand` 122 组对比度通过；`git diff --check` 通过；impeccable detect 返回 `[]`；启动日志仅有既有 punycode 弃用警告。
- 最终截图（基线：`.impeccable/review/launcher-baseline.jpg`）：
  - `.impeccable/review/launcher-empty.jpg`
  - `.impeccable/review/launcher-examples.jpg`
  - `.impeccable/review/launcher-create.jpg`
  - `.impeccable/review/launcher-dark.jpg`
  - `.impeccable/review/launcher-light.jpg`
- 前轮非阻断建议处置：空态重复操作已随本轮空态重设计解决；640px 防御性 CSS、示例图标置顶与更多 ARIA 元数据仍为非阻断后续项。

## 2026-10-24 Codex 接收复验（覆盖此前 finish record 的现状结论）

用户要求全面参考成熟 IDEA 工作台，不要廉价 AI 提示词；也参考弹窗和右下角通知分级。此前 ship 记录未覆盖 Enter 被吞、加载不能收尾、全局样式覆盖等真实问题，本轮已修复并记录。空态最终为两个动作；参考项目不展示 README 摘要；失败操作为右下角可关闭通知，加载失败原位重试、字段错误原位显示。实际产品新建/复制/返回/键盘/最小尺寸通过；故障状态单独夹具截图，不混称完整链路。24项工作台测试通过，55张截图及限制详见 `docs/ai-tutor/WORKBENCH-ACCEPTANCE-2026-10-24.md`（仓库根目录下）。不使用 marketing hero、AI prompt cards、永久解释或中点拼接文案。
