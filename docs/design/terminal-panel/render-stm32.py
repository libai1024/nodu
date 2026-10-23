#!/usr/bin/env python3
"""Render the STM32 manual-serial UI proposal to an adjacent SVG; no app changes."""
from html import escape
from pathlib import Path

W = H = 1280
# Resolved Nodu light tokens from brand/src/tokens.cjs, v2.1.0.
C = {
    'white': '#FFFFFF', 'panel': '#F7F8FA', 'surface': '#F0F2F5',
    'line': '#E0E3E8', 'input_line': '#868C97', 'text': '#1D2129',
    'secondary': '#3E434C', 'muted': '#5B616C', 'disabled': '#A3A7AE',
    'primary': '#2F5BFF', 'accent': '#2449DB', 'soft': '#EEF2FF',
    'ok': '#187244', 'warn': '#8A5200',
}
UI = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif"
MONO = "'SFMono-Regular', Menlo, Consolas, 'PingFang SC', monospace"
parts = []


def add(s):
    parts.append(s)


def rect(x, y, w, h, fill='white', stroke=None, r=0, extra=''):
    border = f' stroke="{C.get(stroke, stroke)}"' if stroke else ''
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" '
        f'fill="{C.get(fill, fill)}"{border} {extra}/>')


def line(x1, y1, x2, y2, color='line', sw=1):
    add(f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" '
        f'stroke="{C.get(color, color)}" stroke-width="{sw}"/>')


def text(x, y, label, size=14, color='text', weight=400, mono=False, center=False):
    alignment = ' text-anchor="middle" dominant-baseline="central"' if center else ''
    family = escape(MONO if mono else UI, quote=True)
    add(f'<text x="{x}" y="{y}"{alignment} font-family="{family}" '
        f'font-size="{size}" font-weight="{weight}" '
        f'fill="{C.get(color, color)}">{escape(label)}</text>')


def dot(x, y, color='ok', radius=3):
    add(f'<circle cx="{x}" cy="{y}" r="{radius}" fill="{C[color]}"/>')


def chevron(x, y, color='muted'):
    add(f'<path d="M{x-3} {y-1.5} L{x} {y+1.5} L{x+3} {y-1.5}" '
        f'fill="none" stroke="{C[color]}" stroke-width="1.4" '
        'stroke-linecap="round" stroke-linejoin="round"/>')


def button(x, y, w, h, label, primary=False, disabled=False, dropdown=False,
           plain=False, active=False, size=12):
    fill = 'surface' if disabled else 'primary' if primary else 'soft' if active else 'white'
    foreground = 'disabled' if disabled else 'white' if primary else 'accent' if active else 'secondary'
    add(f'<g data-control="{escape(label, quote=True)}" data-box="{x},{y},{w},{h}">')
    if not plain:
        rect(x, y, w, h, fill, None if primary else 'line', 3)
    text(x + w / 2, y + h / 2, label, size, foreground, 500, center=True)
    if dropdown:
        chevron(x + w - 11, y + h / 2, 'disabled' if disabled else 'muted')
    add('</g>')


def tabs(x, y, w, active=1, controls=True):
    rect(x, y, w, 32, 'panel')
    for i, label in enumerate(('构建与下载', '串口监视', '终端')):
        tx = x + 8 + i * 104
        add(f'<g data-tab="{label}" data-box="{tx},{y},104,32">')
        text(tx + 52, y + 16, label, 13, 'text' if i == active else 'muted',
             600 if i == active else 400, center=True)
        if i == active:
            rect(tx + 12, y + 30, 80, 2, 'primary')
        add('</g>')
    if controls:
        for dx in (-5, 0, 5):
            dot(x + w - 88 + dx, y + 16, 'muted', 1.2)
        rect(x + w - 62, y + 11, 10, 10, 'none', 'muted')
        chevron(x + w - 24, y + 16)
    line(x, y + 32, x + w, y + 32)


def logrow(y, time, direction, content):
    text(60, y, time, 13, 'muted', mono=True)
    text(178, y, direction, 12, 'accent' if direction == 'TX' else 'muted', 500, mono=True)
    text(220, y, content, 14, mono=True)


