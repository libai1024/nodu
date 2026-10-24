// SPDX-License-Identifier: MIT
// Native manual review host. Services use fixtures; no real recent projects or hardware.
const { app, BrowserWindow, Menu }=require('electron');
const path=require('node:path');
const dir=process.argv[2];
app.setPath('userData',path.join(dir,'profile'));
app.whenReady().then(()=>{
 const win=new BrowserWindow({width:960,height:640,minWidth:600,minHeight:450,title:'Nodu 工作台验收',titleBarStyle:'hidden',trafficLightPosition:{x:14,y:14},webPreferences:{contextIsolation:true,nodeIntegration:false}});
 const scenarios=['projects','empty','long','loading','load-error','open-busy','examples-loading','examples-error','examples-empty','copy-busy','parent-loading','parent-error','create-busy','browse-error'];
 let index=0,theme='dark';
 const load=()=>win.loadFile(path.join(dir,'index.html'),{query:{scenario:scenarios[index],theme}});
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'验收',submenu:[{label:'下一状态',accelerator:'Alt+Right',click:()=>{index=(index+1)%scenarios.length;load();}},{label:'上一状态',accelerator:'Alt+Left',click:()=>{index=(index+scenarios.length-1)%scenarios.length;load();}},...scenarios.map((s,i)=>({label:s,click:()=>{index=i;load();}})),{type:'separator'},{label:'深色',accelerator:'Alt+D',click:()=>{theme='dark';load();}},{label:'浅色',accelerator:'Alt+L',click:()=>{theme='light';load();}},{label:'960 × 640',accelerator:'Alt+1',click:()=>win.setSize(960,640)},{label:'760 × 500',accelerator:'Alt+2',click:()=>win.setSize(760,500)},{role:'quit'}]},{role:'editMenu'}]));
 load();
});
app.on('window-all-closed',()=>app.quit());
