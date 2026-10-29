// SPDX-License-Identifier: MIT
// Opt-in REAL service/RPC lifecycle integration; never opens a hardware port.
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { createHash } = require('node:crypto'), { spawn } = require('node:child_process');
require('reflect-metadata');
const { NoduArduinoServer, arduinoConnection } = require('../lib/node/nodu-arduino-server');
const { createSourceProject, parseProjectRequest } = require('../lib/node/nodu-project-generator');
const { ARDUINO_SIMULATION_PROFILES } = require('../lib/common/nodu-arduino-simulation-profiles');
const { discoverArduinoSimulationDependencies } = require('../lib/node/nodu-arduino-simulation-package');
const sha = b => createHash('sha256').update(b).digest('hex');
const root = process.env.NODU_SIM_SERVICE_EVIDENCE_DIR, cli = process.env.NODU_ARDUINO_CLI || '/opt/homebrew/bin/arduino-cli';
const studio = process.env.NODU_SIM_STUDIO_ROOT || '/Users/wangwei/Project/FC/STM32_Study_Studio';
const report = { started: new Date().toISOString(), scope: 'Actual Nodu service and arduinoConnection RPC lifecycle; not desktop or simulation acceptance', cases: [], builds: [], commands: [] };
let server, connection; const contexts = [], events = []; let outputHook;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function waitForStage(promise) { let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Expected service stage was not reached')),60_000);})]);}finally{clearTimeout(timer);} }
async function command(executable, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
        for (const stream of [child.stdout, child.stderr]) { stream.on('data', b => { output += b; }); }
        child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
}
async function save() { await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
async function check(name, task) {
    try { await task(); report.cases.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
    catch (error) { report.cases.push({ name, status: 'FAIL', error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
    await save();
}
async function absent(file) { assert.equal(await fs.stat(file).catch(() => undefined), undefined); }
class RealService extends NoduArduinoServer {
    directory() { return path.join(root, 'home'); }
    binary() { return cli; }
    async run(...args) {
        const index = report.commands.length, [,request,parameters,cwd,config] = args;
        const record = { operation: request.operationId, args: parameters, cwd, config, log: `command-${index}.log` }; report.commands.push(record);
        const result = await super.run(...args); record.code = result.code;
        await fs.writeFile(path.join(root, record.log), result.output); return result;
    }
}
async function main() {
    assert.ok(path.isAbsolute(root), 'Evidence path must be absolute'); await fs.mkdir(root, { recursive: true });
    await absent(path.join(root, 'result.json')); await fs.mkdir(path.join(root, 'home'));
    const seed = process.env.NODU_SIM_SEED_HOME; assert.ok(seed, 'Supply a read-only seed; never a live user home as output');
    for (const name of ['data', 'downloads', 'user']) {
        const cloned = await command('/bin/cp', ['-cR', path.join(seed, name), path.join(root, 'home', name)], root); assert.equal(cloned.code, 0, cloned.output);
    }
    report.sources = [];
    for (const file of ['node/nodu-arduino-server','node/nodu-arduino-simulation-package','common/nodu-arduino-protocol','common/nodu-arduino-simulation-profiles']) {
        for (const [folder,ext] of [['src','ts'],['lib','js']]) {
            const p = path.resolve(__dirname,'..',folder,file+'.'+ext);report.sources.push({path:p,sha256:sha(await fs.readFile(p))});
        }
    }
    server = new RealService(); connection = arduinoConnection(server, { onArduinoOutput: event => { events.push(event); outputHook?.(event); } });
    for (const chip of ['esp32c3','esp32s3']) {
        const name = 'service_' + chip, project = await createSourceProject(parseProjectRequest({ parent: root, name, chip, framework: 'arduino', template: 'hello' }));
        const source = path.join(project.path, name+'.ino');
        await check(chip + ': incompatible configuration fails with an action and never changes board parameters', async () => {
            const profile = await fs.readFile(path.join(project.path,'sketch.yaml'));
            const result = await connection.service.compile({path:project.path,operationId:'incompatible-'+chip,simulation:true});
            assert.equal(result.ok,false);assert.match(result.error,/开发板设置/);assert.equal(result.buildToken,undefined);
            assert.deepEqual(await fs.readFile(path.join(project.path,'sketch.yaml')),profile);
        });
        const preset = ARDUINO_SIMULATION_PROFILES[chip];
        await connection.service.configure({path:project.path,fqbn:preset.fqbn,options:{...preset.options}});
        console.log(chip+': real RPC compile with pre-build snapshot');
        const built = await connection.service.compile({path:project.path,operationId:'compile-'+chip,simulation:true,
            dependencies:[{path:'/must-not-read-client-input',name:'forged'}]});
        assert.equal(built.ok,true,JSON.stringify(built));assert.equal(built.simulationReady,true);assert.ok(built.buildToken);
        const internal = server.builds.get(built.buildToken);assert.ok(internal.simulation?.snapshot);
        const destination = path.join(root,chip+'.esp-sim.zip');
        const request = {path:project.path,buildToken:built.buildToken,destination,operationId:'export-'+chip,dependencies:[{name:'forged',sha256:'0'.repeat(64)}]};
        const context = {chip,name,project,source,built,request};contexts.push(context);
        await check(chip+': actual connection exports only its successful service build and Studio accepts the package',async()=>{
            const result = await connection.service.exportSimulation(request);assert.equal(result.ok,true,JSON.stringify(result));
            const validation = await command('python3',['-c','import json,sys,zipfile;from pathlib import Path;from studio.esp_firmware import validate_package;p=Path(sys.argv[1]);v=validate_package(p.read_bytes(),sys.argv[2]);lock=json.loads(v["files"][v["manifest"]["dependencies"]["lockPath"]]);assert all(x["name"]!="forged" for x in lock["packages"]);print(json.dumps({"packageSHA256":v["packageSHA256"],"validation":v["validation"],"dependencyCount":len(lock["packages"])}))',destination,chip],studio);
            await fs.writeFile(path.join(root,chip+'-studio.log'),validation.output);assert.equal(validation.code,0,validation.output);
            context.export=result;report.builds.push({chip,compile:built,snapshot:internal.simulation.snapshot,export:result,consumer:JSON.parse(validation.output)});
        });
        assert.ok(context.export, 'Positive export failed; preserve evidence and stop dependent negative tests');
        await check(chip+': changed source rejects with no new file and leaves original export intact',async()=>{
            const before=await fs.readFile(source),out=path.join(root,chip+'-changed.esp-sim.zip');
            try {await fs.appendFile(source,'\n// changed\n');const result=await connection.service.exportSimulation({...request,operationId:'source-'+chip,destination:out});assert.equal(result.ok,false);assert.match(result.error,/改变/);await absent(out);}
            finally{await fs.writeFile(source,before);}
            assert.equal(sha(await fs.readFile(destination)),context.export.packageSha256);
        });
        await check(chip+': build artifact deletion rejects without publishing',async()=>{
            const file=path.join(built.buildPath,name+'.ino.partitions.bin'),before=await fs.readFile(file),out=path.join(root,chip+'-incomplete.esp-sim.zip');
            try{await fs.unlink(file);const result=await connection.service.exportSimulation({...request,operationId:'incomplete-'+chip,destination:out});assert.equal(result.ok,false);await absent(out);}finally{await fs.writeFile(file,before);}
        });
        await check(chip+': changed installed library content rejects despite unchanged source/token',async()=>{
            const deps=await discoverArduinoSimulationDependencies(path.join(root,'home'),project.path,cli),lib=deps.find(x=>x.provider==='library'),file=path.join(lib.path,'library.properties'),before=await fs.readFile(file),out=path.join(root,chip+'-dependency.esp-sim.zip');
            try{await fs.appendFile(file,'\n# changed\n');const result=await connection.service.exportSimulation({...request,operationId:'dependency-'+chip,destination:out});assert.equal(result.ok,false);assert.match(result.error,/依赖内容已修改/);await absent(out);}finally{await fs.writeFile(file,before);}
        });
        await check(chip+': cancelling export through the owning connection produces no file',async()=>{
            const ready=deferred(),out=path.join(root,chip+'-cancelled.esp-sim.zip');
            outputHook=event=>{if(event.operationId==='cancel-'+chip&&event.phase==='packaging')ready.resolve();};
            const pending=connection.service.exportSimulation({...request,operationId:'cancel-'+chip,destination:out});await waitForStage(ready.promise);
            await connection.service.cancel('cancel-'+chip);const result=await pending;outputHook=undefined;assert.equal(result.ok,false);assert.equal(result.cancelled,true);await absent(out);
        });
        await check(chip+': source-directory export rejects to prevent the package becoming a build input',async()=>{
            const out=path.join(project.path,'new.esp-sim.zip'),result=await connection.service.exportSimulation({...request,operationId:'destination-'+chip,destination:out});
            assert.equal(result.ok,false);assert.match(result.error,/工程目录外/);await absent(out);
        });
    }
    const [c3,s3]=contexts;
    await check('mixed C3 ELF in a successful S3 build is rejected through RPC',async()=>{
        const file=path.join(s3.built.buildPath,s3.name+'.ino.elf'),before=await fs.readFile(file),out=path.join(root,'mixed.esp-sim.zip');
        try{await fs.copyFile(path.join(c3.built.buildPath,c3.name+'.ino.elf'),file);const result=await connection.service.exportSimulation({...s3.request,operationId:'mixed',destination:out});assert.equal(result.ok,false);await absent(out);}finally{await fs.writeFile(file,before);}
    });
    await check('connection disposal cancels an in-flight export without affecting another connection',async()=>{
        const ready=deferred(),out=path.join(root,'disconnected.esp-sim.zip');
        const owner=arduinoConnection(server,{onArduinoOutput:event=>{if(event.phase==='packaging')ready.resolve();}});
        const pending=owner.service.exportSimulation({...c3.request,operationId:'disconnect',destination:out});await waitForStage(ready.promise);owner.dispose();
        const result=await pending;assert.equal(result.ok,false);assert.equal(result.cancelled,true);await absent(out);
        assert.ok((await connection.service.boardOptions(c3.project.path)).length);
    });
    await check('a new failed real compile revokes the old successful token and retains historical package bytes',async()=>{
        const before=await fs.readFile(c3.source),out=path.join(root,'after-failed.esp-sim.zip');
        try{await fs.appendFile(c3.source,'\n#error NODU_EXPECTED_NEGATIVE_BUILD\n');const failed=await connection.service.compile({path:c3.project.path,operationId:'failed-compile',simulation:true});assert.equal(failed.ok,false);assert.equal(failed.buildToken,undefined);}
        finally{await fs.writeFile(c3.source,before);}
        const result=await connection.service.exportSimulation({...c3.request,operationId:'failed-export',destination:out});assert.equal(result.ok,false);await absent(out);
        assert.equal(sha(await fs.readFile(c3.request.destination)),c3.export.packageSha256);
    });
    report.status=report.cases.every(c=>c.status==='PASS')?'PASS':'FAIL';if(report.status!=='PASS')process.exitCode=1;
}
if (!root) require('node:test').test('real simulation service integration', { skip: 'Set NODU_SIM_SERVICE_EVIDENCE_DIR and NODU_SIM_SEED_HOME' }, () => {});
else main().catch(error=>{report.status='FAIL';report.error=error.stack;console.error(error);process.exitCode=1;})
    .finally(async()=>{connection?.dispose();server?.onStop();report.finished=new Date().toISOString();await fs.writeFile(path.join(root,'events.json'),JSON.stringify(events,null,2)+'\n');await save();});
