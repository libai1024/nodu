// SPDX-License-Identifier: MIT
require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {arduinoLanguageSpec}=require('../lib/node/nodu-arduino-language');
const {createSourceProject,parseProjectRequest}=require('../lib/node/nodu-project-generator');
test('language spec uses prepared isolated CLI config and preserves profile while allowing only owned toolchain roots',async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"nodu-lsp-'quoted-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const project=await createSourceProject(parseProjectRequest({parent:root,name:'sketch',chip:'esp32c3',template:'hello'}));
    const home=path.join(root,'home');await fs.mkdir(path.join(home,'data'),{recursive:true});await fs.writeFile(path.join(home,'arduino-cli.yaml'),'{}');
    const tool=path.join(root,'tool');await fs.writeFile(tool,'fixture');const before=await fs.readFile(path.join(project.path,'sketch.yaml'),'utf8');
    const spec=await arduinoLanguageSpec(project.path,{home,cli:tool,als:tool,clangd:tool,launcher:tool});
    assert.equal(spec.ok,true);assert.equal(spec.incrementalSync,false);assert.equal(spec.project,await fs.realpath(project.path));
    assert.equal(spec.args[spec.args.indexOf('-cli-config')+1],path.join(await fs.realpath(home),'arduino-cli.yaml'));
    if(process.platform!=='win32'){
        const script=await fs.readFile(spec.args[1],'utf8');assert.match(script,/\/internal\/\*\*/);assert.match(script,/\/packages\/\*\*/);assert.ok(script.includes("'\"'\"'"));assert(!script.includes('/project/**'));
        if(process.platform==='darwin')assert.match(script,/SDKROOT=''; export SDKROOT/);
    }
    assert.equal(await fs.readFile(path.join(project.path,'sketch.yaml'),'utf8'),before);
    await fs.writeFile(path.join(home,'arduino-cli.yaml'),'{"changed":true}');
    const changed=await arduinoLanguageSpec(project.path,{home,cli:tool,als:tool,clangd:tool,launcher:tool});assert.notEqual(changed.fingerprint,spec.fingerprint);
    const pinned=JSON.parse(await fs.readFile(path.join(__dirname,'../resources/arduino/language/tools.json'),'utf8'));
    const metadata={alsVersion:pinned.alsVersion,als:{...pinned.alsSource,binarySha256:require('node:crypto').createHash('sha256').update('fixture').digest('hex')}};
    await fs.writeFile(path.join(root,'ARDUINO-LANGUAGE-TOOLS.json'),JSON.stringify(metadata));
    const patched=await arduinoLanguageSpec(project.path,{home,cli:tool,als:tool,clangd:tool,launcher:tool});assert.equal(patched.incrementalSync,true);
    await fs.writeFile(tool,'changed fixture');const tampered=await arduinoLanguageSpec(project.path,{home,cli:tool,als:tool,clangd:tool,launcher:tool});assert.equal(tampered.incrementalSync,false);
    const missing=await arduinoLanguageSpec(project.path,{home,cli:'/missing/tool',als:tool,clangd:tool});assert.equal(missing.ok,false);
});
