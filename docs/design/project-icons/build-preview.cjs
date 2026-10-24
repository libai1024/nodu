// SPDX-License-Identifier: MIT
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const React = require(path.join(root, 'desktop/node_modules/react'));
const { renderToStaticMarkup: render } = require(path.join(root, 'desktop/node_modules/react-dom/server'));
require.extensions['.css'] = () => {};
const { ProjectIcon, ChipMark } = require(path.join(root, 'desktop/scope-extension/lib/browser/nodu-project-icon'));
const { NODU_COLORS } = require(path.join(root, 'desktop/scope-extension/lib/browser/nodu-brand'));
const styleDir = path.join(root, 'desktop/scope-extension/style');
const css = fs.readFileSync(path.join(styleDir, 'project-icon.css'), 'utf8').replace(/url\('([^']+)'\)/g, (_, p) => `url("data:image/svg+xml;base64,${fs.readFileSync(path.join(styleDir, p)).toString('base64')}")`);
const mark = tag => render(React.createElement(ChipMark, { tag }));
const badge = (tag, missing) => render(React.createElement(ProjectIcon, { tag, missing }));
const tokens = theme => {
 const c = NODU_COLORS[theme];
 return Object.entries({'--theia-editor-background':c.editor,'--theia-sideBar-background':c.panel,'--theia-foreground':c.text,'--theia-panel-border':c.border,'--theia-descriptionForeground':c['text-muted'],'--theia-editorWarning-foreground':c.warn,'--accent':c.accent,'--ok':c.ok}).map(([k,v])=>`${k}:${v}`).join(';');
};
const section = theme => `<section class="theme ${theme}"><h2>${theme === 'dark' ? '深色' : '浅色'}主题</h2>
<div class="editor"><div class="rail"><span class="rail-item" title="设备与连接"><span class="nodu-chip-entry-icon"></span></span><small>设备</small></div><div class="canvas"><div class="tab">main.c</div><pre><span class="muted">1</span>  #include "board.h"
<span class="muted">2</span>
<span class="muted">3</span>  int main(void) {
<span class="muted">4</span>      Board_Init();
<span class="muted">5</span>      while (1) { }
<span class="muted">6</span>  }</pre><div class="status"><span class="dot" title="连接状态独立显示"></span><span class="nodu-chip-label">${mark('STM32F103C8T6')}STM32F103C8T6</span><span class="divider"></span>ST-LINK</div></div></div>
<h3>型号旁 · 16 px</h3><div class="inline-marks">${[['K210','K210'],['STM32F407','STM32F407'],['esp32s3','ESP32-S3']].map(([tag,label])=>`<span class="nodu-chip-label">${mark(tag)}${label}</span>`).join('')}</div>
<h3>项目标识 · 40 px</h3><div class="badges">${[['K210','K210'],['STM32F103','F103'],['STM32F407','F407'],['ESP32-S3','S3'],['ESP32-C3','C3'],['STM32F103','文件缺失',true]].map(([tag,label,missing])=>`<div>${badge(tag,missing)}<small>${label}</small></div>`).join('')}</div>
<h3>通用芯片 · 16 / 18 / 24 px</h3><div class="sizes"><span class="nodu-chip-label">${mark()}<small>16</small></span><span>${mark()} <small>18</small></span><span><i class="nodu-chip-entry-icon"></i> <small>24</small></span></div></section>`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nodu 图标库 · 芯片</title><style>
*{box-sizing:border-box}body{margin:0;font:13px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;background:${NODU_COLORS.dark.editor};color:${NODU_COLORS.dark.text}}header{padding:26px 30px}h1{font-size:22px;margin:0 0 8px}header p{color:${NODU_COLORS.dark['text-muted']};margin:0}.themes{display:grid;grid-template-columns:1fr 1fr}.theme{padding:24px 26px;background:var(--theia-editor-background);color:var(--theia-foreground);min-width:0}.dark{${tokens('dark')}}.light{${tokens('light')}}h2{font-size:12px;font-weight:500;color:var(--theia-descriptionForeground);margin:0 0 20px}h3{font-size:12px;font-weight:500;margin:26px 0 18px;color:var(--theia-descriptionForeground)}.editor{display:flex;border:1px solid var(--theia-panel-border);border-radius:8px;overflow:hidden}.rail{width:50px;flex:none;padding:15px 8px;background:var(--theia-sideBar-background);border-right:1px solid var(--theia-panel-border);text-align:center}.rail-item{display:grid;place-items:center;height:34px;color:var(--accent)}.rail small{font-size:10px;color:var(--theia-descriptionForeground)}.canvas{flex:1;min-width:0}.tab{padding:10px 14px;border-bottom:1px solid var(--theia-panel-border);font-size:12px}.canvas pre{font:12px/1.9 'SFMono-Regular',Consolas,monospace;padding:14px 12px;margin:0;min-height:164px}.muted,small{color:var(--theia-descriptionForeground)}.status{display:flex;align-items:center;gap:9px;min-height:32px;padding:5px 10px;border-top:1px solid var(--theia-panel-border);font-size:11px;white-space:nowrap}.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}.divider{height:12px;border-left:1px solid var(--theia-panel-border)}.inline-marks{display:flex;flex-wrap:wrap;gap:20px;font-size:11px}.badges{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}.badges>div{display:flex;align-items:center;gap:10px;flex-direction:column}.badges small{font-size:10px}.sizes{display:flex;align-items:center;gap:32px}.sizes>span{display:inline-flex;align-items:center;gap:10px}small{font-weight:400}@media(max-width:800px){.themes{grid-template-columns:1fr}}${css}</style><header><h1>Nodu 图标库 · 芯片</h1><p>设备入口用芯片轮廓，型号旁用厂商 Logo，项目列表保留型号角标。</p></header><main class="themes">${section('dark')}${section('light')}</main></html>`;
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('Updated ' + path.join(__dirname, 'index.html'));
