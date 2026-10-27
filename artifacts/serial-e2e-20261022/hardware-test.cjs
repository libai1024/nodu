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
 await call('openMonitor',{port:'/dev/cu.usbserial-31230',baud:115200});await delay(80);
 await check('ASCII PING/PONG on real PA9/PA10',async()=>{await send('PING\r\n');await wait(()=>data.includes('PONG'));});
 for(const [label,ending]of [['CRLF','\r\n'],['LF','\n'],['none','']])await check('exact '+label+' transmit bytes',async()=>{let bytes=Buffer.from('abc'+ending);await send(bytes);await wait(()=>data.includes('RX['));await delay(100);assert(data.includes(`RX[${bytes.length}]:${bytes.toString('hex')}`));});
 await check('fragmented UTF-8 Chinese',async()=>{await send('UTF8\n');await wait(()=>data.includes(Buffer.from('中文串口测试\r\n')),4000);});
 await check('fragmented GBK Chinese',async()=>{await send('GBK\n');await wait(()=>data.includes(Buffer.from('d6d0cec4b4aebfdab2e2cad40d0a','hex')),4000);});
 await check('binary bytes including NUL CR LF invalid UTF-8',async()=>{await send('BINARY\n');await wait(()=>data.length>=11);assert.deepEqual(data,Buffer.from([0,1,10,13,127,128,255,195,40,0,126]));});
 await check('1000 sequenced lines at 115200 without loss',async()=>{await send('BURST\n');await wait(()=>data.includes('BURST 0999'),10000);await delay(100);const lines=data.toString().trim().split('\r\n');assert.equal(lines.length,1000);lines.forEach((l,i)=>assert.equal(l,`BURST ${String(i).padStart(4,'0')} abcdefghijklmnopqrstuvwxyz`));});
 await check('20000 byte line intact',async()=>{await send('LONG\n');await wait(()=>data.length>=20002,10000);assert.equal(data.toString(),'x'.repeat(20000)+'\r\n');});
 await check('5 close/reopen cycles',async()=>{for(let i=0;i<5;i++){await call('closeMonitor');await call('openMonitor',{port:'/dev/cu.usbserial-31230',baud:115200});await delay(70);await send('PING\n');await wait(()=>data.includes('PONG'));}});
 await check('9600 then 115200 with both endpoints reconfigured',async()=>{for(const baud of[9600,115200]){await send('BAUD:'+baud+'\n');await wait(()=>data.includes('BAUD OK'));await delay(300);await call('openMonitor',{port:'/dev/cu.usbserial-31230',baud});await delay(100);await send('PING\n');await wait(()=>data.includes('PONG'));}});
 }catch(e){tests.push({passed:false,error:String(e)});console.error(e);process.exitCode=1;}finally{await call('closeMonitor').catch(()=>{});child.stdin.end();fs.writeFileSync(root+'/artifacts/serial-e2e-20261022/hardware-results.json',JSON.stringify({tests,stateEvents:events.filter(x=>x.event==='monitor.state')},null,2));}})();
