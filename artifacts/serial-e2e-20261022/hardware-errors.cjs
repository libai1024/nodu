const {spawn}=require('node:child_process');const {createInterface}=require('node:readline');const fs=require('node:fs');const assert=require('node:assert/strict');const root='/Users/wangwei/Model/k210-studio';
const child=spawn(root+'/desktop/native/target/debug/nodu-embedded',['--resources',root+'/desktop/scope-extension/resources/stm32','--toolkit',root+'/desktop/.tools/stm32/darwin','--data-dir',root+'/artifacts/f103-ui-20261022/device-state']);
let id=0;const pending=new Map();let data=Buffer.alloc(0);const events=[];const tests=[];
createInterface({input:child.stdout}).on('line',s=>{const m=JSON.parse(s);if(m.event){events.push(m);if(m.event==='monitor.data')data=Buffer.concat([data,Buffer.from(m.data.data,'base64')]);return;}const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Object.assign(Error(m.error),{code:m.code})):p.resolve(m.result);}});
child.stderr.on('data',d=>process.stderr.write(d));
const delay=n=>new Promise(r=>setTimeout(r,n));
function call(method,args={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject,timer:setTimeout(()=>reject(Error('timeout '+method)),15000)});child.stdin.write(JSON.stringify({id:n,method,args})+'\n');});}
async function wait(fn,ms=6000){const start=Date.now();while(Date.now()-start<ms){if(fn())return;await delay(20);}throw Error('response timeout: '+data.toString('hex').slice(0,100));}
async function send(bytes){data=Buffer.alloc(0);await call('writeMonitor',{data:Buffer.from(bytes).toString('base64')});}
async function check(name,fn){await fn();await delay(100);tests.push({name,passed:true});console.log('PASS '+name);}
(async()=>{try{
 await call('openMonitor',{port:'/dev/cu.usbserial-31230',baud:115200});await delay(100);
 await check('failed port switch closes old port and reports closed status',async()=>{
  await assert.rejects(call('openMonitor',{port:'/dev/cu.nodu-nonexistent',baud:115200}),e=>e.code==='portOpen');
  const status=await call('monitorStatus');assert.equal(status.open,false);assert.equal(status.state,'closed');
  assert(events.some(e=>e.event==='monitor.state'&&e.data.state==='closed'));
 });
 await check('real port reopens after failed switch and communicates',async()=>{
  await call('openMonitor',{port:'/dev/cu.usbserial-31230',baud:115200});await delay(100);
  await send('PING\n');await wait(()=>data.includes('PONG'));
 });
 await check('second process cannot take active serial port',async()=>{
  const other=spawn(root+'/desktop/native/target/debug/nodu-embedded',['--resources',root+'/desktop/scope-extension/resources/stm32','--toolkit',root+'/desktop/.tools/stm32/darwin','--data-dir',root+'/artifacts/f103-ui-20261022/device-state']);
  const result=new Promise((resolve,reject)=>{let out='';other.stdout.on('data',b=>out+=b);other.on('error',reject);other.on('close',()=>resolve(out));});
  other.stdin.end(JSON.stringify({id:1,method:'openMonitor',args:{port:'/dev/cu.usbserial-31230',baud:115200}})+'\n');
  const messages=(await result).trim().split('\n').map(x=>JSON.parse(x));assert.equal(messages.find(x=>x.id===1).code,'portBusy');
  await send('PING\n');await wait(()=>data.includes('PONG'));
 });
 await check('closed monitor rejects writes',async()=>{
  await call('closeMonitor');await assert.rejects(call('writeMonitor',{data:'UElORw=='}),e=>e.code==='notOpen');
 });
 }catch(e){tests.push({passed:false,error:String(e)});console.error(e);process.exitCode=1;}finally{await call('closeMonitor').catch(()=>{});child.stdin.end();fs.writeFileSync(root+'/artifacts/serial-e2e-20261022/hardware-errors.json',JSON.stringify({tests,stateEvents:events.filter(x=>x.event==='monitor.state')},null,2));}})();
