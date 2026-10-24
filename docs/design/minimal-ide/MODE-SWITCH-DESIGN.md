# 模式切换菜单设计稿

2026-10-24。仅视觉设计，未修改产品代码。

图：mode-switch-menu.png。左侧常驻设置入口展开菜单，顶部直接提供极简模式/专业模式，当前模式打勾；下方分隔外观、编辑器设置和快捷键。支持键盘选择，切换后保留编辑现场，分别保存两种模式布局；极简模式不显示 AI。鼠标悬停专业模式不代表已经切换。

生成方式：内置 image_gen，参考 permanent-rail.png。完整提示词：

Use case: ui-mockup, precise localized UI edit. Edit the attached Nodu IDE design to demonstrate switching minimal/professional modes via the left rail Settings menu. Preserve the entire existing image exactly as far as possible: 1536x1024 single desktop app window, cool white palette, macOS titlebar, permanent narrow left icon rail, code editor and tabs, code text, bottom status, and the three compile/run/flash buttons anchored at lower left. Do NOT change the sidebar width or expand a file tree. Do NOT add any AI panel, top toolbar, giant explanation or presentation callouts.

Make only these changes:
1. The existing settings gear in the left rail near x48,y391 receives a subtle light gray 36x36 active background.
2. Show one SMALL native desktop popover menu anchored immediately to the RIGHT of that gear, beginning roughly x100,y365. The menu overlays the editor, does not reflow the code. Width about 240 pixels, height about 220 pixels. Near-white matte background, thin cool-gray 1px outline, 6px corner radius, very soft restrained shadow. No triangle arrow needed. Compact 36px menu row height with 10px outer vertical padding. Typography matches existing UI, clean and legible Chinese.
3. The menu has EXACTLY these five rows with ONE divider after row2:
   Row1: a small checkmark in the left check gutter followed by "极简模式".
   Row2: blank check gutter followed by "专业模式".
   Thin horizontal separator.
   Row3: "外观"
   Row4: "编辑器设置"
   Row5: "快捷键"
4. Row1 is currently selected via the checkmark only. Row2 has a faint neutral gray hover background and a small standard arrow mouse cursor near its right edge, showing it is ready to click. No checkmark on row2. No submenu chevron on either mode row. No heading such as '模式' or '设置' above the menu, no captions, no explanatory descriptions, no hotkey text or secondary labels, no giant toggle switch.
5. The run button at the lower left should be neutral (remove its prior hover fill), so the settings/menu is the only hovered area.
Keep all other visual elements and placements invariant. This is an understated mature IDE settings menu, not a new settings screen. Clear small menu, simple two-choice mode switch, single screenshot.
