// Prepare an isolated, ordinary Arduino IDE installation using verified archives.
// This is an explicit compatibility-test setup, not an automatic Nodu handoff feature.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=process.env.NODU_ACCEPTANCE_ROOT,bundle=path.join(root,'bundles/win32-x64');
const data=path.join(root,'ide-data'),downloads=path.join(root,'ide-downloads');
const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json')));
const libs=JSON.parse(fs.readFileSync(path.join(root,'app/scope-extension/resources/arduino/libraries/manifest.json'))).libraries;
const report={started:new Date().toISOString(),note:'Separate Arduino IDE 2.3.7 / CLI 1.3.1 environment; explicit dependency setup',commands:[]};
function save(){fs.writeFileSync(path.join(root,'evidence/arduino-ide-setup.json'),JSON.stringify(report,null,2));}
function copy(source,dest){fs.mkdirSync(path.dirname(dest),{recursive:true});if(!fs.existsSync(dest))fs.copyFileSync(source,dest);}
for(const f of manifest.files){if(f.kind==='index')copy(path.join(bundle,f.path),path.join(data,path.basename(f.target)));if(f.kind==='package')copy(path.join(bundle,f.path),path.join(downloads,'packages',path.basename(f.target)));}
for(const l of libs)copy(path.join(root,'app/scope-extension/resources/arduino/libraries',l.archiveFileName),path.join(downloads,'libraries',l.archiveFileName));
const cli=path.join(root,'tools/arduino-cli-1.3.1.exe'),config=path.join(root,'ide-profile/.arduinoIDE/arduino-cli.yaml');
async function run(name,args){const t=Date.now(),record={name,args};report.commands.push(record);save();const out=fs.createWriteStream(path.join(root,'evidence','ide-'+name+'.log'));const p=spawn(cli,['--config-file',config,...args],{windowsHide:true});p.stdout.pipe(out,{end:false});p.stderr.pipe(out,{end:false});const code=await new Promise((r,j)=>{p.on('error',j);p.on('exit',r);});out.end();Object.assign(record,{code,elapsedMs:Date.now()-t});save();console.log(JSON.stringify(record));return code;}
(async()=>{
 await run('core-install',['core','install','esp32:esp32@3.3.12']);
 await run('libraries-install',['lib','install',...libs.map(l=>l.name+'@'+l.version),'PubSubClient@2.8.0']);
 await run('board-list',['core','list','--format','json']);
 report.finished=new Date().toISOString();save();
})().catch(e=>{report.error=e.stack;save();process.exitCode=1;console.error(e);});
