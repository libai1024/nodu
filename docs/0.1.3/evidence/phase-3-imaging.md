# Phase 3 证据：WASM 成像集成 + 阈值编辑器

日期：2026-10-19。数值核心 `desktop/native/crates/nodu-imaging` 由 lead 维护且已冻结（12 组固定表 SHA 校验、4 项单测通过、独立参考核对器确认 4 色彩空间 / 10 通道 / 8 统计量与固定参考一致——此处不重复计算）。本档只记录本轮集成层的实际执行结果。

## 实现范围

- `desktop/scripts/build-imaging.cjs`（新增）+ package.json `build:imaging`；`compile` 先跑它再跑 tsc。命令链：`cargo build --locked --release -p nodu-imaging --features wasm --target wasm32-unknown-unknown` → `wasm-bindgen ... --target web --omit-default-module-path --out-dir scope-extension/resources/imaging --out-name nodu_imaging` → 生成内嵌 `wasm-bytes.js`（base64）+ `.d.ts`。启动前校验 `wasm-bindgen --version` 与 Cargo.lock 完全一致（不一致即失败退出）。
- 工具链（固定命令，`desktop/native` 目录内）：`rustup target add wasm32-unknown-unknown`（pinned 1.98.1）；`cargo install wasm-bindgen-cli --version 0.2.129 --locked`（本轮实际安装的是 GitHub 官方预编译 aarch64-apple-darwin tarball 至 `~/.cargo/bin`，`wasm-bindgen --version` = 0.2.129，与 Cargo.lock `wasm-bindgen 0.2.129` 一致；构建脚本强制版本一致否则失败）。
- `scope-extension/resources/imaging/` 为生成物，已加入 `desktop/.gitignore`（同 `resources/bin/`）。
- `src/browser/nodu-imaging.ts`（新增）：薄桥接，`analyze/labRaster/binary/tagPixels`，`initSync` 内嵌字节，无 JS 近似回退；初始化失败直接抛错。
- `nodu-image-state.ts`：新增 `thresholdMode('lab'|'gray')`、`grayThreshold[0,255]`、`invert`；`histogram` 扩为 `ColorSpace`（rgb/gray/lab/yuv）。
- `nodu-image-tools.tsx`：直方图/像素 LAB/阈值蒙版全部走 WASM；分析使用**原始解码尺寸**（不再降采样，`analysisSize` 仅做上限校验）；`DecodedFrame.lab` 移除（采样按需 `labRaster(1×1)`）；直方图 4 色彩空间，**每通道独立 `<figure>`**：各自 figcaption 标真实值域端点（如 `A · -128…127`），SVG viewBox 0 0 256 68、x 按 bins 索引归一、各图共用纵轴峰值；单张通道 × 8 统计量表置于全部图下方（横向滚动限于表容器）；gray 空间用 `nodu-image-histogram-gray` 类。像素值显示整数 `LAB` 并带查表提示；蒙版白计数只统计 ROI 内；`thresholdOnly` prop 供对话框复用；文件来源帧 mime 支持 jpeg/png、宽高未知时由解码尺寸做像素上限；JPEG 导出对非 JPEG 源帧报错。编码帧大小门限与文件源共用 `MAX_IMAGE_FILE_BYTES`（8 MiB，`nodu-imaging.ts` 导出，`frameDataWithinLimit` 按 base64 上限 `ceil(8MiB/3)*4` 判定）。
- `src/browser/nodu-threshold-edit.ts`（新增）：`parseThresholdTuple`（严格括号、恰好 2 或 6 个有符号十进制整数、域校验）+ `thresholdWritebackAllowed`（版本/选区文本/存活/只读守卫）+ `thresholdTargetDead`（纯标记判定 widget/model 已销毁或 model 已切换，供写回前守卫）。
- `src/browser/nodu-vision-tools.tsx`（新增）：`NoduVisionToolsContribution`（Command+Menu，`见微 → 机器视觉 → 阈值编辑器`，`scope.threshold-editor`；execute 捕获异步错误走 `messages.error`）+ `NoduThresholdDialog`（ReactDialog，单"完成"按钮，`maxWidth:760`，node 加 `nodu-threshold-dialog`、contentNode 加 `scope-widget`）；先捕获 currentEditor（version/不可变 range/选中文本）再 quick pick 帧缓冲/图片文件；文件源经 `files.resolve` 尺寸预检（≤8 MiB）+ `readFile` 实际长度复检；写回仅当捕获选区是合法阈值元组、目标未死（widget/model 存活且 model 未换）、非只读、version 未变、range 文本未变——`pushUndoStop` + 单个 `executeEdits` + `pushUndoStop`（一次 undo 只还元组），`executeEdits` 返回 false 也提示；不自动保存；任何不可写路径（无选区/目标已死/选区非元组/文档已变或只读）都不动文档并 toast 附**最终参数 + "复制参数"动作**（复制失败再 error 提示）。
- `scope-frontend-module.ts`：绑定该 contribution。
- `style/image-tools.css`：新增 `.nodu-histogram-channel`（figure margin 0 0 8px、figcaption 换行、labels wrap）、`.nodu-image-histogram-stats` 表格样式、`.nodu-threshold-dialog .dialogBlock`（`min(760px,100vw-32px)`、`max-height`）、`.dialogContent`（滚动+内边距+editorWidget 背景）、对话框内 select 输入令牌、`.nodu-image-tools-threshold .nodu-image-viewport`（max-height 260px）。

