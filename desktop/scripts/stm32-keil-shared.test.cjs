// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const desktop=path.resolve(__dirname,'..');
const binary=process.env.NODU_EMBEDDED_BIN||path.join(desktop,'native/target/debug/nodu-embedded');
const toolkit=process.env.NODU_STM32_TOOLKIT||path.join(desktop,'.tools/stm32',process.platform==='win32'?'win32-x64':process.platform);
test('HAL72 shared builds honor the Keil gate, invalidate prior snapshots and cancel safely',{skip:!fs.existsSync(binary)||!fs.existsSync(path.join(toolkit,'toolkit.json')),timeout:90000},async t=>{
 const {NoduEmbeddedServer}=require('../scope-extension/lib/node/nodu-embedded-server');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nodu-keil-linked-')));
 const previous=process.env.NODU_DACIR_HOME;process.env.NODU_DACIR_HOME=path.join(root,'shared');
 let heartbeat;
 const server=new NoduEmbeddedServer();server.binary=()=>binary;server.toolkitRoot=()=>toolkit;server.dataDir=()=>path.join(root,'native-data');
 t.after(()=>{clearInterval(heartbeat);server.onStop();if(previous===undefined)delete process.env.NODU_DACIR_HOME;else process.env.NODU_DACIR_HOME=previous;fs.rmSync(root,{recursive:true,force:true});});
 const created=await server.call('createWorkspace',{parent:root,name:'hal72',chip:'STM32F103C8Tx',template:'linked-hal72'});assert.equal(created.ok,true,JSON.stringify(created));const project=created.result.path;
 const pulse=()=>server.call('editorPulse',{path:project,clientId:'keil-contract-test',generation:1,dirty:[]});await pulse();heartbeat=setInterval(()=>void pulse().catch(()=>{}),500);
 const good=await server.call('build',{path:project});assert.equal(good.ok,true,JSON.stringify(good));assert.equal(good.result.ok,true,JSON.stringify(good));assert(good.result.snapshotPath);
 const probe=path.join(project,'App/compatibility_probe.c');fs.writeFileSync(probe,'#include <memory.h>\nvoid probe(void){}\n');
 const bad=await server.call('build',{path:project});assert.equal(bad.ok,false);assert.equal(bad.error.code,'keilSource');
 const state=await server.call('openProject',{path:project});assert.equal(state.result.currentBuild,null);
 fs.writeFileSync(probe,'#include <string.h>\nvoid probe(void){}\n');
 const fixed=await server.call('build',{path:project});assert.equal(fixed.ok,true,JSON.stringify(fixed));assert.equal(fixed.result.ok,true);
 let stopped;
 server.addClient({onEvent(event){if(event==='build.started'&&!stopped)stopped=server.call('cancel',{queue:'build'});}});
 const cancelled=await server.call('build',{path:project,clean:true});assert.equal(cancelled.ok,false,JSON.stringify(cancelled));assert.equal(cancelled.error.code,'cancelled');assert(stopped);await stopped;
 assert.equal((await server.call('openProject',{path:project})).result.currentBuild,null);
});
