const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {buildLocation}=require('../scope-extension/lib/node/nodu-build-location');
test('build directory follows actual preset and never creates absent outputs',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nodu 固件 '));
 try{
  await fs.writeFile(path.join(root,'nodu.json'),JSON.stringify({kind:'stm32-hal'}));
  await assert.rejects(buildLocation(root),/尚无/);
  await fs.mkdir(path.join(root,'build/debug'),{recursive:true});await fs.writeFile(path.join(root,'build/debug/firmware.hex'),'hex');
  assert.equal(await buildLocation(root),path.join(await fs.realpath(root),'build/debug'));
  await fs.writeFile(path.join(root,'nodu.json'),JSON.stringify({kind:'stm32-hal',build:{preset:'release'}}));
  await assert.rejects(buildLocation(root),/尚无/);
  await fs.mkdir(path.join(root,'build/release'),{recursive:true});await fs.writeFile(path.join(root,'build/release/firmware.bin'),'bin');
  assert.equal(await buildLocation(root),path.join(await fs.realpath(root),'build/release'));
  await fs.writeFile(path.join(root,'nodu.json'),JSON.stringify({kind:'other'}));await assert.rejects(buildLocation(root),/不是/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
