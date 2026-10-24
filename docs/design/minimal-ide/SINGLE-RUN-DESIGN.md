# 单运行入口设计稿

2026-10-24。按用户要求仅绘制一个版本，未修改产品代码。

产物：single-run.png。设置移至终端图标正下方；左下角仅保留运行按钮；删除常驻编译与烧写按钮，窄栏宽度不变。主图展示设置弹层关闭的默认状态。主题与模式仍可从设置弹层调整。

运行语义沿用当前工程类型：STM32 的保存、编译、下载流程；K210 的当前 Python 缓冲区执行。单独编译与烧写等次级操作的具体菜单入口留待交互设计，不将图中按钮移除等同于删除能力。

内置 image_gen 生成，完整提示词：

Use case: ui-mockup. Make a precise minimal layout edit to the attached Nodu IDE screenshot. Produce ONE updated 1536x1024 full-window screenshot, with the same cool white aesthetic, slim permanent left icon rail, titlebar, code, tabs, source line numbers, highlighted source line11 and bottom status. This is a new simpler default CLOSED-menu state.

Exact requested changes:
1. REMOVE the entire currently open preferences popover. Restore plain white editor behind it. No menu or tooltip is open.
2. In the UPPER left icon group, keep Nodu logo, folder, search, and microchip icons in their original order and positions. Below microchip, replace the waveform/output glyph with a clean outlined TERMINAL icon (small rectangle containing >_). Directly BELOW this terminal icon, add a SETTINGS GEAR icon with the same spacing, size, line weight and color as adjacent icons. This is now the ONLY settings entry. All upper icons aligned at the center of the same narrow rail. No text labels by these navigation icons.
3. Completely REMOVE the lower hammer/compile button and its "编译" label.
4. Completely REMOVE the lower down-arrow/flash button and its "烧写" label.
5. Completely REMOVE the previous bottom settings gear, its hover background and cursor.
6. At the VERY BOTTOM LEFT of the narrow rail, centered just above the statusbar baseline, show ONLY ONE run control: a simple dark graphite outline PLAY TRIANGLE, with a small short label "运行" underneath. Approximate play icon center x45,y927, label y958. A compact 40px hit area, no large colored block, no pill, no dropdown chevron. No stop or compile or flash or theme or mode icons near it.
7. The middle rail between upper settings and bottom run stays empty. Remove old intermediate separators around the removed compile/flash/preferences groups. A single short hairline divider above the lone bottom run around y890 is acceptable.
8. Keep rail same narrow width as attached image; never widen it. Main editor starts in the exact same x position as reference. No file tree, no new top toolbar, no right sidebar.

Preserve all source code and header: title "uart-demo — Nodu"; tabs main.c and board.h; original 14-line STM32 program; muted selected line; status "STM32F103C8T6", separator, "ST-LINK", right "行 11, 列 9" and "C". These are mock UI states. No AI features, no instructions, no explanations, no headings, no popovers, no big cards. Clean calm coding-only IDE with settings directly under terminal and ONLY run in the lower left.
