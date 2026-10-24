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
 await fs.mkdir(join(root,'reference'));await fs.writeFile(join(root,'reference/answer.c'),'int answer;');
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
 const session=new TutorGoalSession(f.store,f.provider,async(id,b)=>({...context,localCheck:{schema:1,sourceDigest:'hash',syntax:b?.text.includes('int x = ;')?'incomplete':'valid',errorLines:[2],findings:[]}}),f.authorize);
 const result=await session.run({id:randomUUID(),workspaceId:'workspace-1',revision:(await f.store.read(context.key)).revision,action:'check',buffer:{...buffer,text:'int main(void){\nint x = ;\n}',version:2}});
 assert.equal(result.ok,true);assert.equal(result.state.current,0);assert.equal(result.presentation.answer.review.verdict,'context');assert.equal(f.calls.length,2);
});

test('suggested placement chooses only native-approved blank lines and keeps cursor-mode strict', async t=>{
 const f=await fixture(t);f.responses.push(plan);await f.run('propose',{prompt:'串口'});await f.run('confirm');
 const session=new TutorGoalSession(f.store,f.provider,async()=>({...context,localCheck:{insertionLines:[2],syntax:'valid'}}),f.authorize);
 t.after(()=>session.dispose());const call=extra=>session.run({id:randomUUID(),workspaceId:'workspace-1',revision:2,action:'fragment',buffer:{...buffer,line:1},placement:'suggest',...extra});
 f.responses.push(JSON.stringify({text:'wrong',annotations:[],guidance:{anchorLine:1,lines:['int x;']}}));
 assert.equal((await call({})).ok,false);assert.equal((await f.store.read(context.key)).fragment,undefined);
 f.responses.push(fragment);const result=await call({});assert.equal(result.ok,true);assert.equal(result.state.fragment.source.line,2);assert.equal(result.presentation.source.line,2);
 assert.match(f.calls.at(-1)[0].content,/可用空白行/);
 assert.equal((await f.run('fragment',{buffer:{...buffer,line:1}})).ok,false);
});

test('failed pure execution blocks goal advance even when the provider would approve',async t=>{
 const f=await fixture(t);f.responses.push(plan,fragment);await f.run('propose',{prompt:'serial',buffer});await f.run('confirm');await f.run('fragment',{buffer});
 const session=new TutorGoalSession(f.store,f.provider,async()=>({...context,localCheck:{syntax:'valid',execution:{status:'failed',note:'纯函数测试 35/196'}}}),f.authorize);t.after(()=>session.dispose());
 const result=await session.run({id:randomUUID(),workspaceId:'workspace-1',revision:(await f.store.read(context.key)).revision,action:'check',buffer:{...buffer,text:buffer.text.replace('\n\n','\nint x;\n'),version:2}});
 assert.equal(result.ok,true);assert.equal(result.state.current,0);assert.equal(result.presentation.answer.review.verdict,'needs-work');assert.equal(f.calls.length,2);
});
test('pure execution evidence is bound to source, workspace and a short freshness window',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'nodu-pure-context-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(join(root,'main.c'),buffer.text);
 const host=new TutorWorkspaceHost({authorizeWorkspace:async()=> 'workspace-1',revokeWorkspace(){},dispose(){}},()=>{});await host.select(pathToFileURL(root).href);t.after(()=>host.dispose());
 const digest=require('node:crypto').createHash('sha256').update(buffer.text).digest('hex');host.checker={inspect:async b=>({syntax:'valid',sourceDigest:require('node:crypto').createHash('sha256').update(b.text).digest('hex')})};
 const result={suite:'sht30-pure-v1',sourceDigest:digest,status:'passed',passed:196,total:196,note:'test'};
 host.rememberExecution('other',buffer,result);assert.equal((await host.context('workspace-1',buffer)).localCheck.execution,undefined);
 host.rememberExecution('workspace-1',buffer,result);assert.equal((await host.context('workspace-1',buffer)).localCheck.execution.status,'passed');
 assert.equal((await host.context('workspace-1',{...buffer,text:buffer.text+'// changed'})).localCheck.execution,undefined);
 host.executions.get('workspace-1:main.c').time-=61000;assert.equal((await host.context('workspace-1',buffer)).localCheck.execution,undefined);
 await host.select('');assert.equal(host.executions.size,0);
});


