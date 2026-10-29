const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const root=process.env.NODU_ACCEPTANCE_ROOT;
const compatible=process.env.NODU_IDE_COMPAT==='1',label=compatible?'arduino-compatible-compile':'arduino-ide-compile';
const report={started:new Date().toISOString(),compiler:'Unmodified Arduino IDE 2.3.7 bundled CLI 1.3.1',setup:'ESP32 Core 3.3.12 and 11 fixed libraries explicitly prepared in separate IDE directories on D:',cases:[]};
function save(){fs.writeFileSync(path.join(root,'evidence',label+'.json'),JSON.stringify(report,null,2));}
async function run(chip){
 const project=path.join(root,compatible?'arduino-compatible':'projects with spaces','nodu_'+chip),sketch=path.join(project,'nodu_'+chip+'.ino'),t=Date.now();
 const record={chip,project,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(sketch)).digest('hex')};report.cases.push(record);save();
 const args=['--config-file',path.join(root,'ide-profile/.arduinoIDE/arduino-cli.yaml'),'compile','--fqbn','esp32:esp32:'+chip,'--build-path',path.join(root,'ide-build-'+chip),'--warnings','default','--no-color',project];record.args=args;
 const log=fs.createWriteStream(path.join(root,'evidence',label+'-'+chip+'.log'));
 const child=spawn(path.join(root,'tools/arduino-cli-1.3.1.exe'),args,{windowsHide:true});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});log.end();
 Object.assign(record,{code,elapsedMs:Date.now()-t,sourceUnchanged:record.sourceSha256===crypto.createHash('sha256').update(fs.readFileSync(sketch)).digest('hex')});save();console.log(JSON.stringify(record));
}
Promise.all(['esp32c3','esp32s3'].map(run)).then(()=>{report.finished=new Date().toISOString();save();}).catch(e=>{report.error=e.stack;save();process.exitCode=1});
