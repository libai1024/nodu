const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=process.env.NODU_ACCEPTANCE_ROOT,libs=JSON.parse(fs.readFileSync(path.join(root,'app/scope-extension/resources/arduino/libraries/manifest.json'))).libraries;
// Nodu's runtime index includes the pinned bundled versions absent from the older upstream snapshot.
fs.copyFileSync(path.join(root,'arduino-home/data/library_index.json'),path.join(root,'ide-data/library_index.json'));
fs.rmSync(path.join(root,'ide-data/library_index.json.sig'),{force:true});
const sketch=path.join(root,'projects with spaces/nodu_esp32c3/nodu_esp32c3.ino');
fs.copyFileSync(sketch,path.join(root,'evidence/c3-network-install-failed.ino.txt'));
fs.writeFileSync(sketch,fs.readFileSync(sketch,'utf8').replace('#include <PubSubClient.h>\n','').replace(' PubSubClient extraMqtt(wifi);',''));
const args=['--config-file',path.join(root,'ide-profile/.arduinoIDE/arduino-cli.yaml'),'lib','install','--no-deps',...libs.map(l=>l.name+'@'+l.version)];
const out=fs.createWriteStream(path.join(root,'evidence/ide-fixed-libraries.log'));
const p=spawn(path.join(root,'tools/arduino-cli-1.3.1.exe'),args,{windowsHide:true});p.stdout.pipe(out,{end:false});p.stderr.pipe(out,{end:false});p.on('exit',code=>{out.end();fs.writeFileSync(path.join(root,'evidence/ide-fixed-libraries.json'),JSON.stringify({code,args,note:'Explicitly prepared exact pinned library closure; no-deps avoids fetching other versions.'},null,2));process.exitCode=code;});
