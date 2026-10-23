// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict'),{TutorLocalChecker}=require('../lib/node/tutor/tutor-local-checker');
const checker=new TutorLocalChecker();
test('packaged Rust checker parses actual C and scopes call rules',async()=>{
 const r=await checker.inspect({path:'main.c',text:'// 中文😀\nvoid other(){receive();}\nvoid main(){ if(HAL_OK!=receive()){return;} }',line:3,version:1},[{id:'return',kind:'checksReturn',function:'main',callee:'receive'}]);
 assert.equal(r.syntax,'valid',r.note);assert.equal(r.findings[0].verdict,'verified');assert.equal(r.findings[0].line,3);
 const broken=await checker.inspect({path:'main.c',text:'void main(){ receive(; }',line:1,version:2});assert.equal(broken.syntax,'incomplete');
});

test('real AST prevents an older persisted top-level call ghost from reappearing',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const {TutorGoalStore}=require('../lib/node/tutor/tutor-goal-store'),{TutorGoalSession}=require('../lib/node/tutor/tutor-goal-session');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nodu-native-restore-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new TutorGoalStore(dir),context={key:'f'.repeat(64),mcu:'STM32F103C8T6',sdk:'stm32cube-f1',files:['main.c']};
 const source={path:'main.c',text:'int main(void) {\n\n}\n\n',version:1,line:4};
 await store.write(context.key,0,{revision:0,status:'paused',goal:'UART',title:'UART',target:{mcu:context.mcu,sdk:context.sdk},steps:[{id:'step-1',path:'main.c',title:'初始化',goal:'初始化串口'}],current:0,fragment:{source,answer:{text:'调用初始化',annotations:[],guidance:{anchorLine:4,lines:['Board_DebugUartInit(BOARD_DEBUG_BAUD);']}}}},async()=>{});
 const session=new TutorGoalSession(store,{complete:()=>{throw Error('must not call model');}},async(id,b)=>({...context,...(b?{localCheck:await checker.inspect(b)}:{})}),async()=>{});t.after(()=>session.dispose());
 const snapshot=await session.snapshot('workspace-1');assert.equal(snapshot.fragment,undefined);assert.equal(snapshot.revision,1);assert.equal(snapshot.status,'paused');assert.ok((await store.read(context.key)).fragment,'read-only validation preserves recoverable history');
});
