// SPDX-License-Identifier: MIT
// Offline course acceptance. Never identifies, resets or flashes a device.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const desktop=path.resolve(__dirname,'..');
const {parseCourse,canonicalCourseContent}=require(path.join(desktop,'scope-extension/lib/common/tutor/tutor-course'));
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'nodu-course-check-'));
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const results=[];
function sorted(v){return Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;}
try {
 for(const name of ['stm32f103-uart-tutor','stm32-sht30-tutor']) {
  const original=path.join(desktop,'examples',name),plan=JSON.parse(fs.readFileSync(path.join(original,'.nodu-tutor/plan.json')));
  assert.ok(parseCourse(plan).course);assert.equal(plan.contentHash,hash(canonicalCourseContent(plan)));
  const lock=JSON.parse(fs.readFileSync(path.join(original,'.nodu-tutor/sdk-lock.json')));
  assert.equal(plan.target.sdkDigest,hash(JSON.stringify(sorted(lock.fileRecords))));
  for(const step of plan.steps)for(const anchor of step.anchors){
   const text=fs.readFileSync(path.join(original,anchor.path),'utf8');
   if(anchor.marker)assert.equal(text.split('\n').filter(l=>l.includes(anchor.marker)).length,1,step.id);
  }
  for(const variant of ['starter','reference']) {
   const project=path.join(scratch,name+'-'+variant);
   fs.cpSync(original,project,{recursive:true,filter:p=>!['build','.nodu','reference'].includes(path.basename(p))});
   if(variant==='reference')fs.cpSync(path.join(original,'reference'),project,{recursive:true});
   const args=[path.join(desktop,'scripts/stm32-cli.cjs'),'--bin',path.join(desktop,'scope-extension/resources/bin',`${process.platform}-${process.arch}`,process.platform==='win32'?'nodu-embedded.exe':'nodu-embedded'),'--project',project,'--data-dir',path.join(scratch,'data'),'trustProject','build'];
   const output=execFileSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
   assert.match(output,/build ok=true errors=0/);const line=output.split('\n').find(l=>l.includes('✓ build'));
   results.push({name,variant,build:line});
   if(name==='stm32-sht30-tutor') {
    const test=path.join(project,'test_sht30');
    execFileSync('cc',['-std=c99','-Wall','-Wextra','-Idrivers','-Iapp','test/test_sht30.c','drivers/sht30_calc.c','app/alarm.c','-o',test],{cwd:project,timeout:30000,stdio:'pipe'});
    if(variant==='reference') assert.match(execFileSync(test,[],{cwd:project,encoding:'utf8',timeout:5000}),/全部通过/);
    else {let code;try{execFileSync(test,[],{cwd:project,stdio:'pipe',timeout:5000});}catch(e){code=e.status;}assert.equal(code,2,'Empty tests must never pass');}
   }
  }
 }
 console.log(JSON.stringify({kind:'offline-course-acceptance',hardware:false,results},null,2));
} finally {fs.rmSync(scratch,{recursive:true,force:true});}
