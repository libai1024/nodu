# 侧栏底部三图标设计

2026-10-24。仅设计稿，未修改产品代码。此版按最新要求将主题、设置、模式移至烧写下方同一排，替代设置菜单中的模式选择。

产物：footer-controls.png。左到右为明暗主题切换、极简设置、专业/极简模式切换；图标提供 tooltip、可访问名称、键盘焦点。设置弹层只含字号、自动保存、自动换行、缩进及全部设置入口。模式切换和主题切换均有独立图标，不在设置内重复。侧栏最小宽度按三项实际点击区校验，不按概念图像素直接确定产品尺寸。

内置 image_gen 生成，完整提示词：

Use case: ui-mockup. Precisely update the attached Nodu desktop IDE mockup to demonstrate a new LEFT RAIL FOOTER with three icons in one horizontal row: theme, settings, mode. Also show a compact minimal-settings popover opened from the middle gear. Produce ONE polished high fidelity screenshot, same 1536x1024 landscape app window. No outside annotations or captions.

Preserve the reference: very light cool white/gray native desktop IDE, macOS window title and traffic lights, Nodu black/yellow logo, narrow permanently visible left icon rail, main.c / board.h tabs, existing C code, bottom device statusbar, no AI features, no top action toolbar, no expanded file tree. Right editor remains overwhelmingly dominant. Keep code and positions approximately unchanged except shift editor slightly right to accommodate the adjusted rail.

Rail geometry: widen only modestly from reference to approx 126px in this 1536px image, representing 84 logical pixels at 1.5x scale. Flat cool gray surface. This is still a narrow rail, NEVER a project sidebar. Center existing upper icons on x63: Nodu logo, folder, search, chip, serial/output. REMOVE the old settings gear from the upper navigation group completely. No duplicate settings gear anywhere except bottom footer. No icon labels on top navigation.

Lower-left controls:
- Move the three existing vertically stacked action buttons upward slightly to make room for the footer. They remain fixed in the LOWER LEFT, centered x63.
- Around y700 hammer icon and short label "编译".
- Around y785 play triangle and short label "运行".
- Around y870 download arrow and short label "烧写".
- Leave about 14px gap below flash label then a very fine horizontal divider across the rail at y920.
- BELOW that divider, a SINGLE HORIZONTAL ROW of EXACTLY THREE small 18px outline icons, centers approx x21,63,105 at y966: SUN icon (theme), GEAR icon (settings), SPLIT-PANEL/LAYOUT icon (professional/minimal mode). Equal 42px image-space hit cells, subtle spacing. No labels under or beside these three icons. They are in the sidebar footer BELOW the flash button, NOT placed in the bottom statusbar. No AI sparkle symbol. The gear has a subtle pale gray active square. Everything fits fully inside the 126px rail. Do not vertically stack these footer icons.

Compact settings popover:
Open one small refined popover to the RIGHT and ABOVE the footer gear, roughly x142,y704,width300,height260. It floats over the blank lower editor area and never hides the three footer icons or compile/run/flash controls. Matte near-white background, fine gray border, 6px corners, slight native shadow. No title, no "设置" heading, no description text.
Exactly these five compact rows:
1. Left label "字号", right a small stepper "−  15  +".
2. Left label "自动保存", right a tiny neutral graphite ON toggle.
3. Left label "自动换行", right a tiny neutral gray OFF toggle.
4. Left label "缩进", right a compact dropdown value "4" with down chevron.
Thin horizontal separator.
5. "全部设置…" with a subtle right chevron at the far right.
Consistent 40px rows, 14px margins, clean native Chinese typography. No extra mode choices in this popover: mode now has its OWN rightmost footer icon. No theme choices in popover: theme has its OWN leftmost icon. Show small mouse pointer near the gear without covering it, if needed.

Bottom statusbar only starts at x126 to the right of rail, exact text same as reference "STM32F103C8T6" then separator then "ST-LINK"; right "行 11, 列 9" and "C". No functions in statusbar. Maintain restrained gray/white minimalism, no decoration, no gradients, no giant overlays, no large rounded cards. Product design screenshot, not a diagram. Important invariants: THREE footer icons side by side UNDER 烧写, gear removed from upper rail, settings popover small and concise.
