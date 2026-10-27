// SPDX-License-Identifier: MIT
// Build-time download only. SHA-256 pins are committed in resources/arduino/language/tools.json.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const resources = path.join(root,'scope-extension/resources');
const catalog = JSON.parse(fs.readFileSync(path.join(resources,'arduino/language/tools.json'),'utf8'));
const host = process.argv.find(arg=>arg.startsWith('--host='))?.slice(7) || `${process.platform}-${process.arch}`;
const platform = host.split('-')[0];
const cache = path.join(root,'.tools/arduino-language');
const sha = bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function archive(asset) {
    if(!asset) throw new Error(`No pinned Arduino language tools for ${host}`);
    fs.mkdirSync(cache,{recursive:true});const file=path.join(cache,asset.archive);
    if(!fs.existsSync(file)) {
        let bytes;
        for(let attempt=0;attempt<3;attempt++) {
            try {
                const response=await fetch(asset.url,{signal:AbortSignal.timeout(90000)});if(!response.ok)throw new Error(`Download failed: ${response.status}`);
                const chunks=[];let size=0;
                for await(const chunk of response.body){size+=chunk.length;if(size>128*1024*1024)throw new Error('Language archive exceeds 128 MiB');chunks.push(chunk);}
                bytes=Buffer.concat(chunks);if(sha(bytes)!==asset.sha256)throw new Error('Language archive checksum mismatch');break;
            }catch(error){if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}
        }
        const temporary=`${file}.${process.pid}.tmp`;try{fs.writeFileSync(temporary,bytes);fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
    }
    if(sha(fs.readFileSync(file))!==asset.sha256)throw new Error('Cached language archive checksum mismatch');return file;
}
async function unzip(file,dest) {
    await new Promise((resolve,reject)=>require('yauzl').open(file,{lazyEntries:true},(error,zip)=>{
        if(error)return reject(error);zip.on('error',reject);zip.on('end',resolve);
        zip.on('entry',entry=>{
            if(path.isAbsolute(entry.fileName)||entry.fileName.split('/').includes('..')||((entry.externalFileAttributes>>>16)&0o170000)===0o120000)return reject(new Error('Unsafe language archive entry'));
            const target=path.join(dest,entry.fileName);if(entry.fileName.endsWith('/')){fs.mkdirSync(target,{recursive:true});zip.readEntry();return;}
            fs.mkdirSync(path.dirname(target),{recursive:true});zip.openReadStream(entry,(error,input)=>{if(error)return reject(error);const out=fs.createWriteStream(target);input.on('error',reject);out.on('error',reject);out.on('finish',()=>zip.readEntry());input.pipe(out);});
        });zip.readEntry();
    }));
}
function locate(root,name) { for(const entry of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,entry.name);if(entry.isFile()&&entry.name===name)return p;if(entry.isDirectory()){const found=locate(p,name);if(found)return found;}} }
async function main(){
    const exe=platform==='win32'?'.exe':'',dest=path.join(resources,'bin',host),metadataFile=path.join(dest,'ARDUINO-LANGUAGE-TOOLS.json');
    try {
        const existing=JSON.parse(fs.readFileSync(metadataFile,'utf8'));
        if(existing.host===host&&existing.alsVersion===catalog.alsVersion&&existing.als.sha256===catalog.alsSource.sha256&&existing.als.patchSha256===catalog.alsSource.patchSha256&&existing.clangd.sha256===catalog.clangd[platform]?.sha256
            &&sha(fs.readFileSync(path.join(dest,`arduino-language-server${exe}`)))===existing.als.binarySha256
            &&sha(fs.readFileSync(path.join(dest,'arduino-clangd/bin',`clangd${exe}`)))===existing.clangd.binarySha256
            &&fs.existsSync(path.join(dest,'arduino-clangd/lib/clang/21/include/stddef.h'))
            &&(platform!=='win32'||fs.existsSync(path.join(dest,'arduino-clangd-launcher.exe')))) {
            console.log(`Verified cached Arduino language tools for ${host}`);return;
        }
    }catch{/* Prepare or repair missing build outputs from pinned archives. */}
    const patched=await require('./build-arduino-language-server.cjs').buildArduinoLanguageServer(host,archive,unzip);
    const clangArchive=await archive(catalog.clangd[platform]);
    const stage=path.join(cache,`staging-${host}`);fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});
    const clangStage=path.join(stage,'clangd');fs.mkdirSync(clangStage);
    await unzip(clangArchive,clangStage);
    const als=patched.binary,clang=locate(clangStage,`clangd${exe}`);
    if(!als||!clang)throw new Error('Language tools missing from verified archive');
    fs.mkdirSync(dest,{recursive:true});
    const target=path.join(dest,`arduino-language-server${exe}`),temporary=`${target}.${process.pid}.tmp`;
    try{fs.copyFileSync(als,temporary);fs.chmodSync(temporary,0o755);fs.renameSync(temporary,target);}finally{fs.rmSync(temporary,{force:true});}
    const clangRoot=path.dirname(path.dirname(clang)),clangDest=path.join(dest,'arduino-clangd'),clangTemporary=`${clangDest}.${process.pid}.tmp`,clangPrevious=`${clangDest}.${process.pid}.previous`;
    try{fs.cpSync(clangRoot,clangTemporary,{recursive:true});fs.chmodSync(path.join(clangTemporary,'bin',`clangd${exe}`),0o755);if(fs.existsSync(clangDest))fs.renameSync(clangDest,clangPrevious);fs.renameSync(clangTemporary,clangDest);fs.rmSync(clangPrevious,{recursive:true,force:true});}
    catch(error){if(!fs.existsSync(clangDest)&&fs.existsSync(clangPrevious))fs.renameSync(clangPrevious,clangDest);throw error;}
    finally{fs.rmSync(clangTemporary,{recursive:true,force:true});}
    if(platform==='win32'){
        if(process.platform!=='win32')throw new Error('Windows language launcher must be built on Windows with a C compiler');
        const launcher=path.join(dest,'arduino-clangd-launcher.exe');
        if(process.env.CC==='cl')execFileSync('cl',['/nologo','/O2',path.join(__dirname,'arduino-clangd-launcher.c'),`/Fe:${launcher}`],{stdio:'inherit'});
        else execFileSync(process.env.CC||'clang',['-O2',path.join(__dirname,'arduino-clangd-launcher.c'),'-o',launcher],{stdio:'inherit'});
    }
    fs.writeFileSync(path.join(dest,'ARDUINO-LANGUAGE-TOOLS.json'),JSON.stringify({host,alsVersion:catalog.alsVersion,clangdVersion:catalog.clangdVersion,
        als:patched.metadata,clangd:{...catalog.clangd[platform],binarySha256:sha(fs.readFileSync(clang))}},null,2)+'\n');
    console.log(`Bundled Arduino Language Server ${catalog.alsVersion} and clangd ${catalog.clangdVersion} for ${host}`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
