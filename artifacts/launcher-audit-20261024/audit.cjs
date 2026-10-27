const fs=require('node:fs');
const root='/Users/wangwei/Model/k210-studio/.claude/worktrees/start-window/desktop';
const puppeteer=require(root+'/node_modules/puppeteer');
const vars=[...new Set([...fs.readFileSync(root+'/scope-extension/style/launcher.css','utf8').matchAll(/var\((--[\w-]+)/g)].map(m=>m[1]))];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9333',defaultViewport:null});
 const page=(await browser.pages()).find(p=>p.url().includes('noduLauncher'));
 const initial=await page.evaluate(()=>({dark:document.body.classList.contains('theia-dark'),page:document.querySelector('.nodu-launcher-nav-item[aria-current="page"]')?.textContent.trim()}));
 if(process.argv.includes('--reload')){await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('.theia-preload',{hidden:true});}
 const cdp=await page.createCDPSession();await cdp.send('DOM.enable');await cdp.send('CSS.enable');
 const go=async text=>{await page.evaluate(text=>[...document.querySelectorAll('.nodu-launcher-nav-item')].find(e=>e.textContent.trim()===text).click(),text);await pause(200)};
 const computed=async selector=>page.$eval(selector,e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {selector:e.id||e.className,width:r.width,height:r.height,display:s.display,alignItems:s.alignItems,columns:s.gridTemplateColumns,border:s.border,borderLeft:s.borderLeft,background:s.backgroundColor,flex:s.flex,padding:s.padding}});
 const matched=async selector=>{const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});const match=await cdp.send('CSS.getMatchedStylesForNode',{nodeId});return (match.matchedCSSRules||[]).map(m=>({selector:m.rule.selectorList.text,matching:m.matchingSelectors.map(i=>m.rule.selectorList.selectors[i].text),origin:m.rule.origin,line:(m.rule.style.range?.startLine??-1)+1,properties:m.rule.style.cssProperties.filter(p=>/^(border|all$|width$|min-width$|max-width$|display$|align-items$|flex)/.test(p.name)).map(p=>({name:p.name,value:p.value,important:p.important,implicit:p.implicit}))})).filter(m=>m.properties.length)};
 const result={initial,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),themes:{}};
 for(const dark of [true,false]){
  if(await page.evaluate(()=>document.body.classList.contains('theia-dark'))!==dark){await page.click('.nodu-launcher-theme');await pause(250)}
  const theme=dark?'dark':'light';
  const entry=result.themes[theme]={variables:await page.evaluate(vars=>Object.fromEntries(vars.concat(['--theia-widget-border','--theia-panel-border','--theia-input-border']).map(k=>[k,getComputedStyle(document.body).getPropertyValue(k).trim()])),vars)};
  await go('新建项目');await page.waitForSelector('#nodu-project-name');await page.$eval('#nodu-project-name',e=>e.blur());
  entry.widthChain=await Promise.all(['.nodu-launcher-form','.nodu-new-project','.nodu-np-body','.nodu-np-families','.nodu-np-fields','.nodu-np-control','#nodu-project-name','#nodu-project-parent'].map(computed));
  entry.inputRules=await matched('#nodu-project-name');entry.fieldsRules=await matched('.nodu-np-fields');
  await page.screenshot({path:__dirname+`/new-${theme}.png`});
  await go('设置');entry.card=await computed('.nodu-launcher-card');entry.cardRules=await matched('.nodu-launcher-card');await page.screenshot({path:__dirname+`/settings-${theme}.png`});
  await page.hover('.nodu-launcher-theme');await pause(200);entry.hover=await computed('.nodu-launcher-theme');
  await go('示例项目');await page.waitForSelector('.nodu-launcher-example');entry.examples=await page.evaluate(()=>({count:document.querySelectorAll('.nodu-launcher-example').length,summaries:document.querySelectorAll('.nodu-launcher-example .nodu-launcher-path').length}));await page.screenshot({path:__dirname+`/examples-${theme}.png`});
 }
 if(await page.evaluate(()=>document.body.classList.contains('theia-dark'))!==initial.dark){await page.click('.nodu-launcher-theme');await pause(200)}
 await go(initial.page||'最近项目');
 const file=__dirname+(process.argv.includes('--reload')?'/audit-after.json':'/audit-before.json');fs.writeFileSync(file,JSON.stringify(result,null,2));
 console.log(JSON.stringify(Object.fromEntries(Object.entries(result.themes).map(([k,v])=>[k,{empty:Object.entries(v.variables).filter(([,v])=>!v).map(([k])=>k),widthChain:v.widthChain.map(x=>({el:x.selector,width:x.width,align:x.alignItems,border:x.border})),card:v.card.border,hover:v.hover.background,examples:v.examples}])),null,2));
 await cdp.detach();browser.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
