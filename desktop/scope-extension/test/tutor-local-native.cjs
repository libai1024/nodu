// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict'),{TutorLocalChecker}=require('../lib/node/tutor/tutor-local-checker');
const checker=new TutorLocalChecker();
test('packaged Rust checker parses actual C and scopes call rules',async()=>{
 const r=await checker.inspect({path:'main.c',text:'// 中文😀\nvoid other(){receive();}\nvoid main(){ if(HAL_OK!=receive()){return;} }',line:3,version:1},[{id:'return',kind:'checksReturn',function:'main',callee:'receive'}]);
 assert.equal(r.syntax,'valid',r.note);assert.equal(r.findings[0].verdict,'verified');assert.equal(r.findings[0].line,3);
 const broken=await checker.inspect({path:'main.c',text:'void main(){ receive(; }',line:1,version:2});assert.equal(broken.syntax,'incomplete');
});
