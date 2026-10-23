from pathlib import Path
from html import escape
out=Path(__file__).resolve().parent
W,H=1520,1520
s=['<svg xmlns="http://www.w3.org/2000/svg" width="1520" height="1520" viewBox="0 0 1520 1520" role="img" aria-labelledby="title desc"><title id="title">Nodu K210 专用底部面板 UI 设计图</title><desc id="desc">K210 三个页面：运行输出、Python 交互和本机终端，以及运行中禁用执行的状态。设计示例，未实现。</desc>']
font="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif"
mono="'SFMono-Regular', Menlo, Consolas, 'PingFang SC', monospace"
light=dict(bg='#FFFFFF',bar='#F7F8FA',line='#E0E3E8',txt='#1D2129',muted='#5B616C',blue='#2449DB',primary='#2F5BFF',green='#187244',red='#B42F27',soft='#EEF2FF')
dark=dict(bg='#181B21',bar='#1D2027',line='#343A45',txt='#E7EAEF',muted='#949CAA',blue='#8FA8FF',primary='#2F5BFF',green='#45C486',red='#F2706A',soft='#232D4E')
def rect(x,y,w,h,c,stroke=None,r=0):
 s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{c}"'+(f' stroke="{stroke}"' if stroke else '')+'/>')
def text(x,y,v,size=14,c='#1D2129',weight=400,code=False):
 s.append(f'<text x="{x}" y="{y}" font-family="{escape(mono if code else font,quote=True)}" font-size="{size}" font-weight="{weight}" fill="{c}">{escape(v)}</text>')
def center(x,y,v,size=13,c='#1D2129',weight=500,code=False):
 s.append(f'<text x="{x}" y="{y}" text-anchor="middle" dominant-baseline="central" font-family="{escape(mono if code else font,quote=True)}" font-size="{size}" font-weight="{weight}" fill="{c}">{escape(v)}</text>')
def icon(cx,cy,kind,c):
 if kind=='more':
  for dx in [-5,0,5]: s.append(f'<circle cx="{cx+dx}" cy="{cy}" r="1.2" fill="{c}"/>')
 elif kind=='maximize': rect(cx-5,cy-5,10,10,'none',c)
 elif kind=='collapse':
  line(cx-4,cy-2,cx,cy+2,c,1.5);line(cx,cy+2,cx+4,cy-2,c,1.5)
 elif kind=='down':
  line(cx,cy-5,cx,cy+5,c,1.5);line(cx-4,cy+1,cx,cy+5,c,1.5);line(cx,cy+5,cx+4,cy+1,c,1.5)
def line(x,y,x2,y2,c='#E0E3E8',sw=1): s.append(f'<path d="M{x} {y} L{x2} {y2}" fill="none" stroke="{c}" stroke-width="{sw}"/>')
def dot(x,y,c): s.append(f'<circle cx="{x}" cy="{y}" r="3" fill="{c}"/>')
def button(x,y,w,v,t,primary=False,disabled=False):
 rect(x,y,w,26,t['primary'] if primary else t['bar'],None if primary else t['line'],4)
 center(x+w/2,y+13,v,12,t['muted'] if disabled else '#FFFFFF' if primary else t['txt'],500)
def panel(x,y,active,t,context,state,kind,platform="k210"):
 w,h=700,330
 rect(x,y,w,h,t['bg'],t['line'])
 rect(x,y,w,32,t['bar'])
 for index,label in enumerate(['运行输出','Python 交互','终端'] if platform=='k210' else ['构建与下载','串口监视','终端']):
  tx=x+8+104*index
  s.append(f'<g data-tab="{label}" data-box="{tx},{y},104,32">')
  center(tx+52,y+16,label,13,t['txt'] if label==active else t['muted'],600 if label==active else 400)
  if label==active: rect(tx+12,y+30,80,2,t['primary'])
  s.append('</g>')
 for dx,icon_kind in [(612,'more'),(644,'maximize'),(676,'collapse')]: icon(x+dx,y+16,icon_kind,t['muted'])
 line(x,y+32,x+w,y+32,t['line'])
 text(x+14,y+50,context,12,t['txt'],500)
 parts=state.split('  ·  ')
 for i,part in enumerate(parts): text(x+270+i*86,y+50,part,12,t['green'] if part=='已连接' else t['muted'])
 if kind=='shell':
  for dx,label in [(560,'新建'),(608,'分屏'),(656,'结束')]: center(x+dx,y+46,label,12,t['muted'])
 else:
  for dx,label in [(560,'查找'),(608,'跟随'),(656,'断开' if kind=='serial' else '清空')]: center(x+dx,y+46,label,12,t['blue'] if label=='跟随' else t['muted'])
 line(x,y+62,x+w,y+62,t['line'])
 return x,y,w,h
