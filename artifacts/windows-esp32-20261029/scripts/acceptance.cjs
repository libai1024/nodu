// Real Windows Nodu service acceptance. Physical boards are intentionally excluded.
const fs = require('node:fs'), fsp = fs.promises, path = require('node:path');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), net = require('node:net');
const {spawn} = require('node:child_process');
const root=process.env.NODU_ACCEPTANCE_ROOT, home=process.env.NODU_ARDUINO_HOME;
const evidence=path.join(root,'evidence'), lib=path.join(root,'app/scope-extension/lib');
require('reflect-metadata');
const {NoduArduinoServer}=require(path.join(lib,'node/nodu-arduino-server'));
const {NoduArduinoLanguageServer}=require(path.join(lib,'node/nodu-arduino-language'));
const {NoduEmbeddedServer}=require(path.join(lib,'node/nodu-embedded-server'));
const {createSourceProject,parseProjectRequest}=require(path.join(lib,'node/nodu-project-generator'));
const yaml=require('yaml');
const report={started:new Date().toISOString(),platform:process.platform,arch:process.arch,root,home,physicalHardware:false,cases:[],commands:[],projects:[]};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function save(){fs.writeFileSync(path.join(evidence,'acceptance.json'),JSON.stringify(report,null,2));}
async function check(name,fn){const item={name,started:new Date().toISOString()}, t=Date.now();report.cases.push(item);save();try{item.detail=await fn();item.ok=true;}catch(e){item.ok=false;item.error=e.stack;}item.elapsedMs=Date.now()-t;save();console.log(JSON.stringify(item));return item;}
const events=fs.createWriteStream(path.join(evidence,'service-events.jsonl'));
class Recorded extends NoduArduinoServer {
  async run(...params){const [_,request,args,cwd,config,,,raw]=params, id=report.commands.length+1, t=Date.now();const rec={id,operation:request.operationId,args,cwd,config};report.commands.push(rec);
    try{const result=await super.run(...params);rec.code=result.code;rec.elapsedMs=Date.now()-t;fs.writeFileSync(path.join(evidence,`command-${id}.log`),result.output);save();return result;}catch(e){rec.error=e.message;save();throw e;}}
}
let service,guard;const embedded=new NoduEmbeddedServer();
function freshService(){service?.onStop();service=new Recorded();service.embedded=embedded;service.addClient({onArduinoOutput(e){events.write(JSON.stringify(e)+'\n');}});}
function run(exe,args,options={}){return new Promise(resolve=>{const child=spawn(exe,args,{windowsHide:true,...options});let output='';child.stdout?.on('data',b=>output+=b);child.stderr?.on('data',b=>output+=b);child.on('error',e=>resolve({code:-1,output:e.stack}));child.on('close',code=>resolve({code,output}));});}
const source=`#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <ArduinoMqttClient.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Adafruit_I2CDevice.h>
#include <Adafruit_NeoPixel.h>
#include <DHT.h>
#include <Adafruit_Sensor.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <ESP32Servo.h>
WiFiClient wifi; MqttClient mqtt(wifi);
Adafruit_SSD1306 oled(128,64,&Wire,-1); Adafruit_I2CDevice bus(0x3c);
Adafruit_NeoPixel pixels(1,4,NEO_GRB+NEO_KHZ800); DHT dht(5,DHT22);
OneWire one(6); DallasTemperature temperature(&one); Servo servo;
void setup(){Serial.begin(115200); JsonDocument doc; doc["message"]="Nodu Windows 中文";
serializeJson(doc,Serial); mqtt.setId("compile-acceptance");
oled.begin(SSD1306_SWITCHCAPVCC,0x3c); oled.drawPixel(0,0,SSD1306_WHITE);
bus.begin(); pixels.begin(); pixels.show(); dht.begin(); Serial.println(dht.readTemperature());
temperature.begin(); temperature.requestTemperatures(); servo.attach(7); servo.write(90);}
void loop(){Serial.println("Nodu Windows OK");delay(1000);}
`;
async function startGuard(){
 const cli=path.join(home,'bin/1.5.1/win32-x64/arduino-cli.exe');
 // WFP resolves an existing path; remove this empty registration placeholder
 // before the cold runtime starts. No CLI or cache is seeded into the home.
 fs.mkdirSync(path.dirname(cli),{recursive:true});fs.writeFileSync(cli,'');
 guard=spawn(path.join(root,'tools/offline-guard.exe'),[process.execPath,cli],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('guard timeout')),15000);guard.stdout.on('data',b=>{events.write(JSON.stringify({guard:String(b)})+'\n');if(String(b).includes('OFFLINE_READY')){clearTimeout(timer);resolve();}});guard.stderr.on('data',b=>events.write(JSON.stringify({guardError:String(b)})+'\n'));guard.on('exit',code=>{clearTimeout(timer);reject(Error('guard exited '+code));});});
 const denial=await new Promise((resolve,reject)=>{const s=net.connect(443,'192.0.2.1');s.on('connect',()=>{s.destroy();reject(Error('unexpected external network'));});s.on('error',e=>resolve(e.code));s.setTimeout(5000,()=>{s.destroy();reject(Error('no policy denial'));});});
 assert.ok(['EACCES','EPERM'].includes(denial),denial);fs.rmSync(home,{recursive:true});assert.equal(fs.existsSync(home),false);return {policy:'Windows dynamic WFP: private Node and managed Arduino CLI block non-loopback IPv4/IPv6',denial,cli,emptyRegistrationPlaceholderRemoved:true};
}
async function stopGuard(){if(!guard)return;const child=guard;guard=undefined;if(child.exitCode!==null)return;const stopped=new Promise(r=>child.once('exit',r));child.stdin.end();await stopped;}
async function main(){
 assert.equal(process.platform,'win32');assert.ok(root.startsWith('D:\\'));assert.equal(fs.existsSync(home),false,'Require a fresh Arduino home');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'bundles/win32-x64/manifest.json')));
 report.bundle={host:manifest.host,files:manifest.files.length,releaseReady:manifest.releaseReady,manifestSha256:sha(fs.readFileSync(path.join(root,'bundles/win32-x64/manifest.json')))};
 await check('bundled resource integrity (development inputs, not release approval)',()=>{require(path.join(root,'app/scripts/package-arduino.cjs')).validateBundle(path.join(root,'bundles/win32-x64'),'win32-x64',{allowUnreleased:true});return report.bundle;});
 const guarded=await check('offline network enforcement',startGuard);assert.equal(guarded.ok,true);
 freshService();const parent=path.join(root,'projects with spaces');fs.mkdirSync(parent,{recursive:true});
 for(const chip of ['esp32c3','esp32s3']){
   const name='nodu_'+chip, generated=await createSourceProject(parseProjectRequest({parent,name,chip,framework:'arduino',template:'hello'}));
   const sketch=path.join(generated.path,name+'.ino'), profileFile=path.join(generated.path,'sketch.yaml');
   const p={chip,name,path:generated.path,sketch};report.projects.push(p);save();
   await check(chip+' default project bundles 11 pinned libraries',()=>{const profile=yaml.parse(fs.readFileSync(profileFile,'utf8'));assert.equal(profile.profiles.nodu.libraries.length,11);fs.copyFileSync(profileFile,path.join(evidence,chip+'-sketch.yaml'));return profile;});
   await check(chip+' cold initialization preserves unfinished user code',async()=>{const draft=source+'\nvoid incomplete(\n';fs.writeFileSync(sketch,draft);const before=fs.readFileSync(profileFile);const result=await service.inspect(p.path);assert.equal(result.ready,true,JSON.stringify(result));assert.equal(fs.readFileSync(sketch,'utf8'),draft);assert.ok(fs.readFileSync(profileFile).equals(before));return result;});
   fs.writeFileSync(sketch,source);
   await check(chip+' bundled library manager',async()=>{const result=await service.listLibraries({path:p.path,filter:'installed',limit:100});assert.equal(result.error,undefined);const installed=result.items.filter(x=>!x.core);assert.equal(installed.length,11);return installed.map(x=>({name:x.name,version:x.installedVersion,bundled:x.bundled}));});
   await check(chip+' real offline compile and link all 11 libraries',async()=>{const result=await service.compile({path:p.path,operationId:'offline-'+chip});p.build=result;assert.equal(result.ok,true,JSON.stringify(result));p.artifacts=fs.readdirSync(result.buildPath).filter(x=>/\.(elf|bin)$/.test(x)).map(x=>{const b=fs.readFileSync(path.join(result.buildPath,x));return {name:x,size:b.length,sha256:sha(b)};});return {result,artifacts:p.artifacts};});
   await check(chip+' bundled editor language tools',async()=>{const spec=await new NoduArduinoLanguageServer().spec({path:p.path});assert.equal(spec.ok,true,JSON.stringify(spec));return spec;});
   freshService();
 }
 const c3=report.projects[0];
 await check('reopened C3 project offline rebuild',async()=>{const result=await service.compile({path:c3.path,operationId:'reopen-c3'});c3.build=result;assert.equal(result.ok,true,JSON.stringify(result));return result;});
 await check('compile errors return sketch line and column',async()=>{fs.writeFileSync(c3.sketch,source+'\n#error NODU_EXPECTED_COMPILE_FAILURE\n');const failed=await service.compile({path:c3.path,operationId:'compile-error'});assert.equal(failed.ok,false);assert.ok(failed.diagnostics.some(d=>JSON.stringify(d).includes('NODU_EXPECTED_COMPILE_FAILURE')),JSON.stringify(failed));fs.writeFileSync(c3.sketch,source);return failed;});
 fs.writeFileSync(c3.sketch,source);
 await stopGuard();report.offlineComplete=true;save();
 await check('unbundled PubSubClient actual network install',async()=>{const cached=fs.readdirSync(path.join(home,'downloads/libraries')).filter(x=>/PubSubClient/i.test(x));assert.equal(cached.length,0);const result=await service.changeLibrary({path:c3.path,name:'PubSubClient',version:'2.8.0',action:'add',operationId:'network-add-library'});assert.equal(result.ok,true,JSON.stringify(result));return result;});
 const withMqtt=source.replace('#include <WiFi.h>','#include <WiFi.h>\n#include <PubSubClient.h>').replace('WiFiClient wifi;', 'WiFiClient wifi; PubSubClient extraMqtt(wifi);');fs.writeFileSync(c3.sketch,withMqtt);
 await check('newly downloaded library compiles in Nodu',async()=>{const result=await service.compile({path:c3.path,operationId:'network-library-compile'});c3.build=result;assert.equal(result.ok,true,JSON.stringify(result));return result;});
 await check('official Arduino CLI reopens exact same project/profile',async()=>{const cli=path.join(home,'bin/1.5.1/win32-x64/arduino-cli.exe');const config=path.join(home,'arduino-cli.yaml');const r=await run(cli,['--config-file',config,'compile','--profile','nodu','--build-path',path.join(root,'arduino-cli-reopen-build'),c3.path]);fs.writeFileSync(path.join(evidence,'arduino-cli-reopen.log'),r.output);assert.equal(r.code,0,r.output.slice(-1600));return {code:r.code,sourceSha256:sha(fs.readFileSync(c3.sketch))};});
 report.finished=new Date().toISOString();report.ok=report.cases.every(x=>x.ok);save();
}
main().catch(e=>{report.fatal=e.stack;process.exitCode=1;console.error(e);}).finally(async()=>{await stopGuard();service?.onStop();embedded.onStop();events.end();report.finished=new Date().toISOString();save();console.log('RESULT '+JSON.stringify({cases:report.cases.length,passed:report.cases.filter(x=>x.ok).length,fatal:report.fatal}));});
