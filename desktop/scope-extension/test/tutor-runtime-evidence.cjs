// SPDX-License-Identifier: MIT
const {test}=require('node:test');const assert=require('node:assert/strict');
const {TutorRuntimeEvidence}=require('../lib/node/tutor/tutor-runtime-evidence');
const bundle='a'.repeat(64),args={path:'/project',bundle};
const frame=text=>({port:'/dev/uart',data:Buffer.from(text).toString('base64')});
const flash={ok:true,method:'stlink',runId:'run-1',identity:{uid:'uid'},running:true};
const start={path:'/project',runId:'run-1'};
test('runtime observations bind to current artifact and capture only post-download selected-port data',()=>{
 let now=10;const e=new TutorRuntimeEvidence(()=>now);
 e.result('openMonitor',{path:'/project',port:'/dev/uart',baud:115200},{open:true});
 e.event('monitor.data',frame('old'));assert.equal(e.snapshot('/project',bundle),undefined);
 e.event('flash.started',start);e.result('flash',args,flash);
 e.event('monitor.data',frame('same-time'));now++;
 e.event('monitor.data',{port:'/other',data:frame('wrong').data});
 e.event('monitor.data',frame('fresh\r\n'));const s=e.snapshot('/project',bundle);
 assert.equal(s.serial.text,'fresh\r\n');assert.equal(s.serial.association,'user-selected-port');assert.equal(s.download.running,true);
 assert.equal(e.snapshot('/other',bundle),undefined);assert.equal(e.snapshot('/project','b'.repeat(64)),undefined);
 now+=30001;assert.equal(e.snapshot('/project',bundle).serial,undefined);
});
test('disconnect, reset of service and superseding flash cannot reuse old serial evidence or late replies',()=>{
 let now=1;const e=new TutorRuntimeEvidence(()=>now);
 e.result('openMonitor',{path:'/project',port:'/dev/uart'},{open:true});
 e.event('flash.started',start);e.result('flash',args,flash);now++;e.event('monitor.data',frame('old'));
 e.event('monitor.state',{port:'/dev/uart',state:'disconnected'});assert.equal(e.snapshot('/project',bundle).serial,undefined);
 e.event('monitor.state',{port:'/dev/uart',state:'open'});assert.equal(e.snapshot('/project',bundle).serial,undefined);
 e.event('flash.started',{path:'/other',runId:'run-2'});e.result('flash',args,flash);assert.equal(e.snapshot('/project',bundle),undefined);
 e.event('flash.started',start);e.result('flash',args,{...flash,running:null});assert.equal(e.snapshot('/project',bundle).download.running,null);
 e.event('service.state',{running:false});assert.equal(e.snapshot('/project',bundle),undefined);
});
test('without explicit firmware identity no runtime claim is created',()=>{
 const e=new TutorRuntimeEvidence();e.event('flash.started',start);
 e.result('flash',{path:'/project'},flash);assert.equal(e.snapshot('/project',bundle),undefined);
 e.result('flash',args,{...flash,ok:false});assert.equal(e.snapshot('/project',bundle),undefined);
});
