const fs=require('node:fs'),path=require('node:path');require('reflect-metadata');
const root=process.env.NODU_ACCEPTANCE_ROOT;
const {NoduEmbeddedServer}=require(path.join(root,'app/scope-extension/lib/node/nodu-embedded-server'));
const service=new NoduEmbeddedServer(),file=path.join(root,'evidence/serial-ui-peer.json');
const report={started:new Date().toISOString(),port:'CNCB0',received:[]};
function save(){fs.writeFileSync(file,JSON.stringify(report,null,2));}
service.addClient({async onEvent(event,data){if(event==='monitor.data'){report.received.push({base64:data.data,utf8:Buffer.from(data.data,'base64').toString('utf8')});await service.call('writeMonitor',{data:data.data});save();}}});
(async()=>{report.open=await service.call('openMonitor',{port:'CNCB0',baud:115200,arduino:true});save();const timer=setInterval(async()=>{if(fs.existsSync(path.join(root,'evidence/stop-serial-ui-peer'))){clearInterval(timer);await service.call('closeMonitor',{});service.onStop();report.finished=new Date().toISOString();save();}},500);})().catch(e=>{report.error=e.stack;save();service.onStop();process.exitCode=1;});