rect(0,0,W,H,'#FFFFFF')
text(40,52,'Nodu  /  K210 底部面板',30,weight=650)
text(40,84,'围绕 MaixPy：运行输出、Python 交互、本机终端。STM32 使用独立的一套 UI。',16,c='#5B616C')
text(1230,49,'UI DESIGN  /  03',13,c='#5B616C',weight=600)
text(1230,74,'2026.10.22 · 平台分流',13,c='#5B616C')
line(40,107,1480,107)
# row 1
text(40,145,'01  运行输出',19,weight=600);text(780,145,'02  Python 交互',19,weight=600)
x,y,w,h=panel(40,165,'运行输出',light,'main.py ▾   ·   K210','已连接  ·  运行结束','output')
text(x+14,y+87,'本窗口运行 · 16:42:08 · main.py',12,light['muted'])
line(x+14,y+99,x+w-14,y+99,light['line'])
for i,v in enumerate(['Camera initialized','fps: 24.7   objects: 1','fps: 24.9   objects: 1','Traceback (most recent call last):']): text(x+14,y+123+24*i,v,13,light['txt'],code=True)
text(x+14,y+219,'  File "main.py", line 28',13,light['blue'],code=True)
text(x+14,y+243,'ValueError: invalid threshold',13,light['red'],code=True)
text(x+14,y+306,'程序已停止 · 16:42:09',12,light['muted'])
x,y,w,h=panel(780,165,'Python 交互',light,'K210 · MaixPy ▾','已连接  ·  可执行','repl')
vals=[('>>> import os',light['blue']),(">>> os.listdir('/')",light['blue']),("['boot.py', 'main.py']",light['txt']),('>>> print(6 * 7)',light['blue']),('42',light['txt'])]
for i,(v,c) in enumerate(vals): text(x+14,y+94+25*i,v,13,c,code=True)
line(x,y+290,x+w,y+290,light['line'])
text(x+14,y+315,'>>>',13,light['blue'],600,True);text(x+54,y+315,'输入 Python 代码…',13,light['muted'],code=True)
button(x+610,y+297,75,'执行',light,True)
text(40,522,'正文铺满面板 · 错误回到代码 · 连接与运行分别表达',13,c='#5B616C')
text(780,522,'输入 Python 即时查看结果 · 保留命令历史和草稿',13,c='#5B616C')
# row 2
text(40,578,'状态  /  程序运行中',19,weight=600);text(780,578,'03  终端',19,weight=600)
x,y,w,h=panel(40,598,'Python 交互',dark,'K210 · MaixPy ▾','已连接  ·  程序运行中','repl')
vals=[('>>> import os',dark['blue']),(">>> os.listdir('/')",dark['blue']),("['boot.py', 'main.py']",dark['txt']),('>>> print(6 * 7)',dark['blue']),('42',dark['txt'])]
for i,(v,c) in enumerate(vals): text(x+14,y+94+25*i,v,13,c,code=True)
line(x,y+290,x+w,y+290,dark['line'])
text(x+14,y+315,'>>>',13,dark['blue'],600,True);text(x+54,y+315,'输入 Python 代码…',13,dark['muted'],code=True)
rect(x+14,y+238,672,34,dark['bar'],None,3)
text(x+26,y+260,'程序运行中，停止后可执行；此处仍可编辑草稿。',12,dark['muted'])
s.append('<g opacity="0.5" aria-disabled="true">')
button(x+610,y+297,75,'执行',dark,False,disabled=True)
s.append('</g>')
x,y,w,h=panel(780,598,'终端',dark,'zsh · green-tracker ▾','本机  ·  当前工作区','shell')
text(x+14,y+96,'~/Projects/green-tracker',13,dark['muted'],code=True)
text(x+14,y+123,'$ git status --short',13,dark['txt'],code=True)
text(x+14,y+150,' M main.py',13,dark['green'],code=True)
text(x+14,y+177,'$',13,dark['txt'],code=True);rect(x+31,y+164,7,16,dark['blue'])
# Shell keeps its output area free of implementation labels.
text(40,955,'运行中保留历史与草稿 · 切换到此页不会停止脚本',13,c='#5B616C')
text(780,955,'单会话用下拉 · 多会话才出现列表 · 结束会话单独操作',13,c='#5B616C')
line(40,988,1480,988)
text(40,1025,'共同规范',14,weight=600)
text(156,1025,'收起继续运行    /    查历史不抢滚动    /    换布局不丢草稿    /    切标签不抢端口',14,c='#3E434C')
text(40,1062,'上排展示浅色主题，下排展示深色主题；三个页面均适用两种主题。示例数据仅说明交互，不代表已实现能力。',12,c='#5B616C')

