# STM32 扇形动作选择器

2026-10-24。按用户红笔草图修订：以纯图标扇形选择替代矩形动作菜单。仅设计稿，未修改产品代码。

产物：radial-actions.png。左下角主按钮无文字、无箭头，沿侧栏中心线对齐。长按后向右上方展开四分之一环形，三个相邻扇区分别为上部编译（锤子）、中部编译并烧写（左上锤子与右下写入箭头的有序组合）、右下烧写（向下写入托盘）。选中项浅灰底，无常驻说明文字。名称在悬停或键盘聚焦时显示。无下载帮助、固件位置等其他菜单项；不代表删除原能力。

## 交互约定

- STM32 长按约 500ms 打开，只选择动作，不触发编译/烧写。抑制长按生成的 click；松开本次长按不得执行主动作或误选扇区。移出、失焦、pointercancel 取消尚未完成的手势。
- 选择后更新当前动作和对应主按钮图标，始终居中；下一次短按执行。按工程记忆。忙碌时禁切模式。此处是动作模式，不改变 ST-LINK/ISP 下载方式。
- 单独烧写保留固件新鲜度、工程和目标校验，不能隐式烧写旧产物。K210 不展示选择器，保留现有运行/停止流程。
- 右键及 Shift+F10/菜单键打开相同选择器；方向键在三项间移动，Enter 选择，Esc/外部点击关闭，焦点返回主按钮。每项具备可访问名称及单选状态。
- 侧栏目标 48–52 逻辑像素；主按钮约 36px。三个扇区应各容纳至少 36–40px 有效点击区域，展开方向固定右上，边缘避开状态栏。
- 图稿仅表达样式；实际几何必须用主按钮中心作为圆心并计算视口边界，不逐像素照搬生成图片。组合图标在与单图标相同的图标框中设计，避免视觉重量过大。

## 生成记录

内置 image_gen，参考用户附带的红笔草图，完整提示词：

Use case: ui-mockup. Turn the user's red hand-drawn sketch on the latest attached Nodu IDE image into a refined native-style QUARTER-CIRCLE RADIAL ACTION SELECTOR. The red drawing is an instruction sketch, never part of the final visual. Preserve the underlying Nodu window, slim left icon rail, titlebar, tabs, C code and bottom status. No AI features. Single full-window 1536x1024 screenshot.

Remove ALL red marks, all checkboxes, the old rectangular menu, all menu words "编译", "编译并烧写", "烧写". Do not retain any rectangular popup.
The ONLY new element is a precise compact quarter-annulus radial menu that opens UP AND RIGHT from the lower-left play button. The original play button remains horizontally centered in the narrow rail. No arrow next to it, no word "运行" below it. Keep the original top gear below terminal.

Geometry is important:
- Pivot at the center of the lower-left play button, approximately x45,y938.
- Menu extends ONLY into the upper-right quadrant, spanning angles from straight up to straight right, a true 90-degree quarter circle. It must NOT be a full circle or semicircle.
- Inner radius about 55 image pixels; outer radius about 195 image pixels. Therefore its maximum right edge x240, top y743, bottom y938, comfortably ABOVE the bottom statusbar.
- Three equal 30-degree annular sectors form ONE continuous fan. Fine 1px neutral-gray dividing radial lines. Soft near-white surface, light gray border around outer and inner arcs, very subtle shadow. No bright colored sectors, no thick outlines, no detached floating round buttons, no giant pie.
- Inner cutout leaves clear separation from the originating play button.
- Each sector contains ONE simple monochrome graphite action glyph, equally sized and centered around radius125px at angles 75,45,15 degrees from rightward. All icons upright, not rotated with the arc.
   Upper sector: COMPILE icon, a precise small outline hammer, around x77,y817.
   Middle diagonal sector: COMPILE + FLASH combined icon, around x133,y850. Purpose-designed 28px composite glyph: a small diagonal hammer in upper-left and a distinct down-arrow entering a shallow tray in lower-right, arranged orderly with enough negative space, unified thin stroke weight. Clearly represents both hammer and write/download, NOT a play triangle, NOT overlapping scribbles.
   Right/lower sector: FLASH icon, a clear small downward arrow into shallow tray, around x166,y906.
- Middle sector selected via a very subtle pale gray fill, other sectors white. No checkboxes, no text, no numbered labels, no badges. No visible tooltip in this screenshot.
- Three icon glyphs must remain visibly distinct: hammer alone; hammer+download combined; download alone.
- Menu reads like a precision industrial design tool, mature and minimal. Fan compactly emerges from button into empty lower editor area, does not move underlying layout or obstruct statusbar.
Keep editor/source unchanged, no presentation captions, no explanatory arrows or visual motion trails. Cold quiet grayscale UI. REMOVE ALL USER RED PEN ANNOTATIONS AND THE OLD RECTANGULAR MENU. The finished result is a clean polished implementation concept of the sketched quarter-circle icon picker.
