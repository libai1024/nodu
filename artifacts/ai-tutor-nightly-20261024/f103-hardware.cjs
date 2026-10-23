// SPDX-License-Identifier: MIT
const {spawn}=require('node:child_process'),readline=require('node:readline'),fs=require('node:fs/promises');
const repo=require('node:path').resolve(__dirname,'../..'),project=repo+'/artifacts/ai-tutor-nightly-20261024/projects/f103-tutor';
const dataDir='/Users/wangwei/.codex/nodu-nightly-20261024/hardware-'+Date.now();
const child=spawn(repo+'/desktop/scope-extension/resources/bin/darwin-arm64/nodu-embedded',['--resources',repo+'/desktop/scope-extension/resources/stm32','--toolkit','/Users/wangwei/Model/k210-studio/desktop/.tools/stm32/darwin','--data-dir',dataDir],{stdio:['pipe','pipe','pipe']});
const pending=new Map(),events=[];let seq=0;
readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.event){events.push({...m,receivedAt:Date.now()});return;}const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.code+': '+m.error)):p.resolve(m.result);}});
const call=(method,args={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,timer:setTimeout(()=>reject(Error('timeout '+method)),60000)});child.stdin.write(JSON.stringify({id,method,args:{path:project,...args}})+'\n');});
(async()=>{
 const report={project,dataDir,startedAt:new Date().toISOString()};
 try{
 report.identity=await call('identify',{probe:'usb:3-1.2.1'});
 if(report.identity.deviceId!==1040||report.identity.flashKiB!==64||report.identity.uid!=='0671ff373634574e431e5512'||report.identity.matches!==null)throw Error('target mismatch');
 if(report.identity.hasBackup)throw Error('fresh backup directory required');
 await call('trustProject');
 report.monitor=await call('openMonitor',{port:'/dev/cu.usbserial-31230',baud:115200});
 report.flash=await call('flash',{method:'stlink',probe:'usb:3-1.2.1'});report.flashFinishedAt=Date.now();
 if(!report.flash.ok||report.flash.backup.bytes!==65536)throw Error('flash or full backup failed');
 await new Promise(resolve=>setTimeout(resolve,4500));
 report.serialEvents=events.filter(e=>e.event==='monitor.data'&&e.receivedAt>report.flashFinishedAt);
 report.events=events.filter(e=>!['flash.output','monitor.data'].includes(e.event));
 report.complete=true;
 }catch(e){report.error=e.message;process.exitCode=1;}
 finally{
 await call('closeMonitor').catch(()=>{});child.stdin.end();
 await fs.writeFile(repo+'/docs/ai-tutor/evidence/nightly-20261024-f103-hardware.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({complete:report.complete,error:report.error,running:report.flash?.running,backup:report.flash?.backup,serialEvents:report.serialEvents?.length}));
 }
})();
