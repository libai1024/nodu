// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {parseCourse,canonicalCourseContent}=require('../lib/common/tutor/tutor-course');
for(const [name,mcu] of [['stm32f103-uart-tutor','STM32F103C8Tx'],['stm32-sht30-tutor','STM32F407ZGTx']]){
 test(`bundled ${name} has a sealed chip-based course and unambiguous source anchors`,()=>{
  const root=path.join(__dirname,'../../examples',name),raw=JSON.parse(fs.readFileSync(path.join(root,'.nodu-tutor/plan.json'))),course=parseCourse(raw).course;
  assert.ok(course);assert.equal(course.target.mcu,mcu);assert.equal(course.target.mcu,JSON.parse(fs.readFileSync(path.join(root,'nodu.json'))).target.mcu);
  assert.equal(course.contentHash,createHash('sha256').update(canonicalCourseContent(course)).digest('hex'));
  assert.ok(!course.legacy);assert.ok(!JSON.stringify(course).includes(' · '));
  for(const step of course.steps)for(const anchor of step.anchors){const code=fs.readFileSync(path.join(root,anchor.path),'utf8');if(anchor.marker)assert.equal(code.split('\n').filter(l=>l.includes(anchor.marker)).length,1);}
 });
}
