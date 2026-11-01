// SPDX-License-Identifier: MIT
// Exercise real menu/open routing methods, with services replaced by deterministic local doubles.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {DisposableCollection}=require('@theia/core/lib/common/disposable');
function fixture(){
 const source=ts.createSourceFile('module.tsx',fs.readFileSync(path.join(__dirname,'../src/electron-browser/nodu-launcher-module.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const cls=source.statements.find(n=>ts.isClassDeclaration(n)&&n.name.text==='LauncherContribution');
 const names=['openSelected','refreshRecent','registerCommands','registerMenus'];
 const methods=cls.members.filter(m=>ts.isMethodDeclaration(m)&&names.includes(m.name.getText(source))).map(m=>m.getText(source)).join('\n');
 const context={Subject:null,CommonMenus:{FILE:['menubar','file']},NODU_PROJECT_MENU:['nodu-project'],CommonCommands:{FIND:{id:'find'}},isLauncher:()=>false};
 vm.runInNewContext(ts.transpile(`class Subject { ${methods} };this.Subject=Subject;`, { target: ts.ScriptTarget.ES2022 }),context);
 const subject=new context.Subject(),commands=new Map(),actions=new Map(),submenus=[],opened=[],touched=[],errors=[];
 subject.recentEntries=new DisposableCollection();subject.recentGeneration=0;
 const registry={registerCommand(command,handler){commands.set(command.id,{command,handler});return{dispose:()=>commands.delete(command.id)}},registerHandler(){}};
 const menus={registerMenuAction(menu,action){const key=menu.join('/')+'/'+action.commandId;actions.set(key,action);return{dispose:()=>actions.delete(key)}},registerSubmenu(menu,title){submenus.push({menu,title})}};
 subject.main={openProject:async(...args)=>opened.push(args),showLauncher:async()=>{}};
 subject.projects={inspect:async()=>({folder:'/parent',candidates:[{path:'/parent/firmware',name:'firmware'}]}),touch:async p=>touched.push(p),recent:async()=>[]};
 subject.messages={error:async e=>errors.push(e)};subject.quickPick={show:async()=>undefined};
 subject.openFolder=async()=>{};subject.registerCommands(registry);subject.registerMenus(menus);
 return {subject,commands,actions,submenus,opened,touched,errors};
}
test('file and project menus expose open-project and recent-project actions',async()=>{
 const f=fixture();assert(f.commands.has('nodu.project.open'));
 assert(f.actions.has('menubar/file/1_projects/nodu.project.open'));
 assert.equal(f.submenus.filter(m=>m.title==='最近项目').length,2);
 await f.subject.refreshRecent();assert.equal(f.commands.get('nodu.project.noRecents').handler.isEnabled(),false);
});
test('opening a parent resolves the firmware root and records that root; cancelled ambiguity opens nothing',async()=>{
 const f=fixture();await f.subject.openSelected('/parent');assert.equal(f.opened[0][0],'/parent/firmware');assert.equal(f.touched[0],'/parent/firmware');
 f.subject.projects.inspect=async()=>({folder:'/parent',candidates:[{path:'/a',name:'a'},{path:'/b',name:'b'}]});
 await f.subject.openSelected('/parent');assert.equal(f.opened.length,1);
 f.subject.quickPick.show=async rows=>rows[1];await f.subject.openSelected('/parent');assert.equal(f.opened[1][0],'/b');
});
test('missing recents stay disabled, refresh removes stale commands and asynchronous older results cannot win',async()=>{
 const f=fixture();f.subject.projects.recent=async()=>[{path:'/missing',name:'lost',missing:true},{path:'/valid',name:'valid',missing:false}];await f.subject.refreshRecent();
 assert.equal(f.commands.get('nodu.project.recent.0').handler.isEnabled(),false);
 await f.commands.get('nodu.project.recent.1').handler.execute();assert.equal(f.opened.length,1);
 let first;f.subject.projects.recent=()=>new Promise(r=>first=r);const pending=f.subject.refreshRecent();
 f.subject.projects.recent=async()=>[];await f.subject.refreshRecent();first([{path:'/stale',name:'stale',missing:false}]);await pending;
 assert.equal(f.commands.has('nodu.project.recent.0'),false);assert(f.commands.has('nodu.project.noRecents'));
});
