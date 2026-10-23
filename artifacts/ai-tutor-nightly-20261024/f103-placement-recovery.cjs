// SPDX-License-Identifier: MIT
// Manual probe: pass a clean default F103 project and an explicit credential on stdin.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{pathToFileURL}=require('node:url'),{spawn}=require('node:child_process'),readline=require('node:readline');
const repo=path.resolve(__dirname,'../..'),lib=repo+'/desktop/scope-extension/lib';
const {TutorGoalStore}=require(lib+'/node/tutor/tutor-goal-store'),{TutorGoalSession}=require(lib+'/node/tutor/tutor-goal-session'),{TutorWorkspaceHost}=require(lib+'/node/tutor/tutor-workspace-host'),{streamCompletion}=require(lib+'/node/tutor/tutor-model-gateway'),{builtinProviders}=require(lib+'/common/tutor/tutor-ai-config');
if(!process.argv[2])throw Error('Pass a clean default F103 project');
console.log('Explicit credential input ready');
process.stdin.once('data',async data=>{
 let key=data.toString().trim(),session,host,child;
 const report={mode:'product backend scripted buffers and compile only; no Electron typing or hardware operations',requests:[],modelCalls:0,ok:false};
 const output=path.join(repo,'docs/ai-tutor/evidence/nightly-20261024-ninth-model.json');
 try{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nodu-placement-'));report.project=await fs.realpath(temp);
 await fs.cp(path.resolve(process.argv[2]),temp,{recursive:true,filter:src=>!['build','.nodu','.git'].includes(path.basename(src))});
 const provider=builtinProviders()[0],model=provider.models.find(m=>m.id==='glm-5.3');assert.equal(provider.baseUrl,'https://open.bigmodel.cn/api/coding/paas/v4');report.endpoint=provider.baseUrl;report.model=model.id;
 host=new TutorWorkspaceHost({authorizeWorkspace:async()=> 'workspace-recovery',revokeWorkspace(){},dispose(){}},()=>{});await host.select(pathToFileURL(temp).href);
 const project=await host.context('workspace-recovery'),store=new TutorGoalStore(path.join(temp,'.probe-progress'));
 const make=()=>new TutorGoalSession(store,{complete:(messages,signal,delta)=>{report.modelCalls++;return streamCompletion({provider,model,key},messages,signal,delta);}},(id,b)=>host.context(id,b),(id,b)=>host.authorize(id,b));session=make();
 let buffer={path:'Core/Src/main.c',text:await fs.readFile(path.join(temp,'Core/Src/main.c'),'utf8'),version:1,line:1};
 const call=async(action,extra={})=>{const result=await session.run({id:randomUUID(),workspaceId:'workspace-recovery',revision:(await store.read(project.key)).revision,action,...extra});report.requests.push({action,result});assert.equal(result.ok,true,result.error);return result.state;};
 const plan=await call('propose',{buffer,prompt:'在当前STM32F103C8T6默认工程中教我用Board现有驱动打印一次HELLO。只分两步：先在main的SystemClock_Config后初始化USART1，再在main内while循环前发送HELLO字符串。不创建新文件，不修改错误处理。每步给完整可编译的最多四行代码。'});assert.equal(plan.steps.length,2);await call('confirm');
 for(let i=0;i<2;i++){
  const state=await call('fragment',{buffer,placement:'suggest'}),g=state.fragment.answer.guidance;
  const before=buffer.text.split('\n'),mainStart=before.findIndex(l=>l.includes('int main(void)')),loop=before.findIndex(l=>/^\s*while\s*\(1\)/.test(l));
  assert.ok(g.anchorLine-1>mainStart&&g.anchorLine-1<loop,'fragment must be inside main before loop');
  await call('pause');session.dispose();session=make();const restored=await session.snapshot('workspace-recovery');assert.deepEqual(restored.fragment,state.fragment);await call('resume');
  before.splice(g.anchorLine-1,1,...g.lines,'');buffer={...buffer,text:before.join('\n'),version:buffer.version+1,line:g.anchorLine+g.lines.length};
  const checked=await call('check',{buffer});assert.equal(checked.current,i+1);
 }
 await fs.writeFile(path.join(temp,'Core/Src/main.c'),buffer.text);report.finalSource=buffer.text;
 child=spawn(repo+'/desktop/scope-extension/resources/bin/darwin-arm64/nodu-embedded',['--resources',repo+'/desktop/scope-extension/resources/stm32','--toolkit',repo+'/desktop/.tools/stm32/darwin','--data-dir',path.join(temp,'.probe-native')],{stdio:['pipe','pipe','pipe']});
 let seq=0;const pending=new Map();
 child.once('error',error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();});
 readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);p.resolve(m);}});
 const nativeCall=method=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('native timeout'));},60000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,args:{path:temp}})+'\n');});
 // The caller supplies a trusted clean template; only our isolated copy is trusted.
 report.trust=await nativeCall('trustProject');report.build=await nativeCall('build');
 assert.equal(report.build.result?.ok,true,JSON.stringify(report.build));report.ok=true;
 }catch(e){report.error=String(e.message).split(key).join('[redacted]');process.exitCode=1;}
 finally{key='';session?.dispose();host?.dispose();child?.stdin.end();child?.kill();await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,error:report.error,modelCalls:report.modelCalls,output}));process.stdin.destroy();}
});