def state_card(x, title, subtitle, detail, kind):
    y, w, h = 766, 384, 356
    rect(x, y, w, h, 'white', 'line')
    text(x + 16, y + 30, title, 18, weight=600)
    text(x + 16, y + 59, subtitle, 13, 'accent' if kind != 'isp' else 'warn', 500)
    text(x + 16, y + 82, detail, 12, 'muted')
    px, py, pw = x + 16, y + 103, 352
    rect(px, py, pw, 188, 'white', 'line')
    tabs(px, py, pw, controls=False)
    if kind == 'swd':
        dot(px + 14, py + 54)
        text(px + 25, py + 58, 'CH340 · COM5 · 已连接', 12)
        button(px + 278, py + 41, 62, 26, '断开')
        line(px, py + 74, px + pw, py + 74)
        text(px + 12, py + 101, 'RX  Temperature: 24.6 C', 12, mono=True)
        text(px + 12, py + 127, 'UART 保持当前连接。', 12, 'muted')
        text(x + 16, y + 320, '下载日志进入「构建与下载」。', 12, 'muted')
        send_disabled = False
    elif kind == 'isp':
        dot(px + 14, py + 54, 'warn')
        text(px + 25, py + 58, 'COM5 正用于串口下载', 12, 'warn')
        line(px, py + 74, px + pw, py + 74)
        text(px + 12, py + 101, '原有日志和草稿保留。', 12, 'muted')
        button(px + 12, py + 113, 116, 24, '查看下载日志', plain=True, active=True)
        text(x + 16, y + 320, '先确认断开监视，再把端口交给下载。', 12, 'muted')
        send_disabled = True
    else:
        dot(px + 14, py + 54, 'muted')
        text(px + 25, py + 58, 'CH340 · COM5 · 已断开', 12)
        button(px + 278, py + 41, 62, 26, '连接', primary=True)
        line(px, py + 74, px + pw, py + 74)
        text(px + 12, py + 101, '恢复 BOOT 配置并复位后，', 12, 'muted')
        text(px + 12, py + 123, '请手动点击「连接」。', 12, 'muted')
        text(x + 16, y + 320, '写入校验完成 ≠ 已确认程序正常运行。', 12, 'muted')
        send_disabled = True
    line(px, py + 150, px + pw, py + 150)
    rect(px + 10, py + 158, 256, 24, 'surface' if send_disabled else 'white', 'line', 3)
    text(px + 20, py + 174, '未发送的草稿…' if send_disabled else '输入内容…', 12,
         'disabled' if send_disabled else 'muted')
    button(px + 274, py + 158, 68, 24, '发送', primary=not send_disabled,
           disabled=send_disabled)


add('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1280" '
    'viewBox="0 0 1280 1280" role="img" aria-labelledby="title desc">')
add('<title id="title">Nodu STM32 专用底部 UI：手动串口监视</title>')
add('<desc id="desc">STM32 的构建与下载、串口监视、终端三个标签。'
    'CH340 COM5 手动连接与文本十六进制收发。下方比较 SWD 下载保留 UART、'
    'UART ISP 让出端口，以及 BOOT 恢复后手动连接三个状态。所有内容为设计示例。</desc>')
rect(0, 0, W, H)
text(40, 54, 'Nodu  /  STM32 串口交互', 30, weight=650)
text(40, 87, '一套面向 STM32 的底部 UI：构建与下载、UART 收发、本机终端。', 16, 'muted')
text(1054, 49, 'UI DESIGN  /  STM32', 13, 'muted', 600)
text(1054, 74, '2026.10.22 · 手动连接', 13, 'muted')
line(40, 108, 1240, 108)
text(40, 145, '01  手动选择，连接后收发', 18, weight=600)
text(746, 145, '首次使用：选择串口 → 波特率 → 点击连接', 13, 'muted')

# Main workbench fragment, intentionally retaining editor context.
rect(40, 164, 1200, 476, 'white', 'line')
rect(40, 164, 1200, 36, 'panel')
text(58, 187, 'blink-f407', 13, weight=600)
line(168, 174, 168, 190)
text(185, 187, 'main.c', 13, 'secondary', mono=True)
text(850, 187, '下载器  ST-LINK/V2', 12, 'muted')
dot(1025, 182)
text(1037, 187, '已识别目标 STM32F407ZG', 12, 'secondary')
line(40, 200, 1240, 200)
text(62, 226, '42', 12, 'muted', mono=True)
text(108, 226, 'printf("Temperature: %.1f C\\r\\n", temperature);', 13, 'secondary', mono=True)
text(62, 252, '43', 12, 'muted', mono=True)
text(108, 252, 'process_uart_command();  // 接收解析由示例固件实现', 13, 'muted', mono=True)
line(40, 270, 1240, 270, 'input_line')
tabs(40, 270, 1200)

