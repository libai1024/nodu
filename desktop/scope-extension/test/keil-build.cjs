// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),p=require('node:path'),os=require('node:os');
const {buildWithKeil,runKeilTarget,keilDiagnostics}=require('../lib/node/nodu-keil-build');
const digest='a'.repeat(64);
async function fixture(t){
 const root=await fs.mkdtemp(p.join(os.tmpdir(),'nodu-keil-build-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const calls=[];const controller=new AbortController();
 const project={path:root,manifest:{keil:{autoSync:false}}};
 const host={resources:'/resources',signal:controller.signal,progress(){},
 request:async(method,args)=>{calls.push({method,args});return method==='configure'?{ok:true,compileCommands:'/db',inputDigest:digest}:{ok:true,artifact:{bundleSha256:'verified'}};},
 generate:async()=>{calls.push({method:'generate'});return{path:p.join(root,'MDK-ARM/Nodu.uvprojx')};},
 compiler:async()=>{calls.push({method:'keil'});return{compatibility:'passed',compilation:'unavailable',targets:[]};}};
 return{root,project,host,calls,controller};
}
test('a local build always passes the compatibility gate even when idle autoSync is off',async t=>{
 const f=await fixture(t);const result=await buildWithKeil(f.project,false,f.host);
 assert.equal(result.ok,true);assert.equal(result.keil.compilation,'unavailable');
 assert.deepEqual(f.calls.map(c=>c.method),['configure','generate','keil','build']);
 assert.equal(f.calls[0].args.invalidateCurrent,true);assert.equal(f.calls.at(-1).args.expectedInputDigest,digest);
 await assert.rejects(fs.stat(p.join(f.root,'.nodu/keil-check.lock')),{code:'ENOENT'});
});
test('source/configuration/Keil failures stop before GCC and release the project reservation',async t=>{
 for(const phase of ['configure','generate','compiler']){
  const f=await fixture(t);let reached=false;
  if(phase==='configure')f.host.request=async()=>({ok:false});
  else f.host[phase]=async()=>{throw Object.assign(Error('not portable'),{code:'keilSource'});};
  const original=f.host.request;f.host.request=async(method,args)=>{if(method==='build')reached=true;return original(method,args);};
  await assert.rejects(buildWithKeil(f.project,false,f.host));assert.equal(reached,false);
  await assert.rejects(fs.stat(p.join(f.root,'.nodu/keil-check.lock')),{code:'ENOENT'});
 }
});
test('old native components cannot silently bypass the input revision guard',async t=>{
 const f=await fixture(t);f.host.request=async()=>({ok:true,compileCommands:'/db'});
 await assert.rejects(buildWithKeil(f.project,false,f.host),{code:'versionMismatch'});
});
test('cancelled Keil verification cannot continue into GCC or produce a successful result',async t=>{
 const f=await fixture(t);f.host.compiler=async()=>{f.controller.abort();return{compatibility:'passed',compilation:'passed',targets:[]};};
 await assert.rejects(buildWithKeil(f.project,false,f.host),{code:'cancelled'});assert(!f.calls.some(c=>c.method==='build'));
});
test('two desktop windows cannot concurrently maintain/build the same Keil project',async t=>{
 const f=await fixture(t);let release,entered;
 const ready=new Promise(r=>entered=r);f.host.compiler=async()=>{entered();await new Promise(r=>release=r);return{compatibility:'passed',compilation:'passed',targets:[]};};
 const first=buildWithKeil(f.project,false,f.host);await ready;
 await assert.rejects(buildWithKeil(f.project,false,f.host),{code:'keilBusy'});release();assert((await first).ok);
});
test('Keil compiler errors map source paths and lines to project diagnostics',()=>{
 const rows=keilDiagnostics('../App/gas.c(17): error: missing type\n../Core/main.c(23,4): warning: unused','/project/MDK-ARM/Nodu.uvprojx');
 assert.equal(rows[0].absolute,'/project/App/gas.c');assert.equal(rows[0].line,17);assert.equal(rows[1].column,4);assert.equal(rows[1].severity,'warning');
});
if(process.platform!=='win32')test('the real child runner requires a fresh successful log, accepts warnings and stops on cancellation',async t=>{
 const root=await fs.mkdtemp(p.join(os.tmpdir(),'nodu-keil-child-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const command=p.join(root,'fake-uv4');
 await fs.writeFile(command,'#!/usr/bin/env node\nconst fs=require("fs");const args=process.argv.slice(2),log=args[args.indexOf("-o")+1],target=args[args.indexOf("-t")+1];if(target==="missing"){process.exit(0);}if(target==="cancel"){setInterval(()=>{},1000);}else {fs.writeFileSync(log,target==="error"?"../App/main.c(4): error: compile error\\n1 Error(s), 0 Warning(s).":"0 Error(s), 2 Warning(s).");process.exit(target==="error"?2:1);}\n',{mode:0o755});
 const log=p.join(root,'test.log'),signal=new AbortController();
 assert.equal((await runKeilTarget(command,p.join(root,'Nodu.uvprojx'),'warnings',log,signal.signal)).warnings,2);
 await assert.rejects(runKeilTarget(command,p.join(root,'Nodu.uvprojx'),'missing',log,signal.signal),{code:'keilCompile'});
 await assert.rejects(runKeilTarget(command,p.join(root,'Nodu.uvprojx'),'error',log,signal.signal),{code:'keilCompile'});
 const pending=runKeilTarget(command,p.join(root,'Nodu.uvprojx'),'cancel',log,signal.signal);setTimeout(()=>signal.abort(),60);
 await assert.rejects(pending,{code:'cancelled'});
});