## 验证命令与结果

- `npm run build:imaging`：通过（staged 473073 wasm bytes）。
- `npm run compile`：0 errors（先 build:imaging 后 tsc）。
- `node --test scope-extension/test/image-analysis.cjs`：12/12 通过（新增 tuple 解析 15 例 + writeback 守卫 7 例 + 8 MiB 编码门限 4 断言 + `thresholdTargetDead` 4 例）。
- `node --test scope-extension/test/backend-validation.cjs`：8/8 通过。
- `npm run check:licenses`：145 files clean。
- 设计检测器（本轮真实执行一次）：`impeccable detect --json` 作用于 `nodu-image-tools.tsx` + `nodu-vision-tools.tsx` + `style/image-tools.css` → 输出 `[]`，零命中。
- `npm run build:electron`：0 errors（native + imaging + tsc + esbuild）。
- `cargo test -p nodu-maix-ide check_failure_after_partial_read_is_protocol`：通过（按评审意见将回调改为 `>1`——header check(#0)/read 前 check(#1) 放行，消费字节后下一次 check(#2) 失败，并断言 `in_waiting()==0` 证明字节已消费）。
- Node 直接加载生成的 ESM glue（复制为 .mjs，非仓库文件）实测：2 像素黑白图 RGB 直方图 bins [32,64,32]、count 2、mean 128、median 0、min 0、max 255；白色 ROI count 1、mean 255；gray binary [0,0] → 黑白、invert → 黑白反转；LAB 黑像素 [0,0,0]；LAB bins L:101/A:256/B:256；`tag_pixels('tag16h5',0)` → 64 px（8×8）。

## UI 实测（隔离 Electron 127.0.0.1:4195，本轮新构建，CDP 4196 驱动，离线）

设备帧注入方式：`window.theia.container` → `NoduDeviceModel.onState(connected)+onFrame`（`artifacts/ide-diag/camera-frame.jpg` 真实 JPEG base64）——**这是注入的离线帧，非板端连接**。期间后端 worker 曾推送真实 `error` 态清掉注入帧（重注后正常），测试结束已把 model 恢复为 `disconnected`。

- 视觉面板：真实帧渲染 canvas 320×240；直方图切 `lab` → 三通道独立图（caption 实测 `L · 0…100 · 76800 像素`、`A · -128…127`、`B · -128…127`，各图真实值域端点）+ 统计表 `L{mean56,med49,mode100,sd27,min9,max100,lq31,uq81}`、`A{1,1,1,3,-6,9,-1,3}`、`B{6,2,0,9,-20,30,0,11}`；蒙版默认 LAB 全命中 `76,800/76,800`；徽标 `#1 · 320 × 240 · LAB`。
- 阈值编辑器：`thresh_smoke.py` 选中 `(0, 100, -128, 127, -128, 127)` → `executeCommand('scope.threshold-editor')` → quick pick（"帧缓冲 当前设备帧 #1"/"图片文件"）→ 对话框 `thresholdOnly`（maxWidth 760、`nodu-threshold-dialog`+`scope-widget` 类生效、6 个 LAB 滑条）→ L 上限拖到 80 → tuple `(0, 80, -128, 127, -128, 127)`、蒙版 `56,713/76,800 · 73.8%` → "完成" → `thresholds = (0, 80, -128, 127, -128, 127)` 精确替换，version 1→2；**一次 undo 完整还原**为 `(0, 100, …)`（pushUndoStop 成对包裹生效）。
- 无有效目标/选区：关闭对话框后 toast `选中内容不是有效的阈值元组；文档未修改。 最终参数 (0, 80, …)` + **"复制参数"动作按钮**（DOM 实测可见）。
- 陈旧缓冲守卫：对话框打开期间 `applyEdits` 插入一行 → "完成" → 选区元组**未改动**，toast `编辑器内容已变化或为只读；文档未修改。 最终参数 (0, 100, …)` + "复制参数"动作。
- 文件源：stub `showOpenDialog` 返回 camera-frame.jpg URI（原生对话框无法由 CDP 驱动——`resolve`/`readFile`/base64/解码为真实路径）→ 对话框 canvas 320×240、徽标 `#0 · 320 × 240 · LAB`；测试后已还原该方法。
- 截图（明暗双主题 @2x）：`vision-hist-1520-light.png`、`vision-image-1520-light.png`、`vision-hist-980-light.png`、`vision-hist-1520-dark.png`（直方图区打开、三通道 LAB 图+统计表可见）。**更正**：`threshold-dialog-1520-light.png` 实际裁剪了图像末段与 B 通道滑条、Copy 行不可见；`vision-hist-980-dark.png`/`threshold-dialog-1520-dark.png` 内容为编辑器+通知，**不包含视觉面板**——评审指出后此处如实标注，不作为直方图证据。旧文件 `vision-hist-threshold-1520/980.png`、`threshold-dialog-1520.png` 为再上一轮拍摄（details 全折叠）。修正后的对话框截图见 phase-4 证据（fit 修复后重拍）。

## 已知限制

1. 原生文件对话框本身未被 CDP 驱动（`showOpenDialog` 被替换为返回固定 URI）；`resolve`/`readFile`/解码/像素上限是真实路径。原生对话框交互未验证。
2. `tagPixels`（AprilTag）已桥接并 smoke 验证，但尚无 UI 消费方。
3. 直方图每通道 SVG 横轴按 bins 索引归一到 0–255 视窗，figcaption/轴标签给出各通道真实值域（如 `A · -128…127`），不与 LAB 量纲混排。
4. 像素 LAB 为 IDE 查表值（整数），非浮点 CIELAB；JPEG 解码像素可能与传感器原始像素不同（UI 提示已写入）。
5. 本轮 UI 验证为离线注入帧（`model.state.phase` 临时置 `connected`，验证后恢复 `disconnected`）；真板帧 + 阈值编辑器对真板帧的行为未在本轮验证。
6. `thresholdOnly` 的 fit 缩放曾只按宽度适配：320×240 帧在 260px 视口内底部裁剪（上一组截图可见）。已修复为 `width:min(100%, 260·w/h px)` 双约束，见 phase-4 证据。