text(40,1116,'关键状态：保留输出，解释下一步',19,weight=600)
for yy,label,copy,action in [
 (1142,'未连接','连接开发板后执行 Python。已有结果与草稿保留。','选择开发板'),
 (1218,'程序运行中','可编辑草稿；停止程序后才能执行新的 Python 命令。','停止程序'),
 (1294,'设备已断开','已有输出与草稿保留；重新连接开发板后再执行。','选择开发板')]:
 rect(40,yy,1440,64,'#F7F8FA')
 text(58,yy+37,label,14,weight=600)
 text(242,yy+37,copy,14,c='#3E434C')
 button(1312,yy+19,140,action,light)
line(40,1390,1480,1390)
text(40,1428,'评审重点',14,weight=600)
text(156,1428,'K210 三个入口是否清楚   /   输出是否足够宽敞   /   状态是否准确   /   操作是否顺手',14,c='#3E434C')
text(40,1470,'详细布局、窄宽适配、键盘行为与能力边界见 PROPOSAL.md。仅设计材料，未修改应用实现。',12,c='#5B616C')

s.append('</svg>')
(out/'terminal-panel-wireframes.svg').write_text('\n'.join(s),encoding='utf-8')
print(out/'terminal-panel-wireframes.svg')

# Enlarged control geometry for the second design review. This is a static design plate.
s=['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000" role="img" aria-labelledby="title"><title id="title">标签、活动线与按钮居中细节</title><defs><clipPath id="header"><rect width="700" height="62"/></clipPath></defs>']
rect(0,0,1000,1000,'#FFFFFF')
text(40,56,'两套 UI · 共用对齐规范',29,weight=650)
text(40,90,'文字在每个标签内部居中；活动线、图标和按钮使用同一套几何规则。',15,c=light['muted'])
text(40,137,'K210 · 运行输出选中',14,weight=600)
s.append('<g transform="translate(40 155) scale(1.3)"><g clip-path="url(#header)">')
panel(0,0,'运行输出',light,'main.py · K210','已连接  ·  空闲','output')
s.append('</g></g>')
text(40,282,'STM32 · 串口监视选中',14,weight=600)
s.append('<g transform="translate(40 300) scale(1.3)"><g clip-path="url(#header)">')
panel(0,0,'串口监视',dark,'CH340 · COM5 ▾','115200  ·  已连接','serial',platform='stm32')
s.append('</g></g>')
text(40,432,'标签几何（放大 3 倍，标注为逻辑像素）',18,weight=600)
rect(40,486,312,96,light['bar'],light['line'])
center(196,534,'Python 交互',39,light['txt'],500)
rect(76,576,240,6,light['primary'])
s.append('<path d="M196 458V610 M22 534H370" fill="none" stroke="#2449DB" stroke-width="1" stroke-dasharray="4 4"/>')
line(40,468,352,468,light['muted']);line(40,463,40,473,light['muted']);line(352,463,352,473,light['muted'])
center(196,452,'104 px',13,light['muted'])
text(394,504,'文字中心：52 × 16',16,weight=600)
text(394,536,'标签：104 × 32   /   下划线：80 × 2',15,c=light['muted'])
text(394,568,'下划线左右内缩 12，中心与文字重合。',15,c=light['muted'])
text(40,648,'按钮与工具',18,weight=600)
rect(40,676,920,104,light['bar'])
button(62,710,80,'发送',light,True);button(162,710,80,'执行',light,True);button(262,710,128,'选择串口',light)
for cx,kind in [(442,'more'),(486,'maximize'),(530,'collapse')]:
 rect(cx-14,709,28,28,'#FFFFFF',light['line'],3);icon(cx,723,kind,light['muted'])
text(580,719,'文字双向居中 · 图标居中',14,weight=600)
text(580,745,'统一命中区、内边距与控件间距',13,c=light['muted'])
line(40,820,960,820)
text(40,860,'状态不引起布局跳动',17,weight=600)
text(40,892,'默认、悬停、选中、键盘焦点保持相同宽高；计数使用固定槽。',14,c=light['muted'])
text(40,920,'日志、代码和输入正文左对齐；标签、按钮和图标在控件中居中。',14,c=light['muted'])
text(40,964,'设计示意，非应用截图。K210 与 STM32 各有一套 UI，共用标签、按钮和阅读细节规范。',11,c=light['muted'])
s.append('</svg>')
(out/'alignment-details.svg').write_text('\n'.join(s),encoding='utf-8')
print(out/'alignment-details.svg')
