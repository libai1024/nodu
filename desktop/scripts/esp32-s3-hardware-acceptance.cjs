// Explicit opt-in hardware acceptance: writes a serial-only test sketch to one selected S3.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=process.env.NODU_S3_TEST_ROOT,port=process.env.NODU_S3_TEST_PORT;
if(!root||!port||process.env.NODU_S3_ALLOW_FLASH!=='1')throw Error('Set NODU_S3_TEST_ROOT, NODU_S3_TEST_PORT and NODU_S3_ALLOW_FLASH=1 for an authorized test board.');
const extension=process.env.NODU_S3_TEST_EXTENSION||path.join(root,'scope-extension');
const packaged=process.env.NODU_S3_PACKAGED_APP?require('./packaged-arduino-acceptance-loader.cjs')(process.env.NODU_S3_PACKAGED_APP):undefined;
if(!packaged)require('reflect-metadata');
const {NoduArduinoServer}=packaged||require(path.join(extension,'lib/node/nodu-arduino-server'));
const {NoduEmbeddedServer}=packaged||require(path.join(extension,'lib/node/nodu-embedded-server'));
const {createSourceProject,parseProjectRequest}=packaged||require(path.join(extension,'lib/node/nodu-project-generator'));
const embedded=new NoduEmbeddedServer(),server=new NoduArduinoServer();server.embedded=embedded;
const report={started:new Date().toISOString(),port,physicalHardware:true,sketchTouchesOnlySerial:true,rounds:[]};
report.uartRxBufferBytes=16384;
report.runtimeExecutable=process.execPath;
if(packaged)report.productionBackend=packaged.productionBackend;
fs.mkdirSync(path.join(root,'evidence'),{recursive:true});
const events=fs.createWriteStream(path.join(root,'evidence/hardware-events.jsonl'));let serial='';
const decoder=new(require('node:string_decoder').StringDecoder)('utf8');
let guard;
async function startOfflineGuard(){
 const executable=process.env.NODU_S3_OFFLINE_GUARD;if(!executable)return;
 const home=process.env.NODU_ARDUINO_HOME;assert.ok(home,'An isolated Arduino home is required for offline acceptance');
 assert.equal(fs.existsSync(path.join(home,'data')),false,'Offline acceptance requires a cold Arduino environment');
 const cli=path.join(home,'bin/1.5.1/win32-x64/arduino-cli.exe');
 fs.mkdirSync(path.dirname(cli),{recursive:true});fs.writeFileSync(cli,'');
 guard=require('node:child_process').spawn(executable,[process.execPath,cli],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Offline guard startup timed out')),15000);
  guard.stdout.on('data',bytes=>{output+=bytes;if(output.includes('OFFLINE_READY')){clearTimeout(timer);resolve();}});
  guard.once('error',error=>{clearTimeout(timer);reject(error);});guard.once('exit',code=>{clearTimeout(timer);reject(Error('Offline guard exited '+code));});
 });
 fs.rmSync(cli);
 const denied=await new Promise((resolve,reject)=>{const socket=require('node:net').connect(443,'192.0.2.1');socket.on('connect',()=>{socket.destroy();reject(Error('External connection was not blocked'));});socket.on('error',error=>resolve(error.code));socket.setTimeout(5000,()=>{socket.destroy();reject(Error('No network policy denial'));});});
 assert.ok(['EACCES','EPERM'].includes(denied),denied);
 report.offline={coldHome:true,denied,policy:'Dynamic WFP blocks non-loopback IPv4/IPv6 for this runtime executable and the managed Arduino CLI; compiler subprocesses are not independently blocked'};save();
}
embedded.addClient({onEvent(event,data){events.write(JSON.stringify({event,data})+'\n');if(event==='monitor.data')serial+=decoder.write(Buffer.from(data.data,'base64'));}});
server.addClient({onArduinoOutput:event=>events.write(JSON.stringify(event)+'\n')});
function save(){fs.writeFileSync(path.join(root,'evidence/hardware-result.json'),JSON.stringify(report,null,2));}
async function waitFor(text,timeout=20000){const deadline=Date.now()+timeout;while(!serial.includes(text)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));assert.ok(serial.includes(text),'Serial output missing: '+text.slice(0,120)+' ('+text.length+' characters); tail='+serial.slice(-2000));}
async function call(method,args){const r=await embedded.call(method,args);assert.equal(r.ok,true,JSON.stringify(r));return r.result;}
function source(id){return `#include <Arduino.h>
// No GPIO writes, Wi-Fi, filesystem or peripheral initialization in this acceptance sketch.
static const char *APP_ID = "${id}";
static String input;
void setup() {
  input.reserve(8192); Serial.setRxBufferSize(16384); Serial.begin(115200);
  Serial.printf("NODU_BOOT:%s FLASH:%u PSRAM:%u\\r\\n", APP_ID, ESP.getFlashChipSize(), ESP.getPsramSize());
}
void loop() {
  static unsigned long previous=0;
  if(millis()-previous>=500) { previous=millis(); Serial.printf("NODU_ALIVE:%s FLASH:%u PSRAM:%u\\r\\n", APP_ID, ESP.getFlashChipSize(), ESP.getPsramSize()); }
  while(Serial.available()) {
    char c=Serial.read();
    if(c=='\\n') { Serial.printf("NODU_ECHO:%s:%s\\r\\n",APP_ID,input.c_str()); input=""; }
    else if(c!='\\r' && input.length()<8192) input+=c;
  }
}
`;}
async function main(){
 await startOfflineGuard();
 const parent=path.join(root,'projects');fs.mkdirSync(parent,{recursive:true});
 const generated=await createSourceProject(parseProjectRequest({parent,name:'s3_com_'+Date.now(),chip:'esp32s3',framework:'arduino',template:'hello'}));report.project=generated.path;save();
 const project=await server.configure({path:generated.path,options:{USBMode:'hwcdc',CDCOnBoot:'default',UploadMode:'default',FlashSize:'16M',PSRAM:'opi'},port,monitor:{port,baud:115200,encoding:'utf-8'}});report.configuration=project;save();
 const ports=await server.ports();report.detectedPorts=ports;assert.ok(ports.some(p=>p.path===port&&p.vid===0x1a86),'Expected the selected CH343 bridge');
 report.initialMonitor=await call('openMonitor',{path:generated.path,port,baud:115200,arduino:true});
 for(let i=1;i<=2;i++){
  const id='s3-com-'+Date.now()+'-'+i,item={id,started:new Date().toISOString()};report.rounds.push(item);save();
  const file=path.join(generated.path,path.basename(generated.path)+'.ino');fs.writeFileSync(file,source(id));serial='';
  item.build=await server.compile({path:generated.path,operationId:'hardware-build-'+i});assert.equal(item.build.ok,true,JSON.stringify(item.build));save();
  const firmware=path.join(item.build.buildPath,path.basename(generated.path)+'.ino.bin');item.firmwareSha256=crypto.createHash('sha256').update(fs.readFileSync(firmware)).digest('hex');
  item.upload=await server.upload({path:generated.path,operationId:'hardware-upload-'+i,port,buildToken:item.build.buildToken});assert.equal(item.upload.ok,true,JSON.stringify(item.upload));save();
  item.monitorStatus=await call('monitorStatus',{});assert.equal(item.monitorStatus.open,true,'Monitor must be restored after upload');
  await waitFor('NODU_ALIVE:'+id+' FLASH:16777216 PSRAM:');
  const memory=new RegExp('NODU_ALIVE:'+id+' FLASH:(\\d+) PSRAM:(\\d+)').exec(serial);
  assert.ok(memory&&Number(memory[2])>=7*1024*1024,'Expected the board\'s 8 MiB PSRAM to be available');
  item.memory={flashBytes:Number(memory[1]),psramBytes:Number(memory[2])};
  item.commands=[];
  for(const text of ['PING-'+crypto.randomBytes(6).toString('hex'),'中文通信测试-'+i,'A'.repeat(4200)]){
   const expected='NODU_ECHO:'+id+':'+text;serial='';
   const result=await call('writeMonitor',{text:text+'\r\n',encoding:'utf-8'});assert.equal(result.sent,Buffer.byteLength(text+'\r\n'));await waitFor(expected);item.commands.push({characters:text.length,sentBytes:result.sent,echoMatched:true});save();
  }
  item.ok=true;item.finished=new Date().toISOString();save();
 }
 assert.notEqual(report.rounds[0].firmwareSha256,report.rounds[1].firmwareSha256,'Two distinct firmware images must have executed');
 await call('closeMonitor',{});await call('openMonitor',{path:report.project,port,baud:115200,arduino:true});serial='';
 await call('writeMonitor',{text:'REOPEN_OK\r\n',encoding:'utf-8'});await waitFor('NODU_ECHO:'+report.rounds[1].id+':REOPEN_OK');report.reopenCommunication=true;
 report.ok=true;
}
main().catch(e=>{report.ok=false;report.error=e.stack;process.exitCode=1;console.error(e.message);}).finally(async()=>{await embedded.call('closeMonitor',{}).catch(()=>{});server.onStop();embedded.onStop();if(guard&&guard.exitCode===null){const stopped=new Promise(resolve=>guard.once('exit',resolve));guard.stdin.end();await stopped;}events.end();report.finished=new Date().toISOString();save();console.log(JSON.stringify({ok:report.ok,project:report.project,rounds:report.rounds.map(r=>({ok:r.ok,firmwareSha256:r.firmwareSha256})),error:report.error}));});
