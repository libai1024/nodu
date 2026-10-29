const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
require('reflect-metadata');const root=process.env.NODU_ACCEPTANCE_ROOT;
const {NoduArduinoServer}=require(path.join(root,'app/scope-extension/lib/node/nodu-arduino-server'));
const {NoduEmbeddedServer}=require(path.join(root,'app/scope-extension/lib/node/nodu-embedded-server'));
const server=new NoduArduinoServer(),embedded=new NoduEmbeddedServer();server.embedded=embedded;
const report={started:new Date().toISOString(),note:'Diagnostic only: manually seed independently downloaded and SHA-256-verified official archive; automatic Nodu network download previously failed.'};
const events=fs.createWriteStream(path.join(root,'evidence/cached-library-events.jsonl'));server.addClient({onArduinoOutput:e=>events.write(JSON.stringify(e)+'\n')});
const project=path.join(root,'projects with spaces/nodu_esp32c3'),sketch=path.join(project,'nodu_esp32c3.ino');
(async()=>{
 const bytes=fs.readFileSync(path.join(root,'network/PubSubClient.download'));report.archiveSha256=crypto.createHash('sha256').update(bytes).digest('hex');assert.equal(report.archiveSha256,'f0849b93a2b02e263a6c157c374d6103caefba753a47dcbef64bbec620b079fe');
 fs.copyFileSync(path.join(root,'network/PubSubClient.download'),path.join(process.env.NODU_ARDUINO_HOME,'downloads/libraries/PubSubClient-2.8.0.zip'));
 report.add=await server.changeLibrary({path:project,name:'PubSubClient',version:'2.8.0',action:'add',operationId:'verified-cache-add'});assert.equal(report.add.ok,true,JSON.stringify(report.add));
 const text=fs.readFileSync(sketch,'utf8').replace('#include <WiFi.h>','#include <WiFi.h>\n#include <PubSubClient.h>').replace('WiFiClient wifi;','WiFiClient wifi; PubSubClient extraMqtt(wifi);');fs.writeFileSync(sketch,text);
 report.build=await server.compile({path:project,operationId:'verified-cache-build'});assert.equal(report.build.ok,true,JSON.stringify(report.build));
 report.invalidPort=await server.upload({path:project,operationId:'no-board-upload-check',port:'COM9999',buildToken:report.build.buildToken});assert.equal(report.invalidPort.ok,false);
 report.ok=true;
})().catch(e=>{report.error=e.stack;process.exitCode=1;}).finally(()=>{server.onStop();embedded.onStop();events.end();report.finished=new Date().toISOString();fs.writeFileSync(path.join(root,'evidence/cached-library.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));});
