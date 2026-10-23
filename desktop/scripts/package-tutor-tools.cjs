// SPDX-License-Identifier: MIT
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const lock=require('./tutor-tools.lock.json');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rootFor=(desktop,target)=>path.join(desktop,'scope-extension/resources/wasi',target);
function validate(root,target,rehash=false){
 root=path.resolve(root);if(fs.lstatSync(root).isSymbolicLink())throw Error('Tutor root symlink rejected');root=fs.realpathSync(root);
 const stat=fs.lstatSync(path.join(root,'toolkit.json'));if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128000)throw Error('Invalid tutor manifest');
 const m=JSON.parse(fs.readFileSync(path.join(root,'toolkit.json'),'utf8'));
 if(!lock.platforms[target]||m.schema!==1||m.version!==lock.version||m.platform!==target||JSON.stringify(m.archives)!==JSON.stringify(lock.platforms[target])||!Array.isArray(m.files)||m.files.length>200)throw Error('Tutor tools do not match pinned platform');
 const seen=new Set();let total=0;
 for(const f of m.files){
  if(typeof f.path!=='string'||!/^(sdk|runtime|licenses)\/[a-zA-Z0-9_./-]+$/.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..')||seen.has(f.path))throw Error('Invalid tutor inventory path');
  seen.add(f.path);const file=path.join(root,f.path),s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(file)!==file||s.size>256*1024*1024)throw Error('Invalid tutor file');
  if(rehash){f.size=s.size;f.sha256=hash(file);}else if(f.size!==s.size||f.sha256!==hash(file))throw Error('Tutor file checksum mismatch: '+f.path);
  total+=s.size;
 }
 const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name),rel=path.relative(root,full).split(path.sep).join('/');if(e.isSymbolicLink())throw Error('Tutor symlink rejected');if(e.isDirectory())walk(full);else if(rel!=='toolkit.json'&&!seen.has(rel))throw Error('Unlisted tutor file');}};walk(root);
 for(const f of ['sdk/bin/clang','sdk/bin/wasm-ld','runtime/wasmtime','licenses/WASI-SDK-LICENSE','licenses/LLVM-LICENSE','licenses/Libedit-COPYING','licenses/Wasmtime-LICENSE','licenses/SOURCES.json'])if(!seen.has(f))throw Error('Missing tutor tool/license: '+f);
 if(total>1024**3||!rehash&&total!==m.totalBytes)throw Error('Invalid tutor size');m.totalBytes=total;return m;
}
function copy(desktop,resources,targets){
 for(const target of targets){const root=rootFor(desktop,target);validate(root,target);fs.cpSync(root,path.join(resources,'wasi',target),{recursive:true,errorOnExist:true});}
}
function stamp(desktop,targets){const h=crypto.createHash('sha256');for(const target of targets){const root=rootFor(desktop,target);validate(root,target);h.update(fs.readFileSync(path.join(root,'toolkit.json')));}return h.digest('hex');}
function refreshManifests(app){
 const visit=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name);if(e.isDirectory())visit(full);else if(e.name==='toolkit.json'&&path.basename(path.dirname(dir))==='wasi'){const m=validate(dir,path.basename(dir),true);fs.writeFileSync(full,JSON.stringify(m,null,2)+'\n');}}};visit(app);
}
module.exports={rootFor,validate,copy,stamp,refreshManifests};
