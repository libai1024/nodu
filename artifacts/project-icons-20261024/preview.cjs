const fs = require('node:fs');
const path = require('node:path');
const root = '/Users/wangwei/Model/k210-studio/.claude/worktrees/start-window/desktop';
const puppeteer = require(root + '/node_modules/puppeteer');
const React = require(root + '/node_modules/react');
const { renderToStaticMarkup } = require(root + '/node_modules/react-dom/server');
require.extensions['.css'] = () => {};
const { ProjectIcon } = require(root + '/scope-extension/lib/browser/nodu-project-icon');
const { PROJECT_CHIPS } = require(root + '/scope-extension/lib/common/nodu-project-catalog');
const chips = [...PROJECT_CHIPS.map(c => ({tag:c.name,label:c.name})),
 {tag:'STM32',label:'STM32 · 未知型号'}, {label:'普通 / 未知项目'},
 {tag:'STM32F103',missing:true,label:'F103 · 文件缺失'}, {missing:true,label:'未知 · 文件缺失'}];
const cssPath = root + '/scope-extension/style/project-icon.css';
const css = fs.readFileSync(cssPath,'utf8').replace(/url\('([^']+)'\)/g,(_,p)=>`url("data:image/svg+xml;base64,${fs.readFileSync(path.resolve(path.dirname(cssPath),p)).toString('base64')}")`);
const dir = __dirname;
const pause = ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const browser = await puppeteer.connect({browserURL:'http://127.0.0.1:9333',defaultViewport:null});
 const page = (await browser.pages()).find(p=>p.url().includes('noduLauncher'));
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.reload({waitUntil:'networkidle0'});
 await page.waitForSelector('.theia-preload',{hidden:true});
 await page.waitForSelector('.nodu-project-icon');
 await pause(300);
 const variables = ()=>page.evaluate(()=>{const s=getComputedStyle(document.body);return Array.from(s).filter(k=>k.startsWith('--theia-')).map(k=>`${k}:${s.getPropertyValue(k)};`).join('')});
 const dark = await variables();
 await page.screenshot({path:path.join(dir,'launcher-dark.png')});
 await (await page.$('.nodu-launcher-list')).screenshot({path:path.join(dir,'recent-icons-dark.png')});
 await page.click('.nodu-launcher-theme');
 await pause(400);
 const light = await variables();
 await page.screenshot({path:path.join(dir,'launcher-light.png')});
 await page.click('.nodu-launcher-theme');
 await pause(300);
 // Audit narrow-window alignment without resizing the user's launcher.
 const source = chips.map(c=>`<div class="sample">${renderToStaticMarkup(React.createElement(ProjectIcon,c))}<span>${c.label}</span></div>`).join('');
 const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Nodu 项目图标</title><style>
 *{box-sizing:border-box}body{margin:0;background:#14171c;font:13px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#e7eaef}header{padding:28px 32px 24px}h1{font-size:22px;margin:0 0 8px;font-weight:600}header p{margin:0;color:#949caa;font-size:13px}.themes{display:grid;grid-template-columns:1fr 1fr}.theme{padding:24px 28px 28px;color:var(--theia-foreground);background:var(--theia-editor-background)}.theme h2{font-size:12px;color:var(--theia-descriptionForeground);margin:0 0 24px;font-weight:500}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:26px 10px}.sample{display:flex;flex-direction:column;align-items:center;gap:10px;min-width:0;font-size:11px}.sample>span:last-child{color:var(--theia-descriptionForeground)}.dark{${dark}}.light{${light}}
 ${css}</style><header><h1>厂商 Logo + 芯片型号</h1><p>右下角区分型号；左上角标记文件缺失，保留原有项目身份。</p></header><main class="themes"><section class="theme dark"><h2>深色主题</h2><div class="grid">${source}</div></section><section class="theme light"><h2>浅色主题</h2><div class="grid">${source}</div></section></main></html>`;
 fs.writeFileSync(path.join(dir,'preview.html'),html);
 const previewBrowser = await puppeteer.launch({headless:true,executablePath:'/Users/wangwei/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
 const gallery = await previewBrowser.newPage();
 await gallery.setViewport({width:1000,height:660,deviceScaleFactor:2});
 await gallery.setContent(html,{waitUntil:'load'});
 await gallery.screenshot({path:path.join(dir,'project-icons.png'),fullPage:true});
 const audit=await gallery.$$eval('.nodu-project-icon',els=>els.map(e=>({label:e.getAttribute('aria-label'),width:e.getBoundingClientRect().width,logo:!!e.querySelector('.nodu-project-icon-logo'),warning:!!e.querySelector('.nodu-project-icon-missing')})));
 await previewBrowser.close();
 fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify({errors,icons:audit},null,2));
 console.log(JSON.stringify({errors,samples:audit.length}));
 browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