test('malformed goal JSON retries once without accepting trailing prose or persisting partial plans', async t=>{
 const f=await fixture(t);f.responses.push(plan+' trailing prose',plan);
 const result=await f.run('propose',{prompt:'串口'});assert.equal(result.ok,true);assert.equal(f.calls.length,2);
 assert.match(f.calls[1][0].content,/只输出一个完整JSON对象/);assert.equal((await f.store.read(context.key)).revision,1);
 const g=await fixture(t);g.responses.push(plan+'{}','incomplete');
 const failed=await g.run('propose',{prompt:'串口'});assert.equal(failed.ok,false);assert.equal(failed.error,'模型回复格式或代码位置无效，请重试');
 assert.equal(g.calls.length,2);assert.equal((await g.store.read(context.key)).revision,0);
});


test('fragment is checked in a prospective buffer before a misplaced ghost can persist',async t=>{
 const f=await fixture(t);f.responses.push(plan);await f.run('propose',{prompt:'serial'});await f.run('confirm');
 const session=new TutorGoalSession(f.store,f.provider,async(id,b)=>({...context,localCheck:{insertionLines:[2],syntax:b?.text.includes('wrong();')?'incomplete':'valid'}}),f.authorize);t.after(()=>session.dispose());
 f.responses.push(JSON.stringify({text:'bad',annotations:[],guidance:{anchorLine:2,lines:['wrong();']}}),fragment);
 const r=await session.run({id:randomUUID(),workspaceId:'workspace-1',revision:2,action:'fragment',buffer,placement:'suggest'});
 assert.equal(r.ok,true);assert.equal(r.state.fragment.answer.guidance.lines[0],'const char *hello = "hello";');assert.equal(f.calls.length,3);
 assert.match(JSON.parse(f.calls[1][1].content).numberedSource,/2: /);
});


test('restored fragments are rechecked without changing revision or calling the model',async t=>{
 const f=await fixture(t);f.responses.push(plan,fragment);await f.run('propose',{prompt:'serial'});await f.run('confirm');await f.run('fragment',{buffer});await f.run('pause');
 const saved=await f.store.read(context.key);let syntax='incomplete';
 const reopened=new TutorGoalSession(f.store,f.provider,async()=>({...context,localCheck:{syntax}}),f.authorize);t.after(()=>reopened.dispose());
 assert.equal((await reopened.snapshot('workspace-1')).fragment,undefined);assert.equal((await f.store.read(context.key)).revision,saved.revision);assert.ok((await f.store.read(context.key)).fragment);
 syntax='unavailable';assert.equal((await reopened.snapshot('workspace-1')).fragment,undefined);
 syntax='valid';assert.deepEqual((await reopened.snapshot('workspace-1')).fragment,saved.fragment);assert.equal(f.calls.length,2);
 syntax='incomplete';const result=await reopened.run({id:randomUUID(),workspaceId:'workspace-1',revision:saved.revision,action:'resume'});
 assert.equal(result.ok,true);assert.equal(result.state.status,'active');assert.equal(result.state.fragment,undefined);assert.equal(result.state.current,0);
});
test('changed target or revoked source cannot restore an old fragment',async t=>{
 const f=await fixture(t);f.responses.push(plan,fragment);await f.run('propose',{prompt:'serial'});await f.run('confirm');await f.run('fragment',{buffer});
 const different=new TutorGoalSession(f.store,f.provider,async()=>({...context,mcu:'STM32F407ZGT6'}),f.authorize);t.after(()=>different.dispose());assert.equal((await different.snapshot('workspace-1')).fragment,undefined);
 const revoked=new TutorGoalSession(f.store,f.provider,async()=>context,async(id,b)=>{if(b)throw Error('source revoked');});t.after(()=>revoked.dispose());await assert.rejects(()=>revoked.snapshot('workspace-1'),/source revoked/);
 const cancelled=await revoked.run({id:randomUUID(),workspaceId:'workspace-1',revision:(await f.store.read(context.key)).revision,action:'cancel'});assert.equal(cancelled.ok,true);assert.equal(cancelled.state.status,'cancelled');assert.equal(cancelled.state.fragment,undefined);
});


