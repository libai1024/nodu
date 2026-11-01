// SPDX-License-Identifier: MIT
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {inspectProject,selectProjectChip}=require('../lib/node/nodu-project-discovery');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nodu-project-open-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return fs.realpath(root);}
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value)};
test('parent-folder and uvprojx open resolve the real root; multiple targets stay explicit choices',async t=>{
 const root=await fixture(t),a=path.join(root,'firmware');
 await write(path.join(a,'nodu.json'),JSON.stringify({kind:'stm32-hal',target:{mcu:'STM32F103C8Tx'}}));
 await write(path.join(a,'MDK-ARM/Nodu.uvprojx'),'<Project/>');
 assert.equal((await inspectProject(root)).candidates[0].path,a);
 assert.equal((await inspectProject(path.join(a,'MDK-ARM/Nodu.uvprojx'))).folder,a);
 await write(path.join(root,'second/nodu.json'),JSON.stringify({kind:'k210-maixpy'}));
 assert.equal((await inspectProject(root)).candidates.length,2);
 await write(path.join(root,'build/ignored/nodu.json'),'{}');assert.equal((await inspectProject(root)).candidates.length,2);
});
test('unknown folder remains unknown until explicit choice; source-only metadata does not invent build files',async t=>{
 const root=await fixture(t);await write(path.join(root,'App/existing.c'),'int untouched=7;');
 assert.deepEqual((await inspectProject(root)).candidates,[]);
 await assert.rejects(fs.access(path.join(root,'nodu.json')));
 await selectProjectChip(root,'STM32F103C8Tx');
 const manifest=JSON.parse(await fs.readFile(path.join(root,'nodu.json'),'utf8'));
 assert.equal(manifest.target.mcu,'STM32F103C8Tx');assert.equal(manifest.build.sourceOnly,true);
 assert.equal(await fs.readFile(path.join(root,'App/existing.c'),'utf8'),'int untouched=7;');
 await assert.rejects(fs.access(path.join(root,'CMakeLists.txt')));
});
test('manual CMake import persists exact chip, backs up config and refuses an incompatible chip switch',async t=>{
 const root=await fixture(t);await write(path.join(root,'CMakeLists.txt'),'# Existing build');
 await selectProjectChip(root,'STM32F407ZGTx');
 let manifest=JSON.parse(await fs.readFile(path.join(root,'nodu.json'),'utf8'));
 assert.equal(manifest.build.external,true);assert.equal(manifest.build.sourceOnly,false);
 await selectProjectChip(root,'STM32F407ZGTx');
 assert.equal((await fs.readdir(path.join(root,'.nodu/project-selection'))).length,1);
 const original=await fs.readFile(path.join(root,'nodu.json'),'utf8');
 await assert.rejects(selectProjectChip(root,'STM32F103C8Tx'),/其他芯片/);
 assert.equal(await fs.readFile(path.join(root,'nodu.json'),'utf8'),original);
 await assert.rejects(selectProjectChip(root,'STM32F103ZZ'),{code:'badRequest'});
});
