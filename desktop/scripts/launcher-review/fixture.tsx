// SPDX-License-Identifier: MIT
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Launcher } from '../../scope-extension/src/electron-browser/nodu-launcher-view';
import { version } from '../../electron-app/package.json';
import { workbenchColors, scopeColorDefaults } from '../../scope-extension/src/browser/nodu-theme-colors';
import '../../scope-extension/style/scope.css';
import '../../scope-extension/style/embedded.css';
import '../../scope-extension/style/device.css';
import '../../scope-extension/style/widgets.css';
import '../../scope-extension/style/launcher.css';
import '@vscode/codicons/dist/codicon.css';
const params=new URLSearchParams(location.search), scenario=params.get('scenario') || 'projects';
let theme=params.get('theme') || 'dark';
const listeners=new Set<()=>void>();
function applyTheme() {
 document.body.className=`theia-${theme} nodu-launcher-window`;
 for (const {id,defaults} of scopeColorDefaults()) document.documentElement.style.setProperty('--theia-'+id.replaceAll('.','-'), defaults[theme as 'dark'|'light']);
 for(const [key,value] of Object.entries(workbenchColors(theme as 'dark'|'light'))) document.documentElement.style.setProperty('--theia-'+key.replaceAll('.','-'),value);
}
applyTheme();
const themes={getCurrentTheme:()=>({type:theme}),onDidColorThemeChange:(fn:()=>void)=>{listeners.add(fn);return{dispose:()=>listeners.delete(fn)};},setCurrentTheme:(id:string)=>{theme=id.includes('light')?'light':'dark';applyTheme();listeners.forEach(fn=>fn());}};
const wait=()=>new Promise<any>(()=>{});
const fail=(message:string)=>Promise.reject(new Error(message));
let rows=[
 {name:'blink-f103',path:'/验收项目/STM32/blink-f103',tag:'STM32F103C8T6',lastOpened:Date.now()-60000},
 {name:'serial-f407',path:'/验收项目/STM32/serial-f407',tag:'STM32F407ZGT6',lastOpened:Date.now()-3600000},
 {name:'camera-k210',path:'/验收项目/K210/camera-k210',tag:'K210',lastOpened:Date.now()-86400000},
 {name:'moved-project',path:'/验收项目/已移动/moved-project',missing:true,lastOpened:Date.now()-172800000}
];
if(scenario==='long') rows=Array.from({length:25},(_,i)=>({name:`温湿度采集与串口通信测试工程-${i+1}`,path:`/验收项目/多层目录/嵌入式课程/STM32F103/传感器与串口/第${i+1}课`,tag:'STM32F103C8T6',lastOpened:Date.now()-i*86400000}));
const examples=[{name:'STM32F103 串口入门',path:'/fixtures/f103',tag:'STM32F103C8T6',summary:'USART1 串口输出'}, {name:'STM32F407 温湿度采集',path:'/fixtures/f407',tag:'STM32F407ZGT6',summary:'I2C 采集与串口通信'}];
const projects={
 recent:()=>scenario==='loading'?wait():scenario==='load-error'?fail('无法读取最近项目。'):Promise.resolve(scenario==='empty'?[]:rows),
 remove:async(p:string)=>{rows=rows.filter(r=>r.path!==p);},
 examples:()=>scenario==='examples-loading'?wait():scenario==='examples-error'?fail('参考项目暂时无法加载。'):Promise.resolve(scenario==='examples-empty'?[]:examples),
 copyExample:()=>scenario==='copy-busy'?wait():fail('无法创建副本：目标文件夹不可写。'),
 projectsDir:()=>scenario==='parent-loading'?wait():scenario==='parent-error'?fail('无法读取项目位置。'):Promise.resolve('/验收项目')
};
const open=()=>scenario==='open-busy'?wait():fail('项目窗口未能打开。');
const browse=async()=>{};
const model={call:()=>scenario==='create-busy'?wait():fail('同名项目已存在，请修改名称。')};
const dialogs={showOpenDialog:()=>scenario==='browse-error'?fail('无法打开文件夹选择器。'):Promise.resolve(undefined)};
createRoot(document.getElementById('nodu-launcher')!).render(<Launcher projects={projects as any} themes={themes as any} model={model as any} dialogs={dialogs as any} open={open} browse={browse}
 application={{ getApplicationInfo: async () => ({ name: 'Nodu', version }) }}
 preferences={{ ready: Promise.resolve(), get: () => false, set: async () => {} } as any}/>);