test('missing context is explained once and never converted into fabricated guidance',async t=>{
 const f=await fixture(t);f.responses.push(plan);await f.run('propose',{prompt:'serial'});await f.run('confirm');
 const session=new TutorGoalSession(f.store,f.provider,async()=>({...context,localCheck:{syntax:'valid',insertionLines:[2]}}),f.authorize);t.after(()=>session.dispose());
 f.responses.push(JSON.stringify({text:'请先提供传感器接线与驱动声明。',annotations:[]}));
 const result=await session.run({id:randomUUID(),workspaceId:'workspace-1',revision:2,action:'fragment',buffer,placement:'suggest'});
 assert.equal(result.ok,false);assert.equal(result.error,'请先提供传感器接线与驱动声明。');assert.equal(f.calls.length,2);assert.equal((await f.store.read(context.key)).fragment,undefined);
 const unavailable=new TutorGoalSession(f.store,f.provider,async()=>({...context,localCheck:{syntax:'unavailable',note:'检查器忙'}}),f.authorize);t.after(()=>unavailable.dispose());
 const failed=await unavailable.run({id:randomUUID(),workspaceId:'workspace-1',revision:2,action:'fragment',buffer});assert.equal(failed.ok,false);assert.equal(failed.error,'检查器忙');assert.equal(f.calls.length,2);
});

async function workspaceFixture(t) {
 const parent=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'nodu-grant-boundary-')));t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=join(parent,'project');await fs.mkdir(root);await fs.writeFile(join(root,'main.c'),buffer.text);
 let next=0;const revoked=[],cancelled=[],live=new Map();
 const storage={authorizeWorkspace:async path=>{const id=`workspace-${++next}`;live.set(id,path);return id;},revokeWorkspace:id=>{revoked.push(id);live.delete(id);},dispose(){live.clear();}};
 const host=new TutorWorkspaceHost(storage,id=>cancelled.push(id));t.after(()=>host.dispose());
 return {parent,root,host,storage,revoked,cancelled,live};
}
test('failed workspace selection can retry the same path or return to an empty workbench',async t=>{
 const f=await workspaceFixture(t),missing=join(f.parent,'later'),uri=pathToFileURL(missing).href;
 await assert.rejects(()=>f.host.select(uri));await f.host.select('');assert.deepEqual(await f.host.list(),[]);
 await assert.rejects(()=>f.host.select(uri));await fs.mkdir(missing);await f.host.select(uri);assert.equal((await f.host.list()).length,1);
});
test('a failed multi-root selection revokes all partial grants before retry',async t=>{
 const f=await workspaceFixture(t),workspace=join(f.parent,'test.code-workspace');
 await fs.writeFile(workspace,JSON.stringify({folders:[{path:'project'},{path:'missing'}]}));
 await assert.rejects(()=>f.host.select(pathToFileURL(workspace).href));assert.equal(f.live.size,0);assert.equal(f.revoked.length,1);assert.equal(f.cancelled.length,1);
 await fs.mkdir(join(f.parent,'missing'));await f.host.select(pathToFileURL(workspace).href);assert.equal((await f.host.list()).length,2);
});
test('replacing a directory revokes model, reference and execution access until explicitly reopened',async t=>{
 const f=await workspaceFixture(t),uri=pathToFileURL(f.root).href;await f.host.select(uri);const [{id}]=await f.host.list();
 await fs.rename(f.root,join(f.parent,'previous'));await fs.mkdir(f.root);await fs.writeFile(join(f.root,'main.c'),'int replacement;');
 await assert.rejects(()=>f.host.authorize(id),/目录已改变/);assert.ok(f.revoked.includes(id));assert.ok(f.cancelled.includes(id));
 await assert.rejects(()=>f.host.context(id));await assert.rejects(()=>f.host.reference(id,'main.c',1));assert.equal(f.live.size,0);
 await f.host.select(uri);const [fresh]=await f.host.list();assert.notEqual(fresh.id,id);assert.equal((await f.host.context(fresh.id)).files[0],'main.c');
});
test('replacement by a symlink does not inherit the original project grant',async t=>{
 const f=await workspaceFixture(t);await f.host.select(pathToFileURL(f.root).href);const [{id}]=await f.host.list();
 await fs.rename(f.root,join(f.parent,'old'));await fs.symlink(join(f.parent,'old'),f.root);
 await assert.rejects(()=>f.host.context(id));assert.equal(f.live.size,0);
});
test('overlapping selections cannot revoke the final selection through a reused backend grant',async t=>{
 const f=await workspaceFixture(t),other=join(f.parent,'other');await fs.mkdir(other);
 let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let count=0;
 f.storage.authorizeWorkspace=async path=>{count++;const existing=[...f.live].find(([,p])=>p===path);const id=existing?.[0]??`workspace-${count}`;f.live.set(id,path);if(count===1){entered();await gate;}return id;};
 const first=f.host.select(pathToFileURL(f.root).href);await started;
 const middle=f.host.select(pathToFileURL(other).href),last=f.host.select(pathToFileURL(f.root).href);release();await Promise.all([first,middle,last]);
 const grants=await f.host.list();assert.equal(grants.length,1);assert.ok(f.live.has(grants[0].id));assert.equal(count,2);assert.equal(f.live.size,1);
});
test('project revocation during context collection prevents returning old context',async t=>{
 const f=await workspaceFixture(t);await fs.writeFile(join(f.root,'nodu.json'),JSON.stringify({target:{mcu:'STM32F103C8T6'}}));
 f.host.buildStatus=async()=>{await f.host.select('');return {status:'none',scope:'saved-project'};};
 await f.host.select(pathToFileURL(f.root).href);const [{id}]=await f.host.list();await assert.rejects(()=>f.host.context(id));assert.deepEqual(await f.host.list(),[]);
});
test('metadata FIFO is ignored without blocking and oversized code is not read', {skip:process.platform==='win32'},async t=>{
 const f=await workspaceFixture(t);require('node:child_process').execFileSync('mkfifo',[join(f.root,'nodu.json')]);
 await f.host.select(pathToFileURL(f.root).href);const [{id}]=await f.host.list();const data=await f.host.context(id);assert.equal(data.mcu,'未知');
 await fs.writeFile(join(f.root,'large.c'),'x'.repeat(32001));await assert.rejects(()=>f.host.reference(id,'large.c',1),/大小限制/);
});
test('growing code is read with a fixed byte budget and rejected instead of exporting a partial file',async t=>{
 const f=await workspaceFixture(t),target=join(f.root,'main.c');await f.host.select(pathToFileURL(f.root).href);const [{id}]=await f.host.list();
 const open=fs.open;let biggest=0,grew=false,closed=false;
 fs.open=async function(file,...args){const handle=await open.call(fs,file,...args);if(file===target){const read=handle.read.bind(handle),close=handle.close.bind(handle);handle.read=async(...values)=>{biggest=Math.max(biggest,values[2]);if(!grew){grew=true;await fs.appendFile(target,'x'.repeat(100000));}return read(...values);};handle.close=async()=>{closed=true;return close();};}return handle;};
 try{await assert.rejects(()=>f.host.reference(id,'main.c',1),/大小限制/);}finally{fs.open=open;}
 assert.equal(biggest,32001);assert.equal(closed,true);
});
test('a file replaced between lstat and open is refused without reading its content',async t=>{
 const f=await workspaceFixture(t),target=join(f.root,'main.c');await f.host.select(pathToFileURL(f.root).href);const [{id}]=await f.host.list();
 const open=fs.open;let replaced=false,reads=0;
 fs.open=async function(file,...args){if(file===target&&!replaced){replaced=true;await fs.rename(target,join(f.root,'original.c'));await fs.writeFile(target,'int replaced;');}const handle=await open.call(fs,file,...args);const read=handle.read.bind(handle);handle.read=async(...values)=>{reads++;return read(...values);};return handle;};
 try{await assert.rejects(()=>f.host.reference(id,'main.c',1),/已改变/);}finally{fs.open=open;}assert.equal(reads,0);
});

