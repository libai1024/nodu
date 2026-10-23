// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),{join}=require('node:path'),{tmpdir}=require('node:os');
const {TutorLocalChecker}=require('../lib/node/tutor/tutor-local-checker');
const buffer={path:'main.c',text:'int main(void){return 0;}',line:1,version:1};
async function fake(t,body){const dir=await fs.mkdtemp(join(tmpdir(),'nodu-checker-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=join(dir,'checker');await fs.writeFile(file,'#!'+process.execPath+'\n'+body,{mode:0o700});return new TutorLocalChecker(file);}
test('missing checker and unsupported languages stay unavailable, never pass',async()=>{
 const c=new TutorLocalChecker('/nonexistent/nodu-tutor');assert.equal((await c.inspect(buffer)).syntax,'unavailable');assert.equal((await c.inspect({...buffer,path:'main.cpp'})).syntax,'unavailable');
});
test('wrong digest, excessive output and invalid rules cannot become evidence',async t=>{
 const c=await fake(t,'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({schema:1,sourceDigest:"wrong",syntax:"valid",errorLines:[],findings:[]})));');
 assert.equal((await c.inspect(buffer)).syntax,'unavailable');
 const flood=await fake(t,'console.log("x".repeat(33000));');assert.equal((await flood.inspect(buffer)).syntax,'unavailable');
 for (const rule of [{id:'a',kind:'calls',function:'main',callee:'receive();system()'}, {id:'a',kind:'calls',function:undefined,callee:'receive'}, {id:'',kind:'calls',function:'main',callee:'receive'}]) {
  assert.equal((await c.inspect(buffer,[rule])).note,'检查请求无效');
 }
});
test('cancel and wall timeout terminate checker work and release capacity',async t=>{
 const c=await fake(t,'process.stdin.resume();setInterval(()=>{},100);');const abort=new AbortController();const p=c.inspect(buffer,[],abort.signal);setTimeout(()=>abort.abort(),30);
 assert.match((await p).note,/取消/);const started=Date.now();assert.match((await c.inspect(buffer)).note,/超时/);assert.ok(Date.now()-started<3000);
});
