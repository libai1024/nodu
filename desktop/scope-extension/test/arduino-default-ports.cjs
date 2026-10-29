const {test}=require('node:test'),assert=require('node:assert/strict');
const {preferredArduinoUartPort}=require('../lib/common/nodu-arduino-ports');
test('a unique COM bridge wins over ESP native USB and virtual ports',()=>{
 const bridge={path:'COM4',vid:0x1a86,pid:0x55d3};
 assert.equal(preferredArduinoUartPort([{path:'COM8',vid:0x303a},bridge,{path:'CNCA0'}]),bridge);
});
test('multiple bridges, native USB alone and unknown ports require an explicit choice',()=>{
 for(const list of [[],[{path:'COM8',vid:0x303a}],[{path:'COM4'}],[{path:'COM4',vid:0x1a86},{path:'COM5',vid:0x10c4}]])assert.equal(preferredArduinoUartPort(list),undefined);
});
test('macOS UART bridge paths also work without treating USB-native ports as bridges',()=>{
 const bridge={path:'/dev/cu.usbserial-123',vid:0x10c4};assert.equal(preferredArduinoUartPort([bridge]),bridge);
 assert.equal(preferredArduinoUartPort([{path:'CNCA0',vid:0x1a86}]),undefined);
});
