// SPDX-License-Identifier: MIT
// Cross-architecture tool probe, not a native Intel Electron acceptance test.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {TutorLocalChecker}=require('../../desktop/scope-extension/lib/node/tutor/tutor-local-checker');
const {TutorPureRunner,pureHarness,verifyNoImports}=require('../../desktop/scope-extension/lib/node/tutor/tutor-pure-runner');
const {validate}=require('../../desktop/scripts/package-tutor-tools.cjs');
(async()=>{
 const root=path.resolve(process.argv[2]);const manifest=validate(root,'darwin-x64');
 const checker=new TutorLocalChecker(),runner=new TutorPureRunner(root);
 const source=await fs.readFile(path.join(__dirname,'../../desktop/examples/stm32-sht30-tutor/reference/drivers/sht30_calc.c'),'utf8');
 const directory=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'nodu-x64-probe-'));await fs.chmod(directory,0o700);
 const results={host:process.platform+'-'+process.arch,tools:manifest.platform,scope:'x64 compiler/runtime under Rosetta using product harness and process budgets; not native Intel app',cases:[]};
 try{
  for(const [name,text] of [['reference',source],['wrong-crc',source.replace('0x31u','0x30u')],['loop','uint8_t sht30_crc8(const uint8_t *data,uint8_t len){while(len){}return 0;}'],['memory','uint8_t sht30_crc8(const uint8_t *data,uint8_t len){return *(volatile uint8_t*)0x10000000;}']]){
   const local=await checker.inspect({path:'drivers/sht30_calc.c',text,version:1,line:1},[],undefined,true);assert.ok(local.pure);
   const harness=pureHarness(local.pure);await fs.writeFile(path.join(directory,'test.c'),harness.source,{mode:0o600});
   const compile=await runner.run(path.join(root,'sdk/bin/clang'),['--target=wasm32-wasip1','-O0','-nostdlib','-nostdinc','-fno-builtin','-fno-stack-protector','-Werror','-Wl,--no-entry','-Wl,--export=run_tests','-Wl,--initial-memory=131072','-Wl,--max-memory=16777216','test.c','-o','test.wasm'],directory);
   assert.equal(compile.code,0,JSON.stringify(compile));assert.ok(!compile.reason);
   assert.ok(verifyNoImports(await fs.readFile(path.join(directory,'test.wasm'))));
   const result=await runner.run(path.join(root,'runtime/wasmtime'),['run','-W','fuel=2000000','-W','max-memory-size=16777216','--invoke','run_tests','test.wasm'],directory);
   const counts=result.output.split(/\r?\n/).filter(x=>/^\d+$/.test(x));
   if(name==='reference'){assert.equal(result.code,0);assert.deepEqual(counts,['196']);}
   else if(name==='wrong-crc'){assert.equal(result.code,0);assert.deepEqual(counts,['35']);}
   else {assert.notEqual(result.code,0);assert.equal(result.reason,undefined);assert.match(result.output,name==='loop'?/fuel consumed/:/out of bounds memory access/);}
   results.cases.push({name,total:harness.total,...result});
  }
  console.log(JSON.stringify(results,null,2));
 }finally{await fs.rm(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
