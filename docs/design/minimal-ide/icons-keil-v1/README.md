> 历史设计方案：用户实际查看后认为过于复杂，产品已恢复简洁锤子/箭头SVG。以下保留生成记录，不再作为生产资源。

# 极简模式操作图标 v1

2026-10-24，使用内置 `image_gen` 生成，透明 RGBA PNG，1254 × 1254。alpha 验证见 validation.json。曾接入预览，用户后续决定不用此方案。

- `compile.png`：模块汇聚编译。
- `flash.png`：向下箭头写入芯片。
- `compile-flash.png`：源文件汇聚后写入芯片。

参考：Keil 官方《Getting Started: Creating Applications with µVision》，第65页 Build Toolbar，https://www.keil.com/product/brochures/uv4.pdf 。设计仅参考 Build/Download 的操作隐喻，重新绘制简化灰色图形。

预览阶段曾通过 CSS alpha mask 以主题前景色显示，未修改图像像素。生产资源与 CSS 引用已移除，最终图标使用简洁 SVG。

## 生成提示词

三张各调用一次内置 image_gen，transparent_background=true，参考图为官方手册第65页截图。

共同提示词：

```text
Use case: logo-brand. Create ONE original raster toolbar icon for Nodu, a minimalist embedded code IDE. Reference the attached Keil official toolbar page ONLY for the visual metaphor of build/download, not its typography or its page layout. A refined contemporary redraw. Transparent RGBA canvas, genuine alpha, no white or colored background, no checkerboard, no shadow, no glow, no gradients, no 3D. A single flat monochrome slate-gray (#59616D) icon with consistent crisp rounded 1.7-unit strokes on a conceptual 24x24 grid. Sharp simple geometry and generous negative space, readable at 22px. The icon centered with equal padding, occupies about 65 percent of a square canvas. No text, letters, labels, frame, button container or mockup. Design must match the other two icons of this family.
```

compile：

```text
COMPILE / BUILD: Keil-inspired build symbol. Three small square source modules above a shallow rectangular building tray, a simple central downward arrow assembling them into a neat two-by-three block grid. Simplify to very few shapes; avoid hammer, wrench, gears. Clear small-size silhouette of code being assembled.
```

flash：

```text
FLASH FIRMWARE: a strong straight downward arrow entering the center of a compact microcontroller chip outline. Chip in lower half with just two short pins per side and two pins at the bottom. Arrow head clearly visible inside chip. The simple download-to-chip metaphor, no cloud, no cable, no text LOAD.
```

compile-flash：

```text
BUILD AND FLASH IN ONE ACTION: an original tightly integrated compound icon, visually ordered top to bottom: three small square source modules at upper left/top, then one simple downward flow arrow entering a compact microcontroller chip at lower right/bottom. Same chip and arrow shapes as FLASH icon, same source squares as COMPILE icon. Modules feed the arrow so it reads assemble then write. It is one unified 24x24 glyph, not two large unrelated icons pasted together, not a plus sign, no hammer.
```
