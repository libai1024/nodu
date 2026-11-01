// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {readProjectCatalog}=require('../lib/node/nodu-stm32-catalog');
test('manual chip choices read real packaged metadata without a native service or device',async()=>{
 const {boards}=await readProjectCatalog(path.resolve(__dirname,'../resources/stm32'));
 const chips=boards.filter(b=>b.id.startsWith('chip-'));
 assert.deepEqual(chips.map(b=>b.mcu).sort(),['STM32F103C8Tx','STM32F407ZGTx']);
 assert.equal(chips.find(b=>b.mcu==='STM32F103C8Tx').flashKiB,64);
 assert.equal(chips.find(b=>b.mcu==='STM32F407ZGTx').ramKiB,128);
 assert(boards.every(b=>b.reference===`${b.id}@${b.version}`));
});
