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
 for(const [name,body] of [['sdk/bin/clang',compiler],['runtime/wasmtime',runtime]]){const p=join(root,name);await fs.mkdir(join(p,'..'),{recursive:true});await fs.writeFile(p,`#!${process.execPath}\n${body}`,{mode:0o700});}return new TutorPureRunner(root);
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
