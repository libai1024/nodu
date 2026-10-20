# Phase 4 证据：ORB 关键点编辑器 + AprilTag 批量生成器 + 生成器外链

日期：2026-10-19。数值核心继续冻结（本档只记录集成层执行结果）。ORB 编解码为 pin 定格式的新增编解码器：OpenMV `keypointseditor.cpp`——小端 `u32 kind` + `u32 count` + `count` 条 42 字节记录（5×u16 x/y/score/octave/angle + 32B 描述子）；normalized 标志不序列化；与原版不同，截断/尾部垃圾/溢出/声明数与实际长度不符一律拒绝（原版宽松部分读取 bug 不实现）。

## 实现范围

- `native/crates/nodu-imaging/src/orb.rs`（新增）：`Keypoint/Orb/decode/encode/edit`，上限 2 MiB；keep 索引严格递增且在界内；merge 空则跳过、否则解码并要求 kind 相等；输出大小复算上限。`lib.rs` `pub mod orb;` + WASM 导出 `orb_info`（kind + 五点元组 JSON）、`orb_edit`。
- `nodu-imaging.ts`：`OrbInfo` 类型 + `orbInfo`/`editOrb` 桥接（仍无 JS 算法）；`merge` 参数显式 `Uint8Array`（此前默认值 `new Uint8Array(0)` 被推断为 `Uint8Array<ArrayBuffer>` 导致调用点类型错误）。
- `nodu-vision-files.ts`（新增）：共享受限二进制文件加载（原生 picker → resolve 尺寸预检 → readFile 实长复检）。
- `nodu-keypoints-editor.tsx`（新增）：`NoduKeypointsDialog`（ReactDialog，`nodu-keypoints-dialog` + `scope-widget`，maxWidth 760，单"关闭"按钮）。画布 tabIndex=0、pointer capture 拖拽矩形选择（仅可见 octave，x/y 含端点）；<4 CSS px 视为点击、选 8 CSS px 内最近点；小圆 + 角度射线渲染，选中用 focusBorder 品牌蓝；原始坐标按 fit 缩放，extent=背景图或 `max(320,maxx+16)/max(240,maxy+16)`；octave 列表来自实际点的去重值，隐藏点不参与框选；Delete 键（画布聚焦）+ "删除选中" 按钮经 `editOrb` keep 更新；"合并…" 经 `editOrb` merge（kind 不符报错且不动现文档）；"保存为…" 原生保存框 + `createFile(overwrite:false)`，原文件不写、关闭不自动保存；状态行 `已选 X / 共 Y · 类型 K · 文件名` + 悬停点读出 + 操作提示。
- `nodu-apriltag-generator.tsx`（新增）：`NoduAprilTagDialog` + `TAG_FAMILIES` 六族常量（与已 pin 的 importer 一致）。起始/结束 ID 整数 0..count-1 且 end≥start；单元格 4–64（默认 24）；标签开关默认开；预览渲染首个 tag + 输出计数；`tagPixels` 灰度栅格 → `imageSmoothingEnabled=false` 整数倍放大；label 时在下方加 32px 白底黑字 `${label}-${id}`；PNG 顺序写入所选目录 `${family.id}-${id}.png`（`createFile overwrite:false`），写前对**全部**目标名做存在性预检（任一冲突则一个不写），中途失败报告实际写入数，进度 `done/total` + 每文件 `setTimeout(0)` 让出事件循环，"取消生成"按钮与对话框关闭分离（dispose 同样置取消位）。
- `nodu-vision-tools.tsx`：新增命令 `scope.keypoints-editor`、`scope.apriltag-generator`、`scope.qr-generator`、`scope.datamatrix-generator`、`scope.barcode-generator`（QR/DataMatrix/条码经 `OpenerService` 打开 pin 定 Google 搜索 URL，原 openmvplugin.cpp L879/893/907）；全部挂在 `机器视觉` 子菜单。`.orb` 打开流程：picker（≤2 MiB）→ `orbInfo` 解码**先于**建对话框（解析失败仅警告、不开窗）。
- `nodu-image-tools.tsx`：`thresholdOnly` 且 zoom=fit 时光栅 `width:min(100%, 260·w/h px)` + `marginInline:auto`——同时受 260px 视口高度约束（修复上一组截图中图像底部+B 滑条被裁掉的问题）；100/200% 保持真尺寸滚动。
- `style/image-tools.css`：两个新对话框的 `.dialogBlock`/`.dialogContent` 规则、关键点工具栏/octave/画布/状态行、生成器表单/预览/动作区样式。

## 验证命令与结果

- `cargo test -p nodu-imaging --all-features`：8/8 通过（4 个 orb 测试：字节级 fixture 往返、keep[1] 保描述子、merge 同 kind 追加/异 kind 拒绝、截断 0..len 全部拒绝+尾字节+u32::MAX count+dup/乱序/越界 keep 拒绝）。
- `cargo clippy -p nodu-imaging --all-targets --all-features -- -D warnings`：干净（`as_chunks::<42>()` 按 lint 机械替换）。
- `cargo fmt --all -- --check`：通过（orb.rs 已格式化）。
- `npm run build:imaging`：staged 526,725 wasm bytes（含 orb 导出）。
- `npm run compile`：0 errors。
- `npx theia build`（electron-app 前端 bundle）：0 errors。
- `impeccable detect --json`（keypoints/apriltag/vision-tools/vision-files/imaging 桥 + CSS）：输出 `[]`。
- `npm run check:licenses`：152 files clean。
- Node 直调编译产物 bridge：六族 `tagPixels(family, count-1)` 返回 side² 像素（64/81/81/100/100/100）、`tagPixels(family, count)` 全部抛错；`orbInfo(two.orb)` 返回两点元组；tag16h5-0 golden 由 Rust 测试 `tag16h5_first_code_orientation` 覆盖（算法未动）。

