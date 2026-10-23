// SPDX-License-Identifier: MIT
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{pathToFileURL}=require('node:url');
const repo=require('node:path').resolve(__dirname,'../..');
const lib=repo+'/desktop/scope-extension/lib';
const {TutorGoalStore}=require(lib+'/node/tutor/tutor-goal-store');
const {TutorGoalSession}=require(lib+'/node/tutor/tutor-goal-session');
const {TutorWorkspaceHost}=require(lib+'/node/tutor/tutor-workspace-host');
const {streamCompletion}=require(lib+'/node/tutor/tutor-model-gateway');
const {builtinProviders}=require(lib+'/common/tutor/tutor-ai-config');
const project=repo+'/artifacts/ai-tutor-nightly-20261024/projects/f103-tutor';
const source=project+'/Core/Src/main.c';
const output=repo+'/docs/ai-tutor/evidence/nightly-20261024-f103-model.json';
console.log('Explicit credential input ready');
process.stdin.once('data',async data=>{
 let key=data.toString().trim(),session;
 const report={mode:'product backend with scripted editor buffers, not Electron typing',project,requests:[],ok:false};
 try{
 const provider=builtinProviders()[0],model=provider.models.find(m=>m.id==='glm-5.3');
 if(provider.baseUrl!=='https://open.bigmodel.cn/api/coding/paas/v4')throw Error('endpoint mismatch');
 report.endpoint=provider.baseUrl;report.model=model.id;
 const host=new TutorWorkspaceHost({authorizeWorkspace:async()=> 'workspace-f103',revokeWorkspace(){},dispose(){}},()=>{});
 await host.select(pathToFileURL(project).href);
 const context=await host.context('workspace-f103');
 const store=new TutorGoalStore('/Users/wangwei/.codex/nodu-nightly-20261024/f103-goal-'+Date.now());
 session=new TutorGoalSession(store,{complete:(messages,signal,delta)=>streamCompletion({provider,model,key},messages,signal,delta)},(id,buffer)=>host.context(id,buffer),(id,buffer)=>host.authorize(id,buffer));
 let text=await fs.readFile(source,'utf8');
 // Create typing space, as the user pressing Enter would. Preserve the generated template elsewhere.
 await fs.writeFile(project+'/main-before-tutor.txt',text);
 text=text.replace('    while (1)\n    {\n    }','    while (1)\n    {\n\n    }');
 let buffer={path:'Core/Src/main.c',text,version:1,line:1};
 const request=async(action,extra={})=>{const result=await session.run({id:randomUUID(),workspaceId:'workspace-f103',revision:(await store.read(context.key)).revision,action,...extra});report.requests.push({action,result});if(!result.ok)throw Error(result.error);return result.state;};
 const plan=await request('propose',{prompt:'我想通过 USART1 每秒输出 NODU_TUTOR_F103_20261024。请用工程现有 Board 接口，拆成两步：第一步在时钟初始化后初始化调试串口；第二步在 while(1) 中发送这一行并等待一秒。不要创建新文件，不修改已有错误处理。',buffer});
 if(plan.steps.length!==2)throw Error('expected two steps in constrained lesson');
 await request('confirm');
 for(let i=0;i<2;i++){
  const lines=buffer.text.split('\n');const anchor=i===0?lines.findIndex(l=>l.includes('SystemClock_Config();'))+1:lines.findIndex(l=>/^\s*while \(1\)\s*$/.test(l))+2;
  if(lines[anchor]?.trim())throw Error('typing position is not blank');
  buffer={...buffer,line:anchor+1};
  const state=await request('fragment',{buffer}),g=state.fragment.answer.guidance;
  lines.splice(g.anchorLine-1,1,...g.lines,'');buffer={...buffer,text:lines.join('\n'),version:buffer.version+1,line:g.anchorLine+g.lines.length};
  const checked=await request('check',{buffer});
  if(checked.current!==i+1)throw Error('static review has not advanced');
 }
 await fs.writeFile(source,buffer.text);report.finalSource=buffer.text;report.ok=true;
 }catch(e){report.error=String(e.message).split(key).join('[redacted]');process.exitCode=1;}
 finally{key='';session?.dispose();await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,error:report.error,output}));process.stdin.destroy();}
});