# Context bar: manual target controls, clear link state and read tools.
button(56, 309, 208, 26, 'CH340 · COM5', dropdown=True, disabled=True)
button(272, 309, 96, 26, '115200', dropdown=True, disabled=True)
dot(390, 322)
text(402, 327, '已连接', 12, 'ok')
button(468, 309, 64, 26, '断开')
text(776, 327, '显示', 12, 'muted')
button(816, 309, 50, 26, 'TEXT', active=True)
button(866, 309, 50, 26, 'HEX')
button(950, 309, 48, 26, '查找', plain=True)
button(1002, 309, 48, 26, '跟随', plain=True)
button(1054, 309, 48, 26, '清空', plain=True)
button(1106, 309, 82, 26, '时间戳', plain=True, active=True)
for dx in (-5, 0, 5):
    dot(1210 + dx, 322, 'muted', 1.2)
line(40, 342, 1240, 342)

logrow(375, '17:06:32.112', 'RX', 'Temperature: 24.6 C')
logrow(403, '17:06:33.114', 'RX', 'Temperature: 24.7 C')
logrow(431, '17:06:34.230', 'TX', 'status')
logrow(459, '17:06:34.245', 'RX', 'led=off, sampling=1000 ms')
logrow(487, '17:06:35.870', 'TX', 'led on')
logrow(515, '17:06:35.881', 'RX', 'led=on')
text(60, 555, 'UTF-8 · 8N1 · 时间戳来自主机', 12, 'muted')
button(1070, 535, 150, 28, '新数据 24 条', active=True)
line(1082, 543, 1082, 554, 'accent', 1.4)
line(1078, 550, 1082, 554, 'accent', 1.4)
line(1082, 554, 1086, 550, 'accent', 1.4)

# Composer; text labels centered in their own fixed control boxes.
line(40, 586, 1240, 586)
button(56, 598, 88, 30, 'TEXT', dropdown=True)
rect(152, 598, 880, 30, 'white', 'input_line', 3)
text(164, 618, '输入要发送给固件的内容…', 13, 'muted')
button(1040, 598, 72, 30, 'LF', dropdown=True)
button(1120, 598, 104, 30, '发送', primary=True, size=13)
text(40, 670, 'status / led on 为示例固件协议；TX 只表示主机写入成功，不代表固件已执行。', 13, 'muted')
text(40, 694, 'HEX 直接收发字节；发送需校验字节对，默认不追加文本行尾。接收显示和发送模式分别设置。', 13, 'muted')

text(40, 741, '02  下载时的三个状态', 18, weight=600)
text(832, 741, 'UART ISP 结束后，恢复 BOOT 并手动连接。', 13, 'muted')
state_card(40, 'SWD 下载 · UART 保留', '下载器工作；串口是独立通道',
           '保留用户已有连接，不自动开关 UART。', 'swd')
state_card(448, 'UART ISP · 让出端口', 'COM5 用于下载，应用发送禁用',
           '用户确认断开监视后，下载才占用端口。', 'isp')
state_card(856, 'BOOT 恢复 · 手动连接', '写入校验完成，等待恢复与复位',
           '不会因下载任务结束自动重新连接。', 'boot')

line(40, 1152, 1240, 1152)
text(40, 1183, '首版范围', 14, weight=600)
text(140, 1183, '手动端口与波特率 · 连接 / 断开 · TEXT / HEX · 行尾 · 查找 / 跟随 / 清空 / 复制', 14, 'secondary')
text(40, 1212, '标签 104 × 32 px；活动下划线 80 × 2 px；控件文字居中，日志和草稿左对齐。', 13, 'muted')
text(40, 1243, '设计示意，未实现；日志、代码、端口与硬件状态均为示例，不代表实机运行记录。', 12, 'muted')
text(1168, 1243, 'NODU', 12, 'muted', 600)
add('</svg>')

output = Path(__file__).resolve().with_name('stm32-serial.svg')
output.write_text('\n'.join(parts) + '\n', encoding='utf-8')
print(output)
