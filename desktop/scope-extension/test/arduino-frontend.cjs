// SPDX-License-Identifier: MIT
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
class Emitter { listeners=new Set(); event=fn=>{this.listeners.add(fn);return {dispose:()=>this.listeners.delete(fn)};}; fire(value){for(const fn of [...this.listeners])fn(value);} }
class Empty{}
function load(file){
 const filename=path.join(__dirname,'../src',file),exports={};
 const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true,emitDecoratorMetadata:false,jsx:ts.JsxEmit.React}}).outputText;
 vm.runInNewContext(code,{exports,Date,Math,Promise,Error,Set,Map,Number,String,TextEncoder,TextDecoder,Uint8Array,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,document:{hidden:false},require:id=>{
 if(id.includes('inversify'))return {inject:()=>()=>{},injectable:()=>x=>x,postConstruct:()=>()=>{}};
 if(id==='@theia/core/lib/common'||id==='@theia/core/lib/common/event')return {Emitter};
 if(id.endsWith('nodu-arduino-protocol'))return {ARDUINO_COMMANDS:{build:'build',upload:'upload',prepare:'prepare',stop:'stop'},NODU_ARDUINO_PATH:'/arduino'};
 if(id.endsWith('nodu-bottom-panel'))return {NoduBottomPanelWidget:{ID:'panel'}};
 if(id.endsWith('nodu-arduino-simulation-profiles'))return load('common/nodu-arduino-simulation-profiles.ts');
 if(id.startsWith('../common/'))return require(path.join(__dirname,'../lib/common',path.basename(id)));
 return new Proxy({},{get:()=>Empty});
 }});return exports;
}
const {NoduArduinoContribution}=load('browser/nodu-arduino-contribution.ts');
const {NoduArduinoModel}=load('browser/nodu-arduino-model.ts');
const {NoduEmbeddedModel}=load('browser/nodu-embedded-model.ts');
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const events=new Emitter(),out=new Emitter(),calls=[];
 const embedded={isArduino:true,espPath:'/project',projectGeneration:1,sourceGeneration:0,building:false,flashing:false,diagnosticsStale:false,output:[],onDidChange:events.event,
 fire:()=>events.fire(),setDiagnostics(d){this.markers=d;},setTask(text,tone){this.task={text,tone};events.fire();},appendOutput(line){this.output.push(line);},async syncArduinoMonitor(){calls.push('monitor');}};
 const service={async prepare(){calls.push('prepare');return{ok:true,diagnostics:[]};},async compile(){calls.push('compile');return{ok:true,buildToken:'token',diagnostics:[]};},async upload(){calls.push('upload');return{ok:true};},async cancel(id){calls.push('cancel');},async changeLibrary(){calls.push('library');return{ok:true};}};
 const arduino={path:'/project',project:{ready:true},selectedPort:'/dev/test',busy:false,loading:false,buildToken:'previous',canFlash:true,generation:1,builtRevision:0,libraryRevision:0,onDidOutput:out.event,service,fire(){},async refresh(){calls.push('refresh');}};
 const c=new NoduArduinoContribution();c.model=embedded;c.arduino=arduino;c.editors={all:[]};c.widgets={getOrCreateWidget:async()=>({id:'panel',showEmbedded(){}})};c.shell={getAreaFor:()=>true,revealWidget:async()=>{}};
 return{c,model:embedded,arduino,service,calls,edit(){embedded.sourceGeneration++;events.fire();},event(phase,line=''){out.fire({operationId:c.active?.id,path:'/project',phase,line});}};
}
test('upload saves dirty buffers, compiles once, then uses the returned token and restores the monitor',async()=>{
 const f=fixture();let saved=false;const saveable={dirty:true,save:async()=>{f.calls.push('save');saveable.dirty=false;saved=true;}};
 f.c.editors.all=[{isDisposed:false,editor:{uri:{path:{fsPath:()=>'/project/demo.ino'}}},saveable}];
 f.service.upload=async args=>{assert.equal(args.buildToken,'token');assert.equal(args.port,'/dev/test');assert.equal(saved,true);assert.equal(f.model.flashing,true);f.calls.push('upload');return{ok:true};};
 await f.c.run('upload');assert.deepEqual(f.calls,['save','compile','upload','monitor']);assert.equal(f.model.task.text,'烧录完成');assert.equal(f.model.flashing,false);assert.equal(f.arduino.operation,undefined);
});
test('first use compiles once, refreshes the prepared environment, and continues the requested upload',async()=>{
 for(const kind of ['build','upload']){
  const f=fixture();f.arduino.project.ready=false;f.arduino.refresh=async()=>{f.calls.push('refresh');f.arduino.project.ready=true;};
  await f.c.run(kind);
  assert.deepEqual(f.calls,kind==='build'?['compile','refresh']:['compile','refresh','upload','monitor']);
  assert.equal(f.arduino.project.ready,true);assert.equal(f.arduino.libraryRevision,1);assert.equal(f.model.lastBuild.ok,true);
  assert.equal(f.model.task.text,kind==='build'?'编译完成':'烧录完成');
 }
});
test('first-use source errors retain their diagnostics even when environment refresh fails',async()=>{
 const f=fixture(),diagnostics=[{severity:'error',file:'/project/demo.ino',line:3,column:1,message:'missing.h: No such file or directory'}];f.arduino.project.ready=false;
 f.service.compile=async()=>{f.calls.push('compile');return{ok:false,diagnostics,error:'编译失败，请查看构建输出。'};};
 f.arduino.refresh=async()=>{f.calls.push('refresh');throw Error('port refresh unavailable');};
 await f.c.run('upload');assert.deepEqual(f.calls,['compile','refresh']);assert.equal(f.model.markers,diagnostics);assert.equal(f.model.lastBuild.errors,1);
 assert.equal(f.model.task.text,'编译失败');assert.equal(f.model.task.tone,'error');assert.equal(f.arduino.buildToken,undefined);
 assert.equal(f.model.output.includes('编译失败，请查看构建输出。'),true);assert.equal(f.model.output.some(line=>line.includes('port refresh unavailable')),true);
});
test('a successful first build can upload even if environment refresh fails',async()=>{
 const f=fixture();f.arduino.project.ready=false;f.arduino.refresh=async()=>{f.calls.push('refresh');throw Error('refresh unavailable');};
 await f.c.run('upload');assert.deepEqual(f.calls,['compile','refresh','upload','monitor']);assert.equal(f.model.lastBuild.ok,true);assert.equal(f.model.task.text,'烧录完成');
});
test('cancel during first-use environment refresh prevents upload without discarding compile diagnostics',async()=>{
 const f=fixture(),held=defer(),diagnostics=[{severity:'warning',message:'unused variable'}];f.arduino.project.ready=false;
 f.service.compile=async()=>{f.calls.push('compile');return{ok:true,buildToken:'token',diagnostics};};
 f.arduino.refresh=()=>{f.calls.push('refresh');return held.promise;};
 const run=f.c.run('upload');await tick();assert.deepEqual(f.calls,['compile','refresh']);await f.c.stop();held.resolve();await run;
 assert.deepEqual(f.calls,['compile','refresh','cancel']);assert.equal(f.model.markers,diagnostics);assert.equal(f.model.task.text,'已停止');assert.equal(f.arduino.operation,undefined);
});
test('project switches during first-use environment refresh cannot upload or overwrite the next task',async()=>{
 const f=fixture(),held=defer();f.arduino.project.ready=false;f.arduino.refresh=()=>{f.calls.push('refresh');return held.promise;};
 const run=f.c.run('upload');await tick();f.model.projectGeneration++;f.arduino.path='/next';f.model.task={text:'新项目'};f.model.fire();held.resolve();await run;
 assert.deepEqual(f.calls,['compile','refresh','cancel']);assert.equal(f.model.task.text,'新项目');
});
test('a cancelled first compile does not start environment refresh or upload',async()=>{
 const f=fixture();f.arduino.project.ready=false;f.service.compile=async()=>{f.calls.push('compile');return{ok:false,cancelled:true,diagnostics:[]};};
 await f.c.run('upload');assert.deepEqual(f.calls,['compile']);assert.equal(f.model.task.text,'已停止');
});
test('editing while compiling for upload cancels and never starts writing',async()=>{
 const f=fixture(),held=defer();f.service.compile=()=>{f.calls.push('compile');return held.promise;};const run=f.c.run('upload');await tick();f.edit();held.resolve({ok:true,buildToken:'token',diagnostics:[]});await run;
 assert.deepEqual(f.calls,['compile','cancel']);assert.match(f.model.task.text,/代码已修改/);assert.equal(f.arduino.buildToken,undefined);
});
test('editing after writing starts does not interrupt firmware and marks the completed upload stale',async()=>{
 const f=fixture(),held=defer();f.service.upload=()=>{f.calls.push('upload');f.event('uploading');return held.promise;};const run=f.c.run('upload');await tick();f.edit();held.resolve({ok:true});await run;
 assert.equal(f.calls.includes('cancel'),false);assert.equal(f.model.task.text,'烧录完成 · 代码已修改');assert.equal(f.arduino.buildToken,undefined);
});
test('a project switch cancels once and drops old output, markers and completion',async()=>{
 const f=fixture(),held=defer();f.service.compile=()=>held.promise;const run=f.c.run('build');await tick();f.model.projectGeneration++;f.arduino.path='/next';f.model.task={text:'新项目'};f.model.fire();f.model.fire();f.event('compiling','old');held.resolve({ok:true,diagnostics:[{severity:'error',message:'old'}]});await run;
 assert.deepEqual(f.calls,['cancel']);assert.equal(f.model.output.includes('old'),false);assert.equal(f.model.task.text,'新项目');assert.equal(f.model.lastBuild,undefined);
});
test('flash uses a current compiled token without compiling again',async()=>{
 const f=fixture();f.service.upload=async args=>{assert.equal(args.buildToken,'previous');f.calls.push('upload');return{ok:true};};await f.c.run('flash');assert.deepEqual(f.calls,['upload','monitor']);
});
test('flash with dirty buffers is rejected without saving or calling the uploader',async()=>{
 const f=fixture();f.c.editors.all=[{isDisposed:false,editor:{uri:{path:{fsPath:()=>'/project/demo.ino'}}},saveable:{dirty:true,save:async()=>{throw Error('must not save');}}}];await f.c.run('flash');assert.deepEqual(f.calls,[]);assert.match(f.model.task.text,/重新编译/);
});
test('failed save and failed compile leave upload untouched and release busy state',async()=>{
 for(const saveFailure of [true,false]){const f=fixture();if(saveFailure)f.c.editors.all=[{isDisposed:false,editor:{uri:{path:{fsPath:()=>'/project/demo.ino'}}},saveable:{dirty:true,save:async()=>{throw Error('disk full');}}}];else f.service.compile=async()=>({ok:false,diagnostics:[{severity:'error',message:'syntax'}]});await f.c.run('upload');assert.equal(f.calls.includes('upload'),false);assert.equal(f.model.building,false);assert.equal(f.model.flashing,false);}
});
test('preparation is explicit and a library mutation invalidates a previous build',async()=>{
 const f=fixture();await f.c.run('prepare');assert.deepEqual(f.calls,['prepare','refresh']);assert.equal(f.model.task.text,'工具已就绪');f.calls.length=0;await f.c.run('libraries',{path:'/project',name:'ArduinoJson',version:'7.4.3',action:'add'});assert.deepEqual(f.calls,['library']);assert.equal(f.arduino.buildToken,undefined);assert.equal(f.arduino.libraryRevision,2);
});
test('explicit preparation failure or cancellation never reports readiness or continues into a build',async()=>{
 for(const result of [{ok:false,diagnostics:[],error:'download failed'},{ok:false,cancelled:true,diagnostics:[]}]){
  const f=fixture();f.service.prepare=async()=>{f.calls.push('prepare');return result;};await f.c.run('prepare');
  assert.deepEqual(f.calls,['prepare']);assert.equal(f.model.task.text,result.cancelled?'已停止':'操作失败');assert.equal(f.arduino.operation,undefined);
 }
 const f=fixture(),held=defer();f.arduino.refresh=()=>{f.calls.push('refresh');return held.promise;};
 const run=f.c.run('prepare');await tick();await f.c.stop();held.resolve();await run;assert.deepEqual(f.calls,['prepare','refresh','cancel']);assert.equal(f.model.task.text,'已停止');
});
test('loading disables every Arduino start command until the project inspection finishes',()=>{
 const f=fixture(),handlers=new Map();f.c.registerCommands({registerCommand:(command,handler)=>handlers.set(command.id,handler)});
 const commands=['build','upload','nodu.arduino.flash','prepare','nodu.arduino.library.change'];
 for(const id of commands)assert.equal(handlers.get(id).isEnabled(),true,id);
 f.arduino.loading=true;for(const id of commands)assert.equal(handlers.get(id).isEnabled(),false,id);
 f.arduino.loading=false;for(const id of commands)assert.equal(handlers.get(id).isEnabled(),true,id);
});
test('duplicate run is ignored and stopping twice sends one cancellation',async()=>{
 const f=fixture(),held=defer();let compile=0;f.service.compile=()=>{compile++;return held.promise;};const run=f.c.run('build');await tick();await f.c.run('build');await f.c.stop();await f.c.stop();held.resolve({ok:false,cancelled:true,diagnostics:[]});await run;assert.equal(compile,1);assert.deepEqual(f.calls,['cancel']);assert.equal(f.model.task.text,'已停止');
});
test('configuration failure preserves prior settings; late project responses cannot replace the next project',async()=>{
 const m=new NoduArduinoModel();m.embedded={isArduino:true,espPath:'/first',monitorBusy:false,busy:false,monitorPort:'/old',fire(){},applyArduinoMonitorSettings:async()=>{},sourceChanged(){}};m.project={fqbn:'old'};m.service={configure:async()=>{throw Error('failure');}};
 assert.equal(await m.configure({port:'/new'}),false);assert.equal(m.project.fqbn,'old');assert.equal(m.embedded.monitorPort,'/old');assert.equal(m.configuring,false);
 const held=defer();m.service.configure=()=>held.promise;const run=m.configure({port:'/new'});m.generation++;m.embedded.espPath='/second';m.project={fqbn:'second'};held.resolve({fqbn:'first',monitor:{baud:9600,encoding:'gbk'}});assert.equal(await run,false);assert.equal(m.project.fqbn,'second');
});
test('upload and monitor ports are independent, with upload fallback only before an explicit monitor selection',async()=>{
 const embedded=new NoduEmbeddedModel();embedded.isArduino=true;embedded.espPath='/project';
 const m=new NoduArduinoModel();m.embedded=embedded;m.project={port:'/dev/upload',monitor:{baud:115200,encoding:'utf-8'}};
 await embedded.applyArduinoMonitorSettings(m.project.monitor,m.project.port);assert.equal(embedded.monitorPort,'/dev/upload');assert.equal(m.selectedPort,'/dev/upload');
 await embedded.applyArduinoMonitorSettings({baud:115200,encoding:'utf-8',port:'/dev/usb-cdc'},'/dev/new-upload');
 assert.equal(embedded.monitorPort,'/dev/usb-cdc');assert.equal(m.selectedPort,'/dev/upload');
 await embedded.applyArduinoMonitorSettings({baud:115200,encoding:'utf-8',port:''},'/dev/new-upload');assert.equal(embedded.monitorPort,'');
 await embedded.applyArduinoMonitorSettings({baud:115200,encoding:'utf-8'},'/dev/new-upload');assert.equal(embedded.monitorPort,'/dev/new-upload');
});
test('Arduino monitor configuration reaches the adapter and opening identifies the Arduino CDC context',async()=>{
 const embedded=new NoduEmbeddedModel(),calls=[];embedded.isArduino=true;embedded.espPath='/project';embedded.monitorPort='/dev/cdc';
 embedded.arduinoMonitor={busy:()=>false,save:async change=>calls.push(change),selectPort:async port=>calls.push({port})};
 await embedded.setOption('monitorBaud',9600);await embedded.setOption('monitorEncoding','gbk');embedded.setMonitorPort('/dev/monitor');
 assert.equal(JSON.stringify(calls),JSON.stringify([{baud:9600},{encoding:'gbk'},{port:'/dev/monitor'}]));
 embedded.call=async(method,args)=>calls.push({method,args});await embedded.ensureMonitor();
 assert.equal(calls.at(-1).method,'openMonitor');assert.equal(calls.at(-1).args.arduino,true);assert.equal(calls.at(-1).args.path,'/project');
 embedded.flashing=true;const count=calls.length;await embedded.ensureMonitor();assert.equal(calls.length,count);
});
test('Arduino monitor changes reconnect only when needed; STM32 can still open its monitor during a flash',async()=>{
 const embedded=new NoduEmbeddedModel(),calls=[];embedded.isArduino=true;embedded.espPath='/project';embedded.monitor={open:true,state:'open',port:'/dev/a',baud:115200};embedded.monitorPort='/dev/a';
 embedded.call=async(method,args)=>{calls.push({method,args});return method==='monitorStatus'?{open:true,state:'open',port:embedded.monitorPort,baud:embedded.monitorConfig.baud}:undefined;};
 await embedded.applyArduinoMonitorSettings({baud:9600,encoding:'utf-8',port:'/dev/b'},'/dev/upload');
 assert.equal(calls[0].method,'openMonitor');assert.equal(calls[0].args.port,'/dev/b');assert.equal(calls[0].args.baud,9600);assert.equal(embedded.monitorBusy,false);
 calls.length=0;await embedded.applyArduinoMonitorSettings({baud:9600,encoding:'utf-8',port:'/dev/b'},'/dev/other-upload');assert.equal(calls.length,0);
 embedded.isArduino=false;embedded.project={path:'/stm32',manifest:{monitor:{baud:115200}}};embedded.flashing=true;embedded.monitor={open:false,state:'closed',port:'',baud:115200};
 await embedded.ensureMonitor();assert.equal(calls[0].method,'openMonitor');assert.equal(calls[0].args.path,'/stm32');assert.equal(calls[0].args.arduino,undefined);
});
test('a serial service crash does not overwrite the separate Arduino upload operation',()=>{
 const embedded=new NoduEmbeddedModel(),reports=[];embedded.isArduino=true;embedded.building=true;embedded.flashing=true;embedded.task={text:'烧录中'};embedded.systemDiagnostics={report:value=>reports.push(value)};
 embedded.onEvent('service.state',{running:false});assert.equal(embedded.building,true);assert.equal(embedded.flashing,true);assert.equal(embedded.task.text,'烧录中');assert.equal(reports[0].source,'串口服务');
});
test('simulation export saves, requires a pre-build snapshot and passes only the successful token to export',async()=>{
 const f=fixture(), saveable={dirty:true,save:async()=>{f.calls.push('save');saveable.dirty=false;}};
 f.c.editors.all=[{isDisposed:false,editor:{uri:{path:{fsPath:()=>'/project/demo.ino'}}},saveable}];
 f.service.compile=async args=>{assert.equal(args.simulation,true);f.calls.push('compile');return{ok:true,buildToken:'fresh',simulationReady:true,diagnostics:[]};};
 f.service.exportSimulation=async args=>{assert.equal(args.buildToken,'fresh');assert.equal(args.destination,'/exports/demo.esp-sim.zip');assert.equal(args.dependencies,undefined);f.calls.push('export');return{ok:true,path:args.destination};};
 await f.c.run('export',undefined,'/exports/demo.esp-sim.zip');assert.deepEqual(f.calls,['save','compile','export']);assert.equal(f.model.task.text,'仿真包已导出');assert.equal(f.model.flashing,false);
});
test('editing while compiling for simulation export cancels and cannot publish',async()=>{
 const f=fixture(),held=defer();f.service.compile=()=>{f.calls.push('compile');return held.promise;};f.service.exportSimulation=async()=>assert.fail('must not publish');
 const run=f.c.run('export',undefined,'/exports/demo.esp-sim.zip');await tick();f.edit();held.resolve({ok:true,buildToken:'fresh',simulationReady:true,diagnostics:[]});await run;
 assert.deepEqual(f.calls,['compile','cancel']);assert.equal(f.arduino.buildToken,undefined);
});
test('simulation export gives a configuration action before opening a save dialog and never changes options',async()=>{
 const f=fixture();f.arduino.project={path:'/project',chip:'esp32s3',coreVersion:'3.3.12',fqbn:'esp32:esp32:esp32s3'};
 let revealed=false;f.c.shell.revealWidget=async id=>{assert.equal(id,'panel');revealed=true;};
 f.c.dialogs={showSaveDialog:async()=>assert.fail('unsupported configuration must not export')};
 f.arduino.configure=async()=>assert.fail('must not silently change board settings');await f.c.exportSimulation();
 assert.match(f.arduino.error,/开发板设置/);assert.match(f.arduino.error,/8 MB/);assert.deepEqual(f.calls,[]);assert.equal(revealed,true,'the existing output must open so a compact workbench shows the reason');
});
test('cancelled save dialog or project switch cannot start a simulation compile',async()=>{
 for(const switched of [false,true]){
  const f=fixture();f.arduino.project={path:'/project',chip:'esp32c3',coreVersion:'3.3.12',fqbn:'esp32:esp32:esp32c3:CPUFreq=160,FlashSize=4M,FlashMode=qio,FlashFreq=80,CDCOnBoot=default,PartitionScheme=default'};
  f.c.dialogs={showSaveDialog:async()=>{if(switched){f.model.projectGeneration++;return{path:{fsPath:()=>'/exports/new.esp-sim.zip'}};}return undefined;}};
  await f.c.exportSimulation();assert.deepEqual(f.calls,[]);
 }
});
