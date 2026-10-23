// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),{join}=require('node:path');
const {TutorLocalChecker}=require('../lib/node/tutor/tutor-local-checker'),{TutorPureRunner}=require('../lib/node/tutor/tutor-pure-runner');
const checker=new TutorLocalChecker(),runner=new TutorPureRunner();
async function inspect(text){const local=await checker.inspect({path:'drivers/sht30_calc.c',text,version:1,line:1},[],undefined,true);assert.ok(local.pure,JSON.stringify(local));return runner.inspect(local.pure,local.sourceDigest);}
test('actual WASI compiler and runtime distinguish correct, wrong and nonterminating course algorithms',async()=>{
 const source=await fs.readFile(join(__dirname,'../../examples/stm32-sht30-tutor/reference/drivers/sht30_calc.c'),'utf8');
 const good=await inspect(source);assert.equal(good.status,'passed',JSON.stringify(good));assert.equal(good.passed,196);
 const wrong=await inspect(source.replace('0x31u','0x30u'));assert.equal(wrong.status,'failed',JSON.stringify(wrong));assert.ok(wrong.passed<wrong.total);
 const loop=await inspect('uint8_t sht30_crc8(const uint8_t *data, uint8_t len){while(len){} return 0;}');assert.equal(loop.status,'failed',JSON.stringify(loop));
 const memory=await inspect('uint8_t sht30_crc8(const uint8_t *data, uint8_t len){return *(volatile uint8_t*)0x10000000;}');assert.equal(memory.status,'failed',JSON.stringify(memory));
 const context=await inspect('uint8_t sht30_crc8(const uint8_t *data,uint8_t len){return MISSING_CONSTANT;}');assert.equal(context.status,'unavailable');
 console.log(JSON.stringify({good,wrong,loop,memory,context}));
});
