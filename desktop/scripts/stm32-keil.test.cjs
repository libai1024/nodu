// SPDX-License-Identifier: MIT
// Exercises the real native CMake/GCC workflow; never opens a probe or flashes hardware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const desktop = path.resolve(__dirname, '..');
const toolkit = process.env.NODU_STM32_TOOLKIT || path.join(desktop, '.tools/stm32', process.platform === 'win32' ? 'win32-x64' : process.platform);
const binary = process.env.NODU_EMBEDDED_BIN || path.join(desktop, 'native/target/debug/nodu-embedded');
const resources = path.join(desktop, 'scope-extension/resources/stm32');
const { generateKeil } = require('../scope-extension/lib/node/nodu-keil-project');

test('native F103 settings, forced configure, Keil update and GCC build coexist', { skip: !fs.existsSync(binary) || !fs.existsSync(path.join(toolkit, 'toolkit.json')), timeout: 90000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-keil-host-')));
    const child = spawn(binary, ['--resources', resources, '--toolkit', toolkit, '--data-dir', path.join(root, 'data')]);
    const pending = new Map(); let sequence = 0;
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
        const m = JSON.parse(line), p = pending.get(m.id); if (!p) return;
        clearTimeout(p.timer); pending.delete(m.id);
        m.error ? p.reject(Object.assign(new Error(m.error), { code: m.code })) : p.resolve(m.result);
    });
    t.after(() => { child.kill(); reader.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const call = (method, args = {}) => new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    });
    const created = await call('createProject', { parent: root, name: 'f103', board: 'chip-f103c8', template: 'uart-hello' });
    let project = await call('openProject', { path: created.path });
    assert.notEqual(project.manifest.keil?.autoSync, true);
    project = await call('setProjectOptions', { path: project.path, options: { keilAutoSync: true } });
    assert.equal(project.manifest.keil.autoSync, true);
    let config = await call('configure', { path: project.path, force: true }); assert(config.ok);
    let result = await generateKeil(project, config.compileCommands, resources); assert(result.created);
    await call('createModule', { path: project.path, name: 'sensor' });
    config = await call('configure', { path: project.path, force: true }); assert(config.ok && config.ran);
    await generateKeil(project, config.compileCommands, resources);
    assert(fs.readFileSync(result.path, 'utf8').includes('..\\App\\sensor.c'));
    assert.equal((await call('build', { path: project.path })).ok, true);
    assert.equal((await call('openProject', { path: project.path })).buildStale, false);
    fs.mkdirSync(path.join(project.path, 'MDK-ARM/Objects'), { recursive: true });
    fs.writeFileSync(path.join(project.path, 'MDK-ARM/Objects/firmware.hex'), 'Keil build output');
    assert.equal((await call('openProject', { path: project.path })).buildStale, false);
    project = await call('setProjectOptions', { path: project.path, options: { preset: 'release', printfFloat: true, keilAutoSync: false } });
    config = await call('configure', { path: project.path, force: true }); assert(config.ok);
    await generateKeil(project, config.compileCommands, resources);
    assert(fs.readFileSync(result.path, 'utf8').includes('<Optim>4</Optim>'));
    assert.equal((await call('build', { path: project.path })).ok, true);
    const f407 = await call('createProject', { parent: root, name: 'f407', board: 'chip-f407zg', template: 'empty' });
    assert.equal((await call('setProjectOptions', { path: f407.path, options: { keilAutoSync: true } })).manifest.keil.autoSync, true);
    const f4config = await call('configure', { path: f407.path, force: true }); assert(f4config.ok);
    await generateKeil(await call('openProject', { path: f407.path }), f4config.compileCommands, resources);
    assert.equal((await call('build', { path: f407.path })).ok, true);
});

// Tests the production Nodu facade, not just the raw GCC backend.
test('Nodu build rejects GCC-only headers before building and invalidates the old artifact', {skip:!fs.existsSync(binary)||!fs.existsSync(path.join(toolkit,'toolkit.json')),timeout:90000},async t=>{
 const {NoduEmbeddedServer}=require('../scope-extension/lib/node/nodu-embedded-server');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nodu-keil-contract-')));
 const child=spawn(binary,['--resources',resources,'--toolkit',toolkit,'--data-dir',path.join(root,'data')]);
 const pending=new Map();let sequence=0,gccBuilds=0;
 const reader=readline.createInterface({input:child.stdout});reader.on('line',line=>{const m=JSON.parse(line),q=pending.get(m.id);if(!q)return;clearTimeout(q.timer);pending.delete(m.id);m.error?q.reject(Object.assign(new Error(m.error),{code:m.code})):q.resolve(m.result);});
 t.after(()=>{child.kill();reader.close();for(const q of pending.values())clearTimeout(q.timer);fs.rmSync(root,{recursive:true,force:true});});
 const request=(method,args={})=>new Promise((resolve,reject)=>{if(method==='build')gccBuilds++;const id=++sequence,timer=setTimeout(()=>reject(Error('timeout '+method)),60000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,args})+'\n');});
 const server=new NoduEmbeddedServer();server.request=request;server.extensionDir=()=>path.join(desktop,'scope-extension');
 const project=await request('createProject',{parent:root,name:'portable',board:'chip-f103c8',template:'uart-hello'});
 const first=await server.call('build',{path:project.path});assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.result.ok,true);assert.equal(first.result.keil.compatibility,'passed');
 const source=path.join(project.path,'App/compatibility_probe.c');fs.writeFileSync(source,'#include <memory.h>\nvoid probe(void){}\n');
 // Prove the counterexample is accepted by the real GCC compiler.
 assert.equal((await request('build',{path:project.path})).ok,true);const before=gccBuilds;
 const refused=await server.call('build',{path:project.path});assert.equal(refused.ok,false);assert.equal(refused.error.code,'keilSource');assert.equal(gccBuilds,before);
 assert.equal((await request('openProject',{path:project.path})).currentBuild,null);
 fs.writeFileSync(source,'#include <string.h>\nvoid probe(void){}\n');const fixed=await server.call('build',{path:project.path});assert.equal(fixed.ok,true,JSON.stringify(fixed));assert.equal(fixed.result.ok,true);
 const checked=await request('configure',{path:project.path,invalidateCurrent:true});
 fs.appendFileSync(source,'/* edited after compatibility validation */\n');
 await assert.rejects(request('build',{path:project.path,expectedInputDigest:checked.inputDigest}),{code:'keilInputsChanged'});
 assert.equal((await request('openProject',{path:project.path})).currentBuild,null);
});