test('gateway rejection after a valid-looking review does not persist or advance a teaching step', async t => {
 const {streamCompletion}=require('../lib/node/tutor/tutor-model-gateway');
 const {modelDefaults}=require('../lib/common/tutor/tutor-ai-config');
 const f=await fixture(t);f.responses.push(plan,fragment);
 await f.run('propose',{prompt:'串口'});await f.run('confirm');await f.run('fragment',{buffer});
 const before=await f.store.read(context.key);
 const configured={provider:{id:'local',name:'local',kind:'custom',enabled:true,baseUrl:'http://localhost:8080/v1',apiFormat:'chat-completions',models:[]},model:modelDefaults('test')};
 let finishReason='content_filter';
 const gateway={complete:(messages,signal,delta)=>streamCompletion(configured,messages,signal,delta,async()=>new Response(
  `data: ${JSON.stringify({choices:[{delta:{content:review('ok')}}]})}\n\n`+
  `data: ${JSON.stringify({choices:[{delta:{},finish_reason:finishReason}]})}\n\ndata: [DONE]\n\n`
 ))};
 const session=new TutorGoalSession(f.store,gateway,async()=>({...context}),f.authorize);t.after(()=>session.dispose());
 const edited={...buffer,text:'int main(void) {\nconst char *hello = "hello";\n}\n',version:2};
 const run=()=>session.run({id:randomUUID(),workspaceId:'workspace-1',revision:before.revision,action:'check',buffer:edited});
 const result=await run();assert.equal(result.ok,false);assert.match(result.error,/不支持/);
 assert.deepEqual(await f.store.read(context.key),before);
 finishReason='stop';const retry=await run();assert.equal(retry.ok,true);assert.equal(retry.state.status,'complete');
});

