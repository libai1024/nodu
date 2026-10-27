const {spawn}=require('node:child_process');const {createInterface}=require('node:readline');const fs=require('node:fs');const assert=require('node:assert/strict');const root='/Users/wangwei/Model/k210-studio';
const child=spawn(root+'/desktop/native/target/debug/nodu-embedded',['--resources',root+'/desktop/scope-extension/resources/stm32','--toolkit',root+'/desktop/.tools/stm32/darwin','--data-dir',root+'/artifacts/isp-e2e-20261022/device-state']);
let id=0;const pending=new Map();let data=Buffer.alloc(0);const events=[];const tests=[];
createInterface({input:child.stdout}).on('line',s=>{const m=JSON.parse(s);if(m.event){events.push(m);if(m.event==='monitor.data')data=Buffer.concat([data,Buffer.from(m.data.data,'base64')]);return;}const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Object.assign(Error(m.error),{code:m.code})):p.resolve(m.result);}});
child.stderr.on('data',d=>process.stderr.write(d));
const delay=n=>new Promise(r=>setTimeout(r,n));
function call(method,args={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject,timer:setTimeout(()=>reject(Error('timeout '+method)),90000)});child.stdin.write(JSON.stringify({id:n,method,args})+'\n');});}
async function wait(fn,ms=6000){const start=Date.now();while(Date.now()-start<ms){if(fn())return;await delay(20);}throw Error('response timeout: '+data.toString('hex').slice(0,100));}
async function send(bytes){data=Buffer.alloc(0);await call('writeMonitor',{data:Buffer.from(bytes).toString('base64')});}
async function check(name,fn){await fn();await delay(100);tests.push({name,passed:true});console.log('PASS '+name);}

const args={path:root+'/artifacts/f103-ui-20261022/projects/f103-uart-e2e',method:'uart',port:'/dev/cu.usbserial-31230'};
(async()=>{try{
 await call('openMonitor',{port:args.port,baud:115200});await delay(100);
 await check('monitor loan persists in status and blocks competing changes',async()=>{
  const job=call('flash',args).then(value=>({value}),error=>({error}));
  await wait(()=>events.some(e=>e.event==='flash.awaitUser'&&e.data.kind==='enterBoot'),10000);
  const status=await call('monitorStatus');assert.equal(status.state,'lent');assert.equal(status.baud,115200);
  await assert.rejects(call('openMonitor',{port:args.port,baud:9600}),e=>e.code==='portBusy');
  await assert.rejects(call('closeMonitor'),e=>e.code==='portBusy');
  await assert.rejects(call('writeMonitor',{data:'UElORw=='}),e=>e.code==='portBusy');
  const started=Date.now();await call('cancel',{queue:'device'});const result=await job;
  assert.equal(result.error.code,'cancelled');assert(Date.now()-started<2000);
  await delay(300);assert.equal((await call('monitorStatus')).state,'open');
  await send('PING\r\n');await wait(()=>data.includes('PONG'));
  assert(!events.some(e=>e.event==='flash.step'&&e.data.step==='program'));
 });
 await check('ROM timeout releases loan and preserves communication',async()=>{
  const start=Date.now();const first=events.length;
  await assert.rejects(call('flash',args),e=>e.code==='romTimeout');
  assert(Date.now()-start>=60000);assert(Date.now()-start<70000);
  assert(!events.slice(first).some(e=>e.event==='flash.step'&&e.data.step==='program'));
  await delay(300);assert.equal((await call('monitorStatus')).state,'open');
  await send('PING\r\n');await wait(()=>data.includes('PONG'));
 });
 }catch(e){tests.push({passed:false,error:String(e)});console.error(e);process.exitCode=1;}finally{await call('closeMonitor').catch(()=>{});child.stdin.end();fs.writeFileSync(root+'/artifacts/isp-e2e-20261022/preflight-results.json',JSON.stringify({tests,events:events.filter(x=>x.event!=='monitor.data'&&x.event!=='flash.output')},null,2));}})();
