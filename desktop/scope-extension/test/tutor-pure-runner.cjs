// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),{join}=require('node:path'),{tmpdir}=require('node:os');
const {TutorPureRunner,pureHarness,verifyNoImports}=require('../lib/node/tutor/tutor-pure-runner');
const {tutorServiceFacade,TUTOR_SERVICE_METHODS}=require('../lib/common/tutor/tutor-ai-protocol');
const unit={functions:['sht30_crc8'],source:'uint8_t sht30_crc8(const uint8_t *data,uint8_t len){return 0;}'};
test('desktop facade forwards local inspection and all declared methods without exporting internals',async()=>{
 const calls=[]; const service=Object.fromEntries(Object.keys(TUTOR_SERVICE_METHODS).map(name=>[name,(...args)=>{calls.push([name,args]);return name;}]));
 service.privateHelper=()=>{};const rpc=tutorServiceFacade(Promise.resolve({service}));assert.equal(rpc.privateHelper,undefined);assert.ok(Object.isFrozen(rpc));
 assert.equal(await rpc.inspectBuffer('workspace',{path:'main.c'},[],'request'),'inspectBuffer');assert.deepEqual(calls[0],['inspectBuffer',['workspace',{path:'main.c'},[],'request']]);
 for(const name of Object.keys(TUTOR_SERVICE_METHODS)){assert.equal(await rpc[name](),name);}
});
test('only built-in harnesses and import-free bounded wasm are accepted',()=>{
 assert.equal(pureHarness(unit).total,193);
 for(const source of ['#include "/etc/passwd"','%:include "x"','??=include "x"','__asm__("nop");','\\\n#embed "x"']){assert.throws(()=>pureHarness({...unit,source}));}
 assert.throws(()=>pureHarness({...unit,functions:['run_tests']}));assert.throws(()=>pureHarness({...unit,functions:[]}));
 const header=Buffer.from([0,97,115,109,1,0,0,0]);assert.equal(verifyNoImports(header),true);
 for(const tail of [[2,1,0],[1,127],[1,128],[1,255,255,255,255,255,1]]) assert.equal(verifyNoImports(Buffer.concat([header,Buffer.from(tail)])),false);
 assert.equal(verifyNoImports(Buffer.alloc(256001)),false);
});
async function tools(t,compiler,runtime){
 const root=await fs.mkdtemp(join(tmpdir(),'nodu-fake-wasi-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const [name,body] of [['sdk/bin/clang',compiler],['runtime/wasmtime',runtime]]){const p=join(root,name);await fs.mkdir(join(p,'..'),{recursive:true});await fs.writeFile(p,`#!${process.execPath}\n${body}`,{mode:0o700});}
 const {TUTOR_TOOLKIT_REQUIRED,TUTOR_TOOLKIT_VERSION}=require('../lib/node/tutor/tutor-toolkit');
 for(const name of TUTOR_TOOLKIT_REQUIRED){const p=join(root,name);await fs.mkdir(join(p,'..'),{recursive:true});await fs.access(p).catch(()=>fs.writeFile(p,'fixture'));}
 const files=await Promise.all(TUTOR_TOOLKIT_REQUIRED.map(async path=>{const b=await fs.readFile(join(root,path));return {path,size:b.length,sha256:require('node:crypto').createHash('sha256').update(b).digest('hex')};}));
 await fs.writeFile(join(root,'toolkit.json'),JSON.stringify({schema:1,version:TUTOR_TOOLKIT_VERSION,platform:process.platform+'-'+process.arch,files,totalBytes:files.reduce((n,f)=>n+f.size,0)}));
 return new TutorPureRunner(root);
}
const clang='if(process.argv.includes("--version"))console.log("clang version 23.1.0");else require("fs").writeFileSync("test.wasm",Buffer.from([0,97,115,109,1,0,0,0]));';
const runtime='if(process.argv.includes("--version")) console.log("wasmtime 50.0.0"); else console.log(193);';
test('missing tools, cancellation, output limits and invalid runtime evidence never pass',async t=>{
 assert.equal((await new TutorPureRunner('/missing').inspect(unit,'digest')).status,'unavailable');
 const fake=await tools(t,clang,runtime);const pass=await fake.inspect(unit,'digest');assert.equal(pass.status,'passed');assert.equal(pass.passed,193);
 const bad=await tools(t,clang,runtime.replace('console.log(193)','console.log(194)'));assert.equal((await bad.inspect(unit,'d')).status,'unavailable');
 const slow=await tools(t,clang,'if(process.argv.includes("--version"))console.log("wasmtime 50.0.0");else setInterval(()=>{},100);');
 const controller=new AbortController(),pending=slow.inspect(unit,'d',controller.signal);setTimeout(()=>controller.abort(),100);assert.equal((await pending).status,'cancelled');
 const flood=await tools(t,clang,runtime.replace('console.log(193)','console.log("x".repeat(20000))'));assert.equal((await flood.inspect(unit,'d')).status,'unavailable');
 const trap=await tools(t,clang,runtime.replace('console.log(193)','process.exit(1)'));assert.equal((await trap.inspect(unit,'d')).status,'failed');
});
test('wall budget and concurrent limit terminate work without retaining execution slots',async t=>{
 const slow=await tools(t,clang,'if(process.argv.includes("--version"))console.log("wasmtime 50.0.0");else setInterval(()=>{},100);');
 const cancel=new AbortController();const one=slow.inspect(unit,'a'),two=slow.inspect(unit,'b',cancel.signal);
 assert.match((await slow.inspect(unit,'c')).note,/正在进行/);cancel.abort();assert.equal((await two).status,'cancelled');
 const timed=await one;assert.equal(timed.status,'unavailable');assert.match(timed.note,/时间限制/);
 const fast=await tools(t,clang,runtime);assert.equal((await fast.inspect(unit,'d')).status,'passed');
});
test('only a single integer on stdout is accepted as runtime evidence',async t=>{
 for(const body of ['console.error(193)','console.log("warning\\n193")','console.log("193\\n193")','console.log("193oops")','console.log(-1)']){
  const fake=await tools(t,clang,runtime.replace('console.log(193)',body));
  const result=await fake.inspect(unit,'digest');assert.equal(result.status,'unavailable',body);assert.equal(result.passed,0);
 }
 const fake=await tools(t,clang,runtime.replace('console.log(193)','{console.error("invocation warning");console.log(193)}'));
 assert.equal((await fake.inspect(unit,'digest')).status,'passed');
});
async function processFixture(t){
 const root=await fs.mkdtemp(join(tmpdir(),'nodu-process-tree-'));
 t.after(async()=>{
  try{const pid=Number(await fs.readFile(join(root,'pid'),'utf8'));process.kill(pid,'SIGKILL');}catch{}
  await fs.rm(root,{recursive:true,force:true});
 });
 return {root,runner:new TutorPureRunner(root)};
}
async function eventually(check){
 const deadline=Date.now()+2000;
 do{if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<deadline);
 assert.fail('process lifecycle condition was not met');
}
test('a signal cancelled before spawn never starts a process',async t=>{
 const {root,runner}=await processFixture(t),abort=new AbortController();abort.abort();
 const result=await runner.run(process.execPath,['-e','require("fs").writeFileSync("started","yes")'],root,abort.signal);
 assert.match(result.reason,/取消/);await assert.rejects(fs.access(join(root,'started')));
});
for(const inherited of [false,true])test(`normal parent exit reaps descendants with ${inherited?'inherited':'closed'} pipes`,{skip:process.platform==='win32'},async t=>{
 const {root,runner}=await processFixture(t);
 const code=`const cp=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${inherited?"['ignore',1,2]":"'ignore'"}});require('fs').writeFileSync('pid',String(cp.pid));cp.unref();process.exit(0);`;
 const result=await runner.run(process.execPath,['-e',code],root);
 assert.equal(result.code,0);assert.equal(result.reason,undefined);
 const pid=Number(await fs.readFile(join(root,'pid'),'utf8'));
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
});
test('cancellation reaps the process group and a subsequent run still succeeds',{skip:process.platform==='win32'},async t=>{
 const {root,runner}=await processFixture(t),abort=new AbortController();
 const code=`const cp=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});require('fs').writeFileSync('pid',String(cp.pid));setInterval(()=>{},1000);`;
 const pending=runner.run(process.execPath,['-e',code],root,abort.signal);
 await eventually(async()=>fs.access(join(root,'pid')).then(()=>true,()=>false));abort.abort();
 const result=await pending;assert.match(result.reason,/取消/);
 const pid=Number(await fs.readFile(join(root,'pid'),'utf8'));
 await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
 const next=await runner.run(process.execPath,['-e','console.log(7);console.error("notice")'],root);
 assert.equal(next.code,0);assert.equal(next.stdout,'7\n');assert.equal(next.stderr,'notice\n');
});