test('UTF-8 record budget rejects oversized Chinese progress before replacing the last saved state', async t => {
 const f=await fixture(t);f.responses.push(plan);await f.run('propose',{prompt:'串口'});
 const before=await f.store.read(context.key);
 const large={...before,status:'active',goal:'中'.repeat(6000),title:'中'.repeat(120),feedback:'中'.repeat(12000),
  steps:Array.from({length:24},(_,i)=>({id:`step-${i+1}`,title:'中'.repeat(120),goal:'中'.repeat(1200),path:'main.c'})),
  fragment:{source:{...buffer,text:'中'.repeat(32000),line:1},answer:{text:'中'.repeat(12000),annotations:[],guidance:{anchorLine:1,lines:['int x;']}}}};
 assert.ok(JSON.stringify(large).length<256000);assert.ok(Buffer.byteLength(JSON.stringify(large))>256000);
 await assert.rejects(()=>f.store.write(context.key,before.revision,large,async()=>{}),/记录过大/);
 assert.deepEqual(await f.store.read(context.key),before);
 large.fragment.source.text='中'.repeat(20000);
 const saved=await f.store.write(context.key,before.revision,large,async()=>{});
 assert.deepEqual(await new TutorGoalStore(f.dir).read(context.key),saved);
 assert.deepEqual(await fs.readdir(f.dir),[context.key+'.json']);
});

test('goal records reject FIFO, directories and invalid UTF-8 without replacing progress', {timeout:2000}, async t => {
 const f=await fixture(t),file=join(f.dir,context.key+'.json');
 await fs.mkdir(file);await assert.rejects(()=>f.store.read(context.key),/教学文件无效/);await fs.rmdir(file);
 await fs.writeFile(file,Buffer.from([0xc3]));await assert.rejects(()=>f.store.read(context.key),/编码无效/);await fs.unlink(file);
 if(process.platform!=='win32'){
  const {execFileSync}=require('node:child_process');execFileSync('mkfifo',[file]);
  await assert.rejects(()=>f.store.read(context.key),/教学文件无效/);
 }
});

test('cancelled authorization before atomic goal replacement leaves prior progress and no temporary file', async t => {
 const f=await fixture(t);f.responses.push(plan);await f.run('propose',{prompt:'串口'});
 const before=await f.store.read(context.key);
 await assert.rejects(()=>f.store.write(context.key,before.revision,{...before,status:'active'},async()=>{throw Error('revoked');}),/revoked/);
 assert.deepEqual(await f.store.read(context.key),before);assert.deepEqual(await fs.readdir(f.dir),[context.key+'.json']);
});

test('corrupted status, step and fragment relationships are rejected on restore', async t => {
 const {validateGoalState}=require('../lib/common/tutor/tutor-goal');
 const f=await fixture(t);f.responses.push(plan,fragment);await f.run('propose',{prompt:'串口'});await f.run('confirm');await f.run('fragment',{buffer});
 const good=await f.store.read(context.key);
 const corrupt=[{...good,current:1},{...good,status:'none'},{...good,status:'draft'},
  {...good,status:'complete'},{...good,status:'cancelled'},
  {...good,steps:[null]},{...good,steps:[{...good.steps[0],path:123}]},
  {...good,fragment:{...good.fragment,source:{...good.fragment.source,path:'other.c'}}}];
 for(const value of corrupt){
  assert.throws(()=>validateGoalState(value),/教学.*损坏/);
  await fs.writeFile(join(f.dir,context.key+'.json'),JSON.stringify(value));
  await assert.rejects(()=>f.store.read(context.key),/教学.*损坏/);
 }
});

