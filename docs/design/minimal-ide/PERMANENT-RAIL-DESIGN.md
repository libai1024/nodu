# 常驻窄侧栏方案

2026-10-24。按用户最新纠正，此稿替代上一版宽侧栏作为当前设计方向。仅设计，未修改产品界面。

## 布局

最左侧约 56–60 逻辑像素宽的常驻图标栏。文件、搜索、设备、串口/输出、设置在上部；编译、运行、烧写固定在左下角，垂直排列，不随内容滚动。操作名称仅保留两个字，详细语义与快捷键用 tooltip。

文件树是图标栏旁可展开的独立面板，默认收起；再次点击文件入口可关闭。图标栏始终保留，不再使用上一版“全部隐藏后仅留恢复按钮”的行为。顶部只保留原生标题和文件标签，无重复操作工具栏。无 AI、教学或推荐入口。

设备参数在芯片图标的弹层设置。底栏只反馈当前芯片、方式与状态；图中的连接状态是设计示意，不是实际设备证据。

## 行为边界

STM32：编译生成固件；运行保持现有保存/编译/下载的完整流程；烧写使用当前有效产物进入下载流程，保留旧产物阻止与设备校验。其是否重启由下载方式及产品实现决定，不承诺无复位烧写，也不把运行画成 MCU 调试继续。取消只在相应事务中提供。

K210：现有 Python 运行执行当前缓冲区，运行时可停止脚本。隐藏不适用的 C 编译按钮，普通脚本运行不等同刷写固件；固件维护保留在设备操作中，不为了凑齐三个图标新增高频刷固件入口。

## 参考与产物

参考 Arduino 官方对工具侧栏的划分；将编译/运行/烧写移至左下角是用户要求的 Nodu 定制布局，并非声称 Arduino 原版使用此摆放。

参考：[Arduino 官方 IDE 说明](https://github.com/arduino/docs-content/blob/main/content/learn/01.starting-guide/02.the-arduino-software-ide/arduino-software-ide.md)。

设计稿：permanent-rail.png。内置 image_gen 生成，完整提示词如下。

Use case: ui-mockup. Correct the Nodu IDE design in the supplied image. The user does NOT want the large project/file sidebar shown in the reference. They want an Arduino IDE-style permanent NARROW vertical ICON RAIL at the far left, with compile, run, flash controls pinned at its bottom. Produce one exact high fidelity 1536x1024 landscape screenshot of the revised design. Reference is the prior layout, which must be corrected. No presentation board, annotations, captions or text outside the app.

Preserve: native macOS window, thin titlebar with traffic lights and centered "uart-demo — Nodu"; cold off-white editor, fine silver separators, clean typography, main.c and board.h tabs; the same small 14-line C program; bottom status row. No AI functionality whatsoever.

REPLACE the entire 368-pixel-wide old left sidebar with a VERY NARROW permanently visible icon rail, approximately 60 pixels wide in the entire 1536px image (4% of the total width). The rail background is matte cool gray #EEF0F2 with one thin right separator. This rail is never hidden. There is NO expanded file tree, NO project-name row, NO chip dropdown panel, NO wide action buttons, NO second sidebar. The code editor expands to use the freed space, starting immediately to the right of the 60px rail. Top document tabs start immediately right of this rail below the native titlebar. Remove the previous top compile/run toolbar completely.

Permanent rail TOP:
- original small Nodu black/yellow logo, centered in 40px area
- a folder outline icon (files)
- a magnifying glass outline icon (search)
- a microchip outline icon (device)
- a terminal/serial waveform outline icon (serial/output)
- a settings gear outline icon
All thin precise monochrome 20px icons, centered in 44px-tall hit areas, no large filled buttons, no text paragraphs, no navigation labels, no duplicate tools.
Then leave the entire rail's middle empty.

Permanent rail BOTTOM, fixed flush to the bottom-left of the app above statusbar:
one fine short separator and THREE vertically stacked action buttons, all at the same x-coordinate inside the rail. Each about 54px tall including icon and very small two-Chinese-character label.
1. outline hammer/check icon, label EXACTLY "编译".
2. outline play triangle icon, label EXACTLY "运行". This central play button gets only a soft pale graphite hover-sized square, not a bright colored large block.
3. down arrow into tray icon, label EXACTLY "烧写".
All three must be clearly visible in the LOWER LEFT CORNER, not the top, not the editor, not across a horizontal toolbar. Do not add a permanent stop control in idle state. Do not add an AI sparkle icon. The three short labels identify the user's specifically requested operations, no explanation text.

Main editor:
same 14 lines of actual C code from reference. Monospace 15px-like with muted syntax colors, normal width indentation, no fake extra line numbers, no minimap, no breadcrumb. Tab main.c active, board.h inactive, a close glyph in active tab. Active line11 softly shaded. Main code occupies only upper portion, plenty of calm whitespace below. Natural editor position x around 110px including gutter, not centered horizontally. Code:
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

Bottom slim passive statusbar starts to the right of the rail: left a tiny muted green dot then "STM32F103C8T6", a thin vertical separator and "ST-LINK"; far right "行 11, 列 9" and "C". No middle-dot text joins. Target info is quiet passive text, not a large button. No bottom console currently open.

Feeling: understated professional Arduino-like navigation structure with Nodu identity, cold minimalist coding tool, absolutely no expanded explorer initially. Tiny persistent functional rail, huge editor, exact fine alignment. Do not reuse the full-width sidebar from reference.
