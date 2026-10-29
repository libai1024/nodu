const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
require('reflect-metadata');const iconv=require('iconv-lite');
const root=process.env.NODU_ACCEPTANCE_ROOT;
const {NoduEmbeddedServer}=require(path.join(root,'app/scope-extension/lib/node/nodu-embedded-server'));
const a=new NoduEmbeddedServer(),b=new NoduEmbeddedServer(),competitor=new NoduEmbeddedServer();
const report={started:new Date().toISOString(),transport:'existing Windows com0com kernel driver, CNCA0 <-> CNCB0; no physical hardware',cases:[],events:[]};
const received={a:[],b:[]};
for(const [name,s] of [['a',a],['b',b]])s.addClient({onEvent(event,data){report.events.push({name,event,data});if(event==='monitor.data')received[name].push(Buffer.from(data.data,'base64'));}});
function save(){fs.writeFileSync(path.join(root,'evidence/serial.json'),JSON.stringify(report,null,2));}
async function check(name,fn){const item={name};report.cases.push(item);try{item.result=await fn();item.ok=true;}catch(e){item.ok=false;item.error=e.stack;}save();console.log(JSON.stringify(item));return item.ok;}
async function success(server,method,args){const r=await server.call(method,args);assert.equal(r.ok,true,JSON.stringify(r));return r.result;}
async function exchange(sender,target,args,expected){received[target]=[];const result=await success(sender,'writeMonitor',args);const until=Date.now()+5000;while(Buffer.concat(received[target]).length<expected.length&&Date.now()<until)await new Promise(r=>setTimeout(r,20));const actual=Buffer.concat(received[target]);assert.ok(actual.equals(expected),JSON.stringify({expected:expected.toString('hex'),actual:actual.toString('hex')}));assert.equal(result.sent,expected.length);return {bytes:actual.length,hex:actual.length<100?actual.toString('hex'):undefined};}
async function main(){
 await check('native port enumeration',()=>success(a,'listPorts',{}));
 const opened=await check('open both virtual UART endpoints',async()=>({a:await success(a,'openMonitor',{port:'CNCA0',baud:115200,arduino:true}),b:await success(b,'openMonitor',{port:'CNCB0',baud:115200,arduino:true})}));
 if(!opened)return;
 await check('UTF-8 Chinese and emoji TX/RX',()=>exchange(a,'b',{text:'Nodu 中文 😀\r\n',encoding:'utf-8'},Buffer.from('Nodu 中文 😀\r\n')));
 await check('GBK Chinese TX/RX',()=>exchange(a,'b',{text:'串口中文测试\r\n',encoding:'gbk'},iconv.encode('串口中文测试\r\n','gbk')));
 await check('reverse direction receive',()=>exchange(b,'a',{text:'WINDOWS_ACK\n',encoding:'utf-8'},Buffer.from('WINDOWS_ACK\n')));
 await check('binary NUL and FF payload',()=>exchange(b,'a',{data:Buffer.from([0,1,10,13,127,128,255]).toString('base64')},Buffer.from([0,1,10,13,127,128,255])));
 await check('LF CR and CRLF remain exact',()=>exchange(a,'b',{text:'A\nB\rC\r\nD',encoding:'utf-8'},Buffer.from('A\nB\rC\r\nD')));
 await check('larger UTF-8 payload is not lost',()=>exchange(a,'b',{text:'中文😀123\n'.repeat(300),encoding:'utf-8'},Buffer.from('中文😀123\n'.repeat(300))));
 await check('unrepresentable GBK rejects without transmitting',async()=>{const r=await a.call('writeMonitor',{text:'😀',encoding:'gbk'});assert.equal(r.ok,false);return r;});
 await check('second process cannot claim occupied UART',async()=>{const r=await competitor.call('openMonitor',{port:'CNCA0',baud:115200});assert.equal(r.ok,false);return r;});
 await check('explicit disconnect closes and rejects TX',async()=>{await success(a,'closeMonitor',{});const status=await success(a,'monitorStatus',{});assert.equal(status.open,false);const r=await a.call('writeMonitor',{text:'closed',encoding:'utf-8'});assert.equal(r.ok,false);return {status,r};});
 await check('reopen with different baud and communicate',async()=>{await success(a,'openMonitor',{port:'CNCA0',baud:9600,arduino:true});await success(b,'openMonitor',{port:'CNCB0',baud:9600,arduino:true});const status=await success(a,'monitorStatus',{});assert.equal(status.baud,9600);return exchange(a,'b',{text:'REOPEN_OK\r\n',encoding:'utf-8'},Buffer.from('REOPEN_OK\r\n'));});
}
main().catch(e=>{report.fatal=e.stack;process.exitCode=1;}).finally(async()=>{for(const s of [a,b,competitor]){await s.call('closeMonitor',{}).catch(()=>{});s.onStop();}report.finished=new Date().toISOString();report.ok=report.cases.every(x=>x.ok)&&!report.fatal;save();console.log(JSON.stringify({ok:report.ok,cases:report.cases.length}));});
