# 单运行入口与次级操作菜单

2026-10-24。基于用户认可方向继续设计；尚未修改产品代码。

设计稿 run-dropdown.png：常驻窄栏，设置在终端下方，左下角仅运行主入口和一个小下拉箭头。菜单包含编译、烧写、固件位置，分隔线后为下载帮助；菜单从按钮右上方展开。当前展示 STM32 工程，K210 菜单需要按现有脚本能力提供对应操作，不能套用 C 编译入口。

主按钮执行运行，下拉箭头仅打开菜单，不隐式启动编译或设备操作。实现时两块区域独立键盘可达、有可访问名称；Esc 关闭后焦点回箭头，关闭菜单不改变工程下载方式；窄栏宽度不能以牺牲点击区为代价。主题和模式仍从设置弹层访问。

内置 image_gen 生成，完整提示词：

Use case: ui-mockup. Create a polished next-iteration Nodu minimalist desktop IDE design by making a small localized edit to the supplied screenshot. Output ONE full 1536x1024 screenshot, same layout and proportions. Keep the permanent narrow left icon rail, titlebar, Nodu logo, folder/search/device/terminal/settings icons, tabs, code, active line and bottom status exactly consistent. This is the approved design direction: settings immediately BELOW terminal, ONLY a run control at lower left, no AI, no extra toolbar, no expanded file sidebar.

Refine only the bottom Run control and show its secondary actions:
- Retain a slim 48–52 logical-pixel rail. DO NOT WIDEN the rail to fit the new affordance.
- At lower left, keep the outline play triangle with small label "运行" below.
- Add a small thin downward chevron to the RIGHT of the play triangle within the existing rail width. The play and chevron are two separately clickable parts of one compact control, but no heavy borders or colored pill. Shift play left a little so the chevron fits. The label stays centered underneath.
- Chevron has a very subtle gray hover state, with a small cursor near it. No run-in-progress state.
- Open ONE compact native dropdown ABOVE AND TO THE RIGHT of the run control, over the blank lower editor area. Approximately x100, y754, width248, height198 in the 1536x1024 image. Menu must never overlap rail icons or bottom status. White matte surface, fine cool-gray outline, small 6px corners, very restrained soft shadow.
- Menu contents EXACTLY:
row1 small hammer outline icon and "编译"
row2 small download-to-tray outline icon and "烧写"
row3 small folder outline icon and "固件位置"
thin horizontal separator
row4 small circle-question outline icon and "下载帮助"
No menu title, no subtitle, no descriptions, no keyboard shortcuts, no repeated "运行" row, no second-level headings, no mode menu, no settings popover. 38px compact row rhythm, small consistent 16px iconography, clear restrained Chinese 14px-like typography.
- Keep settings at upper rail right below the terminal, unselected. Theme/mode are reached there but NOT drawn open in this image.
- Keep upper icon rhythm precise, consistent 18–20px glyph sizes and fine stroke weights. Narrow rail middle is calm empty space.
- Do not add compile or flash permanently to the rail. They are ONLY in this opened menu.
- Preserve all 14 lines of code, but use slightly more restrained desaturated blue keywords, sage-green strings, graphite main text, soft teal numerals; clear contrast. Avoid saturated neon syntax colors. Current-line highlight pale cool gray-blue.
- Bottom status still reads "STM32F103C8T6", fine separator, "ST-LINK", far right "行 11, 列 9" and "C". No textual claims of successful flashing.

This should look like a mature, quiet, precise desktop coding tool: cold white, graphite, fine separators, huge editor canvas. No AI functionality, no teaching, no sparkles, no recommendations, no decorative cards, no other popovers, no presentation captions. Only approved narrow sidebar plus subtle run dropdown refinement.
