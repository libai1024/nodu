// SPDX-License-Identifier: MIT
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseLinkerLayout,scatterFor}=require('../lib/node/nodu-keil-layout');
const {sourceCompatibility,checkCompilerArguments}=require('../lib/node/nodu-keil-compatibility');
const layout=(extra='')=>`ENTRY(Reset_Handler)
_estack = ORIGIN(RAM) + LENGTH(RAM);
_Min_Heap_Size=0x200; _Min_Stack_Size=0x1000;
MEMORY {
 FLASH (rx): ORIGIN=0x08000000, LENGTH=62K /* two pages reserved */
 RAM (xrw): ORIGIN=0x20000000, LENGTH=20K
}
SECTIONS {
 .isr_vector : { KEEP(*(.isr_vector)) } > FLASH
 .text : { *(.text*) } > FLASH
 .ram_vectors (NOLOAD) : { . = ALIGN(512); KEEP(*(.ram_vectors)) } > RAM
 .data : { *(.data*) *(.RamFunc*) } > RAM AT > FLASH
 .bss (NOLOAD) : { *(.bss*) } > RAM
 ${extra}
}`;
const limits={flashSize:65536,ramSize:20480};
test('custom Flash reservation, RAM vectors/functions and RAM-top stack survive translation',()=>{
 const actual=parseLinkerLayout(layout(),limits);
 assert.equal(actual.flashSize,62*1024);assert.equal(actual.stack,4096);assert.equal(actual.heap,512);
 assert.equal(actual.ramVectors,true);assert.equal(actual.ramFunctions,true);
 const s=scatterFor(actual,'startup_stm32f103xb.s');
 for(const fragment of ['0x08000000 0x0000F800','RAM_VECTORS 0x20000000 UNINIT','*(.RamFunc*)','ARM_STACK 0x20004000 UNINIT 0x00001000'])assert(s.includes(fragment),fragment);
});
test('unknown sections, computed sizes, invalid stack, memory overflow and custom stack expression fail closed',()=>{
 for(const value of [layout('.unmapped : { *(.unmapped) } > RAM'),layout().replace('62K','64K - 2K'),layout().replace('62K','128K'),layout().replace('0x1000','0x1001'),layout().replace('ORIGIN(RAM) + LENGTH(RAM)','0x20004000')])assert.throws(()=>parseLinkerLayout(value,limits),{code:'keilLayout'});
});
test('unused F407 CCM is recorded, while unconverted CCM placement is refused',()=>{
 const s=layout().replace('LENGTH=62K','LENGTH=1024K').replace('LENGTH=20K','LENGTH=128K').replace('}\nSECTIONS',' CCM (xrw): ORIGIN=0x10000000, LENGTH=64K\n}\nSECTIONS');
 const limits={flashSize:1048576,ramSize:131072,ccmSize:65536};
 assert.equal(parseLinkerLayout(s,limits).unusedCcm.size,65536);
 assert.throws(()=>parseLinkerLayout(s.replace('.bss (NOLOAD)', '.ccm (NOLOAD)').replace('*(.bss*) } > RAM','*(.bss*) } > CCM'),limits),{code:'keilLayout'});
});
test('C99 contract reports exact source locations and retains compile-time assertion meaning',()=>{
 const source='// memory.h and _Static_assert(0,"comment")\nconst char *s="_Static_assert";\n\n#include <memory.h>\n_Static_assert(sizeof(int)==4,"ABI");\n';
 const issues=sourceCompatibility('App/config.c',source);
 assert.deepEqual(issues.map(i=>[i.file,i.line]),[['App/config.c',4],['App/config.c',5]]);
 assert(issues[0].fix.includes('string.h'));assert(issues[1].fix.includes('1 : -1'));
 assert.equal(sourceCompatibility('ok.c','#include <string.h>\ntypedef char ABI[(sizeof(int)==4)?1:-1];').length,0);
 assert.doesNotThrow(()=>checkCompilerArguments(['-fstack-usage'],'App/a.c'));
 assert.throws(()=>checkCompilerArguments(['-fpack-struct=1'],'App/a.c'),{code:'keilCompiler'});
});
