'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const app=process.env.NODU_TEST_APP,root=process.env.NODU_TEST_ROOT;
assert(app&&root);const production=require('./packaged-arduino-acceptance-loader.cjs')(app);
const {NoduArduinoServer,createSourceProject,parseProjectRequest}=production;
fs.mkdirSync(path.join(root,'evidence'),{recursive:true});
const report={started:new Date().toISOString(),productionBackend:production.productionBackend,cases:[],hardwareAccessed:false};
const server=new NoduArduinoServer();let events=[];server.addClient({onArduinoOutput:e=>events.push(e)});
const source = `#include <Arduino.h>
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
// Compile fixture only: these pin numbers are not a board wiring recommendation.
WiFiClient transport;
MqttClient mqtt(transport);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_I2CDevice i2c(0x3c);
Adafruit_NeoPixel pixels(1, 4, NEO_GRB + NEO_KHZ800);
DHT dht(5, DHT22);
OneWire wire(6);
DallasTemperature temperatures(&wire);
Servo servo;
void setup() {
  Serial.begin(115200);
  JsonDocument json;
  deserializeJson(json, "{\\"ok\\":true}");
  serializeJson(json, Serial);
  mqtt.setId("nodu-offline-compile-check");
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3c);
  oled.drawPixel(0, 0, SSD1306_WHITE);
  i2c.begin(); pixels.begin(); pixels.setPixelColor(0, 12, 0, 0); pixels.show();
  dht.begin(); Serial.println(dht.readTemperature());
  temperatures.begin(); temperatures.requestTemperatures();
  servo.attach(7); servo.write(90);
}
void loop() { delay(1000); }
`;

let guard;
async function main(){
 guard=require('node:child_process').spawn(process.env.NODU_TEST_GUARD,[process.execPath,path.join(process.env.NODU_ARDUINO_HOME,'bin/1.5.1/win32-x64/arduino-cli.exe')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Offline guard timeout')),15000);guard.stdout.on('data',x=>{text+=x;if(text.includes('OFFLINE_READY')){clearTimeout(timer);resolve();}});guard.on('error',reject)});
 report.networkDenied=await new Promise((resolve,reject)=>{const socket=require('node:net').connect(443,'192.0.2.1');socket.on('connect',()=>reject(Error('Network unexpectedly available')));socket.on('error',e=>{assert(['EACCES','EPERM'].includes(e.code));resolve(e.code)});socket.setTimeout(5000,()=>{socket.destroy();reject(Error('Network policy proof timeout'))})});

 const parent=path.join(root,'projects');fs.mkdirSync(parent,{recursive:true});
 const lib=JSON.parse(fs.readFileSync(path.join(app,'node_modules/@scope/studio-extension/resources/arduino/libraries/manifest.json')));assert.equal(lib.libraries.length,11);report.libraries=lib.libraries.map(x=>({name:x.name,version:x.version}));
 for(const chip of ['esp32c3','esp32s3']){
  const generated=await createSourceProject(parseProjectRequest({parent,name:'libs_'+chip,chip,framework:'arduino',template:'hello'}));const file=path.join(generated.path,'libs_'+chip+'.ino');
  fs.writeFileSync(file,source);const start=Date.now();const inspect=await server.inspect(generated.path);assert.equal(inspect.ready,true);const item={chip,inspectMs:Date.now()-start,project:generated.path};report.cases.push(item);
  item.build=await server.compile({path:generated.path,operationId:'libs-'+chip});assert.equal(item.build.ok,true,JSON.stringify(item.build));
  fs.writeFileSync(file,source+'\n#error EXPECTED_ACCEPTANCE_FAILURE\n');const failed=await server.compile({path:generated.path,operationId:'error-'+chip});assert.equal(failed.ok,false);item.expectedFailure=true;
  fs.writeFileSync(file,source);item.recovery=await server.compile({path:generated.path,operationId:'recovery-'+chip});assert.equal(item.recovery.ok,true);
  const restarted=new NoduArduinoServer();const t=Date.now();const reopened=await restarted.inspect(generated.path);assert.equal(reopened.ready,true);item.reopenMs=Date.now()-t;restarted.onStop();
  fs.writeFileSync(path.join(root,'evidence/software-result.json'),JSON.stringify(report,null,2));
 }
 report.success=true;
}
main().catch(e=>{report.success=false;report.error=e.stack;console.error(e);process.exitCode=1}).finally(()=>{guard?.stdin.end();server.onStop();report.finished=new Date().toISOString();fs.writeFileSync(path.join(root,'evidence/software-result.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(root,'evidence/software-events.json'),JSON.stringify(events));console.log(JSON.stringify(report));});