test('task additions use stable IDs and removal undo preserves progress across restart', async t => {
 const f=await fixture(t);f.responses.push(plan);await f.run('propose',{prompt:'串口'});await f.run('confirm');
 f.responses.push(JSON.stringify({title:'增加内容',steps:[{title:'发送消息',goal:'发送数组',path:'main.c'},{title:'延时',goal:'加入延时',path:'main.c'}]}));
 let r=await f.run('add',{prompt:'发送消息并延时'});assert.equal(r.ok,true);const ids=r.state.steps.map(s=>s.id);assert.equal(new Set(ids).size,3);
 r=await f.run('remove',{stepId:ids[1]});assert.deepEqual(r.state.steps.map(s=>s.id),[ids[0],ids[2]]);assert.equal(r.state.current,0);
 const restored=await new TutorGoalStore(f.dir).read(context.key);assert.equal(restored.removed.step.id,ids[1]);
 r=await f.run('undo-remove');assert.deepEqual(r.state.steps.map(s=>s.id),ids);assert.equal(r.state.removed,undefined);
 assert.equal(f.calls.length,2,'remove/undo do not call the model');
});
test('removing current step clears only guidance, pauses, and cannot count deletion as completion', async t=>{
 const f=await fixture(t);f.responses.push(JSON.stringify({title:'串口',steps:[{title:'定义',goal:'定义消息',path:'main.c'},{title:'发送',goal:'发送消息',path:'main.c'}]}),fragment);
 await f.run('propose',{prompt:'串口'});await f.run('confirm');await f.run('fragment',{buffer});
 let r=await f.run('remove',{stepId:'step-1'});assert.equal(r.state.status,'paused');assert.equal(r.state.fragment,undefined);assert.equal(r.state.current,0);assert.equal(r.state.steps[0].id,'step-2');
 assert.equal((await f.run('remove',{stepId:'step-2'})).ok,false);assert.equal((await f.store.read(context.key)).status,'paused');
 r=await f.run('undo-remove');assert.equal(r.state.steps[0].id,'step-1');assert.equal(r.state.status,'paused');assert.equal(r.state.fragment,undefined);
});
test('completed step history cannot be deleted; append reopens complete goal paused',async t=>{
 const f=await fixture(t);f.responses.push(plan,fragment,review('ok'),plan);
 await f.run('propose',{prompt:'串口'});await f.run('confirm');await f.run('fragment',{buffer});
 await f.run('check',{buffer:{...buffer,text:'int main(void) {\nconst char *hello = "hello";\n}\n',version:2}});
 assert.equal((await f.run('remove',{stepId:'step-1'})).ok,false);
 const r=await f.run('add',{prompt:'增加第二条消息'});assert.equal(r.state.status,'paused');assert.equal(r.state.current,1);assert.equal(r.state.steps.length,2);
 assert.equal((await f.run('remove',{stepId:'step-1'})).ok,false);
});
test('revision conflict prevents a late model addition from resurrecting removed steps',async t=>{
 const f=await fixture(t);f.responses.push(JSON.stringify({title:'串口',steps:[{title:'定义',goal:'定义消息',path:'main.c'},{title:'发送',goal:'发送消息',path:'main.c'}]}));
 await f.run('propose',{prompt:'串口'});await f.run('confirm');let finish;
 f.responses.push(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.run('add',{prompt:'增加延时'});
 while(!finish)await new Promise(r=>setImmediate(r));
 const other=new TutorGoalSession(f.store,f.provider,async()=>({...context}),f.authorize);t.after(()=>other.dispose());
 const r=await other.run({id:randomUUID(),workspaceId:'workspace-1',revision:(await f.store.read(context.key)).revision,action:'remove',stepId:'step-2'});assert.equal(r.ok,true);
 finish(plan);assert.equal((await pending).ok,false);assert.deepEqual((await f.store.read(context.key)).steps.map(s=>s.id),['step-1']);
});
test('invalid additions and duplicate IDs never replace a valid task',async t=>{
 const f=await fixture(t);f.responses.push(plan);await f.run('propose',{prompt:'串口'});const prior=await f.store.read(context.key);
 f.responses.push(JSON.stringify({title:'x',steps:[{title:'x',goal:'x',path:'../secret.c'}]}));assert.equal((await f.run('add',{prompt:'新增'})).ok,false);
 assert.deepEqual(await f.store.read(context.key),prior);
 await assert.rejects(()=>f.store.write(context.key,prior.revision,{...prior,steps:[prior.steps[0],prior.steps[0]]},async()=>{}));
 assert.equal((await f.run('add',{prompt:' '.repeat(8)})).ok,false);
});
