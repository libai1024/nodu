# 窄侧栏偏好入口 A/B

2026-10-24。两张相同窗口尺寸、源码、主题、窄栏宽度的 UI 概念稿；仅设计，无产品代码改动。

A：narrow-a-preferences.png。底部单齿轮，弹层集中主题、模式、字号、自动保存、自动换行、缩进及全部设置。收起后常驻控件最少。

B：narrow-b-vertical.png。主题、设置、模式三图标纵向排列，一次点击切换。三个主操作随较高的底部偏好区上移，侧栏不加宽。悬停提示用于解释模式图标。

实现目标宽度为 48–52 逻辑像素；图像为概念渲染，不能直接将图像像素当产品 CSS 尺寸。均无 AI 功能。推荐 A 保持最低常驻密度；B 适合频繁切换主题与模式。

生成工具：内置 image_gen。以下记录实际完整提示词。

## A

Use case: ui-mockup. Produce variant A of a refined Nodu IDE narrow-rail design. Edit the attached screenshot. Output one full 1536x1024 app screenshot, NOT a presentation board. Keep the same titlebar "uart-demo — Nodu", tabs main.c and board.h, same 14 C code lines and highlighted line11, and existing bottom device status. No AI anywhere.

CRITICAL: make the permanent left icon rail SLIMMER than the reference: exactly about 72 image pixels wide (representing 48 logical px). The entire editor starts at x72, tabs also start at x72. Never widen the rail to fit icons. All rail icons centered at x36. Thin cool-gray separator, cold white editor, matte pale-gray rail. Logo 28px. Upper folder, search, device-chip, output icons 20px, equally spaced in 48px high cells. REMOVE upper settings gear; no gear above mid-screen. No expanded file tree. Preserve calm empty editor canvas and restrained typography. Code moves left with narrower rail, no enlarged code font.

Bottom of rail:
Three vertical main controls, compact and anchored in lower-left. Small hammer and label "编译", play triangle and label "运行", download tray arrow and label "烧写". Cells about 64 image pixels high, no bright fills, labels small 14px. Place these centered around y735, y805, y875 respectively. One fine divider near y922.
Under divider: ONLY ONE gear icon at x36,y954 with a pale 32px active background. No sun icon, no mode icon permanently on rail. This is the single-entry variant. Rail ends at bottom of window. Noninteractive statusbar remains right of rail.

Open one compact native popover immediately right of the bottom gear, ABOVE it, roughly x84,y620,width300,height340. It overlays blank lower-left editor canvas, never pushes or resizes code. No popover title, no explanation, no second-level headings, small 6px corners, fine border, subtle shadow. Seven concise controls:
row1 left "主题", right two compact icon choices sun and moon, sun selected;
row2 left "模式", right a compact segmented toggle "极简" selected and "专业" unselected;
thin divider;
row3 left "字号", right small stepper "− 15 +";
row4 left "自动保存", right compact dark-gray ON switch;
row5 left "自动换行", right compact light-gray OFF switch;
row6 left "缩进", right small dropdown "4";
thin divider;
row7 "全部设置…" with right chevron.
42px row rhythm maximum, tidy aligned margins. Professional/minimal here are UI layouts, not an AI widget. Small cursor beside bottom gear, not covering icon. All text crisp Chinese. No huge card, no marketing, no mode badge in editor, no top toolbar, no duplicated gear. The narrow permanent rail must visibly occupy less than 5% of image width. Other than this localized narrow-rail/footer/popover correction, preserve the reference.

## B

Use case: ui-mockup. Create variant B from this exact variant A Nodu screenshot. Preserve EXACT same image dimensions 1536x1024, left rail WIDTH, theme, titlebar, logo, top folder/search/chip/output icons, editor geometry, file tabs, line-number gutter, identical C source and highlighted line11, and bottom statusbar. This is a paired comparison; do NOT redesign or widen anything. Permanent rail remains very narrow, approximately 50 logical pixels. Absolutely no AI.

ONLY modify lower-left controls:
1. Remove the entire open settings popover, restoring plain empty white editor behind it.
2. Replace the ONE gear at rail bottom with THREE icons stacked VERTICALLY in one centered column: SUN for theme, GEAR for settings, SPLIT-PANEL rectangle for mode. No text labels on these three small icons. Each 20px icon in a 40px hit area, with a few pixels vertical gap. The centers should be approximately y850, y900, y950, all at x45 (the exact horizontal center of the reference rail). They are emphatically NOT side by side. A faint hover background on the bottom mode button only.
3. Move the existing three main operation controls "编译", "运行", "烧写" upwards by about 100px as a unit, keeping their icon styles, spacing and small Chinese labels. They remain in the lower half of the rail. Around y600 for compile, y675 run, y750 flash. Fine separator above main actions, and one fine separator between flash and the three vertical preferences icons around y810.
4. Show only ONE very small native tooltip anchored to the RIGHT of the bottom split-panel icon, saying exactly "切换到专业模式". Width about180–200px, height32px, restrained charcoal tooltip with small white type, minimal 4px corner radius. Small mouse cursor near that icon, not hiding it. No other menu is open.

Do not add settings anywhere in the upper rail. Do not show a permanent text label or current-mode badge. All UI is identical to supplied A except the removed popover and reallocated vertical bottom controls. Cold minimalist white coding IDE, crisp text, no marketing, no captions, no oversized cards, one complete desktop screenshot.
