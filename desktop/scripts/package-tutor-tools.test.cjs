// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const kit=require('./package-tutor-tools.cjs'),lock=require('./tutor-tools.lock.json');
const {verifyTutorToolkit,TUTOR_TOOLKIT_REQUIRED}=require('../scope-extension/lib/node/tutor/tutor-toolkit');
function fixture(t,target='darwin-arm64'){
 const desktop=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nodu-kit-test-')));t.after(()=>fs.rmSync(desktop,{recursive:true,force:true}));
 const root=kit.rootFor(desktop,target);fs.mkdirSync(root,{recursive:true});const files=[];
 for(const name of TUTOR_TOOLKIT_REQUIRED){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');files.push({path:name,size:7,sha256:crypto.createHash('sha256').update('fixture').digest('hex')});}
 const m={schema:1,version:lock.version,platform:target,archives:lock.platforms[target],files,totalBytes:files.length*7};const manifest=path.join(root,'toolkit.json');fs.writeFileSync(manifest,JSON.stringify(m));return {desktop,root,m,manifest};
}
test('packaging and runtime agree on a complete inventory and reject tampering and injected clang config',async t=>{
 const f=fixture(t);assert.equal(kit.validate(f.root,'darwin-arm64').version,lock.version);await verifyTutorToolkit(f.root);
 const original=kit.stamp(f.desktop,['darwin-arm64']);fs.writeFileSync(path.join(f.root,'sdk/bin/clang'),'damaged');assert.throws(()=>kit.validate(f.root,'darwin-arm64'));await assert.rejects(()=>verifyTutorToolkit(f.root));
 fs.writeFileSync(path.join(f.root,'sdk/bin/clang'),'fixture');assert.equal(kit.stamp(f.desktop,['darwin-arm64']),original);
 fs.writeFileSync(path.join(f.root,'sdk/bin/clang.cfg'),'--config=/outside');assert.throws(()=>kit.validate(f.root,'darwin-arm64'),/Unlisted/);await assert.rejects(()=>verifyTutorToolkit(f.root));
});
test('copies only explicitly selected architecture and refreshes hashes after binary signing',t=>{
 const arm=fixture(t),x64=fixture(t,'darwin-x64');fs.cpSync(x64.root,kit.rootFor(arm.desktop,'darwin-x64'),{recursive:true});
 const dest=path.join(arm.desktop,'app/resources');kit.copy(arm.desktop,dest,['darwin-arm64']);assert.equal(fs.existsSync(path.join(dest,'wasi/darwin-x64')),false);
 const copied=path.join(dest,'wasi/darwin-arm64');fs.writeFileSync(path.join(copied,'sdk/bin/clang'),'signed-fixture');kit.refreshManifests(path.join(arm.desktop,'app'));assert.equal(kit.validate(copied,'darwin-arm64').files.find(f=>f.path==='sdk/bin/clang').size,14);
});
test('invalid platform, traversal, external links and cancellation cannot become valid toolkit evidence',async t=>{
 const f=fixture(t);f.m.platform='darwin-x64';fs.writeFileSync(f.manifest,JSON.stringify(f.m));await assert.rejects(()=>verifyTutorToolkit(f.root));assert.throws(()=>kit.validate(f.root,'darwin-arm64'));
 f.m.platform='darwin-arm64';f.m.files[0].path='../escape';fs.writeFileSync(f.manifest,JSON.stringify(f.m));await assert.rejects(()=>verifyTutorToolkit(f.root));assert.throws(()=>kit.validate(f.root,'darwin-arm64'));
 const g=fixture(t);fs.unlinkSync(path.join(g.root,'sdk/bin/clang'));fs.symlinkSync('/bin/sh',path.join(g.root,'sdk/bin/clang'));await assert.rejects(()=>verifyTutorToolkit(g.root));assert.throws(()=>kit.validate(g.root,'darwin-arm64'));
 const h=fixture(t),controller=new AbortController();controller.abort();await assert.rejects(()=>verifyTutorToolkit(h.root,controller.signal),/取消/);
});