## UI 实测（隔离 Electron 4195，CDP 4196，离线；`showOpenDialog`/`showSaveDialog` 临时替换为固定 URI 以驱动原生对话框路径，`resolve`/`readFile`/`createFile` 均为真实调用，验证后还原）

- ORB 编辑器：fixture `two.orb`（kind=7，两点）→ 命令 → 对话框（画布 533×400 fit，`已选 0 / 共 2 · 类型 7 · two.orb`，octave 1/2 开关各计 1）→ 点击 (100,120) 选中该点 → "删除选中" → `已选 0 / 共 1` + "已删除 1 个点" → 合并同 fixture → `共 3 个点` → 合并 kind=8 文件 → "orb kind mismatch: 7 vs 8" 且文档仍 3 点 → "保存为…" → `saved.orb` 134B（8+3×42）kind7、p0=(10,20)，原 `two.orb` 未写。
- 畸形文件：`bad.orb`（"not an orb"）→ 命令 → 警告 `无法解析 ORB 文件：orb count overflows`，对话框未打开。
- AprilTag：对话框 → end=1 → "生成 2 个 PNG…" → 目录 `/tmp/nodu-tags` → `tag16h5-0.png`/`tag16h5-1.png` 各 192×224（8×24+32 label）写入成功 → 原样再跑 → "目标文件已存在，未写入任何文件：tag16h5-0.png"，两文件未变。
- 外链：spy `opener.getOpener` 捕获三命令 URI，分别为 `…/search?q=qr+code+generator`、`…/search?q=data+matrix+generator`、`…/search?q=barcode+generator`（URI.toString 百分号编码形式）；未实际打开浏览器。
- 阈值对话框 fit 修复回归：注入真实 JPEG 帧 → 帧缓冲源 → raster 实测 347×260（=260·320/240）完整落于 260px 视口、不裁剪，Copy 行与 6 滑条在视口内。
- 截图：`threshold-dialog-1520-fit.png`（修复后，DOM 断言 raster 高=视口高）、`keypoints-dialog-1520.png`（含选中点）、`apriltag-dialog-1520.png`。

## 已知限制

1. 原生打开/保存对话框本身不可由 CDP 驱动（以 stub 返回固定 URI）；读取/创建为真实 FileService 路径。
2. 画布指针事件经合成 `PointerEvent` 驱动（`setPointerCapture` 在合成事件下未报错）；真实触摸板/鼠标手势路径与悬停读出的人工验证未做。
3. ORB 合并/删除后 "类型" 保持原 kind 值；normalized 标志不序列化（与原版一致）。
4. AprilTag 批量写无自动覆盖/删除；目录级失败（权限等）只报告到捕获的错误。
5. 未做板端/硬件验证；离线注入/合成路径已在各条注明。

## 复审修复（2026-10-19 补）

- `orb.rs edit`：空 `keep` 语义修正为"保留 0 点"（此前 `!keep.is_empty()` 分支把空列表当"全保留"——全删 bug）；`keep.len() > points.len()` 在 `Vec::with_capacity` 之前拒绝；新增回归 `empty_keep_removes_every_point`（fixture,[],[] → 恰好 8 字节头 kind=7 count=0）。`cargo test -p nodu-imaging orb::tests` 5/5 通过。
- 关键点编辑器：移除 scale 下限 0.05，改用 `min(640/extent.w, 400/extent.h)`（正 extent 保证 65535 坐标仍可 fit）；角度射线 y 方向修正为 `cy - sin(rad)·12`（对齐 Qt 源）；点击半径/拖拽阈值改按 CSS 像素换算（`radiusSource=8·canvas.width/rect.width/scale`，`movedCSS=sourceDist·scale·rect.width/canvas.width`）；仅左键可按下、busy 守卫（pointerDown/deleteSelected/keyDown）、pointerCancel/lostpointercapture 清拖拽态、pointerUp 释放 capture、`setPointerCapture` 防御性 try（合成事件无 active pointer 不抛错，真实指针正常 capture）。
- `pickBinaryFile`/`pickImageFile`：readFile 加 `{limits:{size:maxBytes}}`，防预检后文件增长导致无界分配；保留 resolve 尺寸预检与读后续长复检。
- AprilTag：`await renderTagPng` 后、`createFile` 前重查 cancel/disposed；预检阶段也查；finally 的 setMessage 加 alive 守卫；`renderTagPng` 返回 `{bytes,width,height}`，预览与输出都用实际尺寸；label 开启时输出宽 `max(tagW, ceil(measureText)+16)`、tag 水平居中——cell=4 实测输出 87×64（标签不再被裁）。
- UI 实测（CDP 4196 真鼠标管线 `Input.dispatchMouseEvent`）：`far.orb`（(10,20) + (65000,65535)，92B）画布有界 397×400；越界点须覆盖到画布边缘才命中框选（extent=坐标极值）；拖选删 far 点 + 点击选 near 点 + 全删 → `已选 0 / 共 0` → "保存为…" → `empty2.orb` **恰好 8 字节** kind=7 count=0；对已存在的 `empty.orb` 保存被 `overwrite:false` 正确拒绝并显示错误。
- AprilTag 取消边界：`canvas.toBlob` 挂起桩 → 批量 30 张生成中首个 toBlob pending 时按"取消生成" → 释放后目录 **0 文件**，提示"已取消：写入 0 / 30 个文件"。cell=4 输出 87×64 PNG 与预览尺寸一致（实际尺寸回读）。
- 限制沿用：原生对话框 stub；测试桩均于验证后还原/页面重载恢复。
