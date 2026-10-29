// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {arduinoEnvironmentIdentity,hasArduinoEnvironmentReceipt,rememberArduinoEnvironment}=require('../lib/node/nodu-arduino-environment-cache');
async function fixture(t){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'nodu-environment-cache-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const core=path.join(home,'data/internal/core'),compiler=path.join(home,'data/internal/tool/bin/compiler'+(process.platform==='win32'?'.exe':''));
 await fs.mkdir(core,{recursive:true});await fs.mkdir(path.dirname(compiler),{recursive:true});
 await fs.writeFile(path.join(core,'boards.txt'),'core');await fs.writeFile(compiler,'compiler',{mode:0o755});
 const input=path.join(home,'bundle.json');await fs.writeFile(input,'bundle1');
 const identity=await arduinoEnvironmentIdentity(home,[input]),database=[{arguments:[compiler,'-c','test.cpp']}];
 return {home,core,compiler,input,identity,database};
}
test('a verified bootstrap survives process restarts while changed bundle inputs invalidate it',async t=>{
 const f=await fixture(t);assert.equal(await hasArduinoEnvironmentReceipt(f.home,f.identity),false);
 await rememberArduinoEnvironment(f.home,f.identity,f.database);assert.equal(await hasArduinoEnvironmentReceipt(f.home,f.identity),true);
 await fs.writeFile(f.input,'bundle2');const next=await arduinoEnvironmentIdentity(f.home,[f.input]);assert.notEqual(next,f.identity);
 assert.equal(await hasArduinoEnvironmentReceipt(f.home,next),false);
});
test('missing or changed compiler and core metadata cannot reuse a ready receipt',async t=>{
 const f=await fixture(t);await rememberArduinoEnvironment(f.home,f.identity,f.database);
 await fs.writeFile(f.compiler,'changed compiler');assert.equal(await hasArduinoEnvironmentReceipt(f.home,f.identity),false);
 await rememberArduinoEnvironment(f.home,f.identity,f.database);await fs.rm(f.compiler);assert.equal(await hasArduinoEnvironmentReceipt(f.home,f.identity),false);
});
test('an empty or outside-home compiler database never declares the environment ready',async t=>{
 const f=await fixture(t);for(const database of [[],[{arguments:['/outside/compiler']}],[{command:'compiler file.cpp'}]]){
  await rememberArduinoEnvironment(f.home,f.identity,database);assert.equal(await hasArduinoEnvironmentReceipt(f.home,f.identity),false);
 }
});
