// SPDX-License-Identifier: MIT
const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),readline=require('node:readline'),assert=require('node:assert/strict');
const repo=require('node:path').resolve(__dirname,'../..'),project=repo+'/artifacts/ai-tutor-nightly-20261024/projects/f103-tutor',source=project+'/Core/Src/main.c';
const child=spawn(repo+'/desktop/scope-extension/resources/bin/darwin-arm64/nodu-embedded',['--resources',repo+'/desktop/scope-extension/resources/stm32','--toolkit','/Users/wangwei/Model/k210-studio/desktop/.tools/stm32/darwin','--data-dir','/Users/wangwei/.nodu'],{stdio:['pipe','pipe','pipe']});
let seq=0;const pending=new Map(),events=[];readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.event){events.push(m);return;}const done=pending.get(m.id);pending.delete(m.id);done?.(m);});
const call=(method,args={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);child.stdin.write(JSON.stringify({id,method,args:{path:project,...args}})+'\n');});
(async()=>{const original=await fs.readFile(source,'utf8'),report={project};try{
 report.before=await call('openProject');assert.equal(report.before.result.buildStale,false);
 await fs.writeFile(source,original.replace('HAL_Delay(1000);','HAL_Delay(;'));
 report.modified=await call('openProject');assert.equal(report.modified.result.buildStale,true);
 report.staleDownload=await call('flash',{method:'stlink',probe:'usb:3-1.2.1'});assert.equal(report.staleDownload.code,'staleBuild');
 report.badBuild=await call('build');assert.equal(report.badBuild.result?.ok??false,false);
 report.failedDownload=await call('flash',{method:'stlink',probe:'usb:3-1.2.1'});assert.equal(report.failedDownload.code,'noBuild');
 assert.equal(events.some(e=>e.event==='flash.started'),false);report.noHardwareOperation=true;
 }catch(e){report.error=e.message;process.exitCode=1;}finally{
 await fs.writeFile(source,original);report.restoredBuild=await call('build');report.restoredStatus=await call('openProject');
 assert.equal(report.restoredBuild.result.ok,true);assert.equal(report.restoredStatus.result.buildStale,false);
 child.stdin.end();await fs.writeFile(repo+'/docs/ai-tutor/evidence/nightly-20261024-f103-build-boundaries.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({ok:!report.error,error:report.error,noHardwareOperation:report.noHardwareOperation,restoredBuild:report.restoredBuild.result.ok}));
 }} )();
