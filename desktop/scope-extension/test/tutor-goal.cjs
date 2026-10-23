// SPDX-License-Identifier: MIT
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {TutorGoalStore}=require('../lib/node/tutor/tutor-goal-store');
const {TutorGoalSession}=require('../lib/node/tutor/tutor-goal-session');
const {TutorWorkspaceHost}=require('../lib/node/tutor/tutor-workspace-host');
const {parseGoalPlan}=require('../lib/common/tutor/tutor-goal');
const context={key:'a'.repeat(64),mcu:'STM32F103C8T6',sdk:'stm32cube-f1@1.8.7',files:['main.c']};
const plan=JSON.stringify({title:'串口启动消息',steps:[{title:'定义消息',goal:'定义启动字符串',path:'main.c'}]});
const fragment=JSON.stringify({text:'先定义启动字符串。',annotations:[],guidance:{anchorLine:2,lines:['const char *hello = "hello";']}});
const review=verdict=>JSON.stringify({text:'静态检查结果',annotations:[],review:{verdict,note:verdict==='ok'?'写法合理':'需要补充上下文'}});
const buffer={path:'main.c',text:'int main(void) {\n\n}\n',version:1,line:2};
async function fixture(t){
 const dir=await fs.mkdtemp(join(tmpdir(),'nodu-goal-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new TutorGoalStore(dir), responses=[],calls=[];let valid=true;
 const provider={complete:async(messages,signal)=>{calls.push(messages);const next=responses.shift();return typeof next==='function'?next(signal):next;}};
 const authorize=async()=>{if(!valid)throw Error('revoked');};
 const session=new TutorGoalSession(store,provider,async()=>({...context}),authorize);
 t.after(()=>session.dispose());
 const run=async(action,extra={})=>session.run({id:randomUUID(),workspaceId:'workspace-1',revision:(await store.read(context.key)).revision,action,...extra});
 return {dir,store,responses,calls,session,run,provider,authorize,revoke:()=>{valid=false;}};
}
test('goal lifecycle persists draft, confirmed fragment, review and completion without writing source',async t=>{
 const f=await fixture(t);f.responses.push(plan,fragment,review('context'),review('ok'));
 let r=await f.run('propose',{prompt:'我想串口输出',buffer});assert.equal(r.state.status,'draft');
 assert.equal(JSON.parse(f.calls[0][1].content).project.sdk,context.sdk);
 r=await f.run('confirm');assert.equal(r.state.status,'active');
 r=await f.run('fragment',{buffer});assert.equal(r.state.fragment.answer.guidance.lines.length,1);
 const reopened=new TutorGoalSession(f.store,f.provider,async()=>context,f.authorize);
 assert.equal((await reopened.snapshot('workspace-1')).fragment.source.text,buffer.text);
 assert.equal((await f.run('check',{buffer})).ok,false,'unchanged code cannot be checked off');
 const edited={...buffer,text:'int main(void) {\nconst char *hello = "hello";\n}\n',version:2};
 r=await f.run('check',{buffer:edited});assert.equal(r.state.current,0);assert.ok(r.state.fragment);assert.equal(r.presentation.source.text,edited.text);assert.equal(r.presentation.answer.review.verdict,'context');
 r=await f.run('pause');assert.equal(r.state.status,'paused');assert.equal((await f.run('fragment',{buffer})).ok,false);
 await f.run('resume');r=await f.run('check',{buffer:edited});assert.equal(r.state.status,'complete');assert.equal(r.state.current,1);
 const restored=await new TutorGoalStore(f.dir).read(context.key);assert.equal(restored.status,'complete');
 assert.ok((await fs.readdir(f.dir)).every(name=>name.endsWith('.json')));
});
test('model cannot create out-of-project paths or invalid plans',()=>{
 for(const path of ['../secret.c','/secret.c','x.c','https://host/a.c']){
  assert.throws(()=>parseGoalPlan(JSON.stringify({title:'x',steps:[{title:'x',goal:'x',path}]}),context.files));
 }
 assert.throws(()=>parseGoalPlan('{"title":"x","steps":[]}',context.files));
});
test('two connections cannot silently replace each other’s draft',async t=>{
 const f=await fixture(t);f.responses.push(plan,plan);
 const other=new TutorGoalSession(f.store,f.provider,async()=>context,f.authorize);
 const make=session=>session.run({id:randomUUID(),workspaceId:'workspace-1',revision:0,action:'propose',prompt:'串口'});
 const results=await Promise.all([make(f.session),make(other)]);assert.equal(results.filter(r=>r.ok).length,1);
 assert.equal((await f.store.read(context.key)).revision,1);
});
test('cancelled and revoked model results never persist, including providers that ignore abort',async t=>{
 const f=await fixture(t);let finish;
 f.responses.push(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=f.run('propose',{prompt:'串口'});while(!finish)await new Promise(resolve=>setImmediate(resolve));
 f.session.cancel();finish(plan);assert.equal((await pending).cancelled,true);assert.equal((await f.store.read(context.key)).revision,0);
 f.responses.push(async()=>{f.revoke();return plan;});
 assert.equal((await f.run('propose',{prompt:'串口'})).ok,false);assert.equal((await f.store.read(context.key)).revision,0);
});
test('invalid model response and wrong file do not advance a goal',async t=>{
 const f=await fixture(t);f.responses.push(plan,'not-json');await f.run('propose',{prompt:'串口'});await f.run('confirm');
 assert.equal((await f.run('fragment',{buffer:{...buffer,path:'other.c'}})).ok,false);
 assert.equal((await f.run('fragment',{buffer})).ok,false);assert.equal((await f.store.read(context.key)).current,0);
});
test('persisted corrupt or symlink state is rejected instead of resetting progress',async t=>{
 const f=await fixture(t),file=join(f.dir,context.key+'.json');await fs.writeFile(file,'{bad');await assert.rejects(()=>f.store.read(context.key));
 await fs.unlink(file);const target=join(f.dir,'other');await fs.writeFile(target,'{}');await fs.symlink(target,file);await assert.rejects(()=>f.store.read(context.key));
});
test('project context and references use real chip metadata and reject escaped files',async t=>{
 const f=await fixture(t),root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'nodu-goal-project-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(join(root,'main.c'),'int main(void) {}\n');await fs.writeFile(join(root,'nodu.json'),JSON.stringify({kind:'stm32-hal',target:{mcu:context.mcu},sdk:context.sdk}));
 await fs.symlink(join(root,'main.c'),join(root,'alias.c'));
 const host=new TutorWorkspaceHost({authorizeWorkspace:async()=> 'workspace-1',revokeWorkspace(){},dispose(){}},()=>{});await host.select(pathToFileURL(root).href);
 const data=await host.context('workspace-1');assert.equal(data.mcu,context.mcu);assert.equal(data.sdk,context.sdk);assert.deepEqual(data.files,['main.c']);
 assert.deepEqual(await host.reference('workspace-1','main.c',1),{path:'main.c',line:1});
 await assert.rejects(()=>host.reference('workspace-1','../outside.c',1));await assert.rejects(()=>host.reference('workspace-1','alias.c',1));await assert.rejects(()=>host.reference('workspace-1','main.c',99));
});

test('authorized declarations and saved-build evidence distinguish dirty buffers without sending code when excluded',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'nodu-context-evidence-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const text='#include "main.h"\nint main(void) {}\n';
 await fs.writeFile(join(root,'main.c'),text);await fs.writeFile(join(root,'main.h'),'void Board_DebugUartInit(unsigned baud);');
 await fs.writeFile(join(root,'nodu.json'),JSON.stringify({target:{mcu:context.mcu},sdk:context.sdk}));
 let status='current',reads=0;
 const host=new TutorWorkspaceHost({authorizeWorkspace:async()=> 'workspace-1',revokeWorkspace(){},dispose(){}},()=>{},()=>{},async path=>{assert.equal(path,root);reads++;return {status,scope:'saved-project',bundle:'abc',runtime:{download:{bundle:'abc'},serial:{text:'fresh'}}};});
 await host.select(pathToFileURL(root).href);
 const noCode=await host.context('workspace-1');assert.equal(noCode.declarations,undefined);assert.equal(noCode.build.runtime,undefined);assert.equal(noCode.build.currentBufferSaved,undefined);
 const clean=await host.context('workspace-1',{path:'main.c',text,version:1,line:1});
 assert.equal(clean.declarations[0].path,'main.h');assert.equal(clean.build.currentBufferSaved,true);
 const dirty=await host.context('workspace-1',{path:'main.c',text:text+'// edit',version:2,line:1});assert.equal(dirty.build.currentBufferSaved,false);assert.equal(dirty.build.runtime,undefined);
 status='stale';assert.equal((await host.context('workspace-1')).build.status,'stale');assert.equal(reads,4);
});

test('local incomplete syntax blocks fragment advancement without calling the model',async t=>{
 const f=await fixture(t);f.responses.push(plan,fragment);await f.run('propose',{prompt:'serial',buffer});await f.run('confirm');await f.run('fragment',{buffer});
 const session=new TutorGoalSession(f.store,f.provider,async()=>({...context,localCheck:{schema:1,sourceDigest:'hash',syntax:'incomplete',errorLines:[2],findings:[]}}),f.authorize);
 const result=await session.run({id:randomUUID(),workspaceId:'workspace-1',revision:(await f.store.read(context.key)).revision,action:'check',buffer:{...buffer,text:'int main(void){\nint x = ;\n}',version:2}});
 assert.equal(result.ok,true);assert.equal(result.state.current,0);assert.equal(result.presentation.answer.review.verdict,'context');assert.equal(f.calls.length,2);
});
