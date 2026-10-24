# 左侧操作栏方案

2026-10-24。无 AI 极简模式的第二版设计；仅设计稿，未修改产品代码。

- 默认展开约 256px 宽的左侧栏，可拖动调整宽度。顶端提供收起按钮；收起后编辑器铺满，仅在标签栏左端保留恢复按钮，支持键盘操作。记住用户选择、宽度、目录展开和滚动状态。
- 取消顶部功能工具栏。侧栏自上而下为：项目菜单、芯片与连接状态、编译/运行、文件树；底部固定串口/输出/设置入口。文件树独立滚动，长文件名截断并提供完整名称提示。
- STM32 提供独立编译、运行分裂按钮，运行执行编译和下载。取消仅在事务进行中提供，不能误称停止 MCU 程序。下载方式和下载帮助放运行菜单。
- K210 使用相同布局，去掉独立编译，运行时提供停止脚本。设备保存、开机脚本在运行菜单；摄像头视图从侧栏输出菜单打开。类型差异不靠常驻说明文案解释。
- 串口与输出的内容区可在编辑器下方展开，主要功能入口仍在左侧。项目菜单提供新建/打开；设置及搜索等次级功能使用侧栏菜单。设备选择展开弹层，不在栏中塞入串口参数表。
- 编译和下载的阶段与进度在侧栏操作区就地反馈；侧栏关闭时用底栏非交互进度反馈，避免藏住任务状态。错误详情进入输出面板，操作所需引导使用弹窗。
- 冷白编辑区、银灰侧栏、石墨色主按钮、细分隔线。图中连接状态和源码为示意，不是硬件测试记录。

## 设计稿

- 默认展开：sidebar-expanded.png
- 收起：sidebar-collapsed.png

## 生成记录

内置 image_gen，参考上一版 concept.png 的品牌和编辑器结构。以下为实际使用的完整提示词。

### 展开态

Use case: ui-mockup. Design a NEW alternative layout of the Nodu desktop code IDE in the supplied reference. The reference is ONLY a style/logo/code context reference; radically MOVE ALL FUNCTIONAL CONTROLS INTO A LEFT SIDEBAR and REMOVE THE ENTIRE TOP ACTION TOOLBAR. This is a restrained minimalist coding mode, absolutely NO AI features. Produce ONE large high-fidelity 1536x1024-style landscape app screenshot, no comparison sheet, no labels outside the window. Crisp readable text, exact aligned geometry, native desktop polish.

App structure:
- a slim macOS titlebar, subdued traffic lights, centered title "uart-demo — Nodu". Nothing else in titlebar.
- Below titlebar, LEFT SIDEBAR about 256 logical pixels wide / 20% window width, default OPEN, full height. Pale cool gray #F0F2F4, flat surface, one fine vertical separator. Right editor cold white #FAFBFC. NO additional narrow activity rail.
- Sidebar top row: very small original Nodu black rounded square/yellow logo, project text "uart-demo", small downward chevron, and at far right a sidebar-collapse icon. Align every row to a consistent 16px inset.
- Next row: a small muted green status dot, "STM32F103C8T6" and down chevron, elegant borderless selector. No subtitles, no secondary descriptions, no word "开发板".
- Next row: two compact adjacent controls occupying available sidebar width: left subtle outlined "编译", right wider graphite "▷ 运行" with narrow dropdown chevron segment. Only 30px high, small 4px corner radius, graphite button NOT bright blue. Do not put a stop button in this idle state.
- 14px breathing space then one thin horizontal rule.
- File tree fills middle of sidebar, compact 26px rows, NO section heading. Tree shows an expanded folder "Core", nested expanded folder "Src", selected file "main.c"; sibling expanded folder "Inc", child "board.h"; then collapsed folders "Drivers" and "build"; root files "CMakeLists.txt" and "nodu.json". Use tiny consistent monochrome outline file/folder glyphs, restrained C file icon, no rainbow icon set. Selected main.c row flat slightly darker cool gray, minimal 3px slate-blue left marker. No pills or cards. Meaningful indentation but not excessive.
- Sidebar bottom pinned: thin rule then three compact 30px rows with fine outline icons and exact short labels "串口", "输出", "设置". No footer branding, no slogan, no subheadings, no explanatory copy.
- RIGHT area starts DIRECTLY with 30px document tabs just below native titlebar: active "main.c" and inactive "board.h". Active underline a very subtle muted slate blue, active close glyph. No top toolbar above these tabs and no right-side functional toolbar.
- Below tabs, big elegant code editor with a narrow line-number gutter, one subtle active line, no minimap, no breadcrumb, no text guidance. Readable 15px monospace, UI 13px native sans. Desaturated C syntax: muted blue keywords, soft sage strings, graphite identifiers, restrained teal numerals.
Display exactly this plausible short program with natural blank lines and accurate sequential line numbers 1 through 14 (NO numbers outside actual source):
#include "board.h"

int main(void)
{
    Board_Init();
    Board_DebugUartInit(115200);
    const char message[] = "STM32 ready\r\n";

    while (1)
    {
        Board_DebugWrite(message, sizeof(message) - 1);
        HAL_Delay(1000);
    }
}
Keep code near top, lots of calm blank editor canvas below. Do not stretch font to fill area. Current-line tint at line11 and thin caret.
- A very thin 22px status strip BELOW EDITOR ONLY, subtle noninteractive "行 11, 列 9" and "C" aligned right. No bottom-left controls or status duplicates. Sidebar continues to bottom. No console currently open.

Style: confident, cold, quiet, utilitarian minimalism with pixel-perfect proportions. Sophisticated coding tool, not website/dashboard. Matte neutral surfaces, no gradients, no glow, no card stacks, no marketing, no AI, no sparkles, no ghost text, no task panel, no floating assistant, no oversized text. Sidebar contains EVERY run/device/project/output/settings control. Only native titlebar and document tabs above editor.

### 收起态

Use case: ui-mockup. Edit the supplied Nodu IDE mockup to show ONLY the SIDEBAR CLOSED state of the exact same design. Keep identical app window size, native macOS titlebar and title "uart-demo — Nodu", colors, typography, C code, main.c and board.h tabs, highlighted line11, bottom status. Remove the ENTIRE left sidebar, including project row, chip selector, compile/run buttons, file tree and footer commands. Do not leave any narrow activity rail. The document tabs and editor now expand leftwards to fill all the space under the native titlebar. Only a SINGLE small thin-outline sidebar-open icon is placed at the far left of the document tab strip, within a 36px-wide square before the main.c tab, with a very subtle vertical separator. It is a navigation affordance only, no text label. No other controls are moved into the titlebar, tab strip, editor or bottom status. Absolutely no run, compile, device or settings controls outside the now-hidden sidebar. The same code starts after the normal line-number gutter near the left edge, natural small 15px monospace scale and line spacing maintained, not enlarged to fill width. The bottom right still shows "行 11, 列 9" and "C". No AI features, no slogans, no explanatory text, no floating panels. Crisp high fidelity native desktop design, cool minimal colors, one full-window screenshot only. This is the paired collapsed state to the provided expanded mockup.
