// SPDX-License-Identifier: MIT
// Reproducible build of the bundled, modified ALS source. No Go installation is required at runtime.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),resources=path.join(root,'scope-extension/resources/arduino/language');
const catalog=JSON.parse(fs.readFileSync(path.join(resources,'tools.json'),'utf8'));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function buildArduinoLanguageServer(host,archive,unzip){
    const cache=path.join(root,'.tools/arduino-language'),sourceAsset=catalog.alsSource;
    for(const [name,digest] of [[sourceAsset.archive,sourceAsset.sha256],[sourceAsset.patch,sourceAsset.patchSha256]])
        if(sha(fs.readFileSync(path.join(resources,name)))!==digest)throw new Error(`Modified ALS source checksum mismatch: ${name}`);
    const buildHost=`${process.platform}-${process.arch}`,goAsset=catalog.go[buildHost];
    if(!goAsset)throw new Error(`No pinned Go builder for ${buildHost}`);
    const goArchive=await archive(goAsset),goRoot=path.join(cache,`go-${catalog.goVersion}-${buildHost}`),go=path.join(goRoot,'go/bin',process.platform==='win32'?'go.exe':'go');
    const unpack=async(file,dest)=>{fs.mkdirSync(dest,{recursive:true});if(file.endsWith('.zip'))await unzip(file,dest);else await require('tar').x({file,cwd:dest,strict:true,filter:(name,entry)=>!path.isAbsolute(name)&&!name.split('/').includes('..')&&!['SymbolicLink','Link'].includes(entry.type)});};
    if(!fs.existsSync(go))await unpack(goArchive,goRoot);
    const sourceRoot=path.join(cache,`source-${sourceAsset.sha256.slice(0,16)}`);
    if(!fs.existsSync(path.join(sourceRoot,'arduino-language-server-nodu.1/go.mod')))await unpack(path.join(resources,sourceAsset.archive),sourceRoot);
    const source=path.join(sourceRoot,'arduino-language-server-nodu.1');
    const env={...process.env,GOTOOLCHAIN:'local',GOPROXY:'off',CGO_ENABLED:'0',GOMODCACHE:path.join(cache,'go-mod'),GOCACHE:path.join(cache,'go-cache'),GOPATH:path.join(cache,'go-path')};
    // Include vendored regressions explicitly: ./... intentionally skips vendor packages.
    execFileSync(go,['test','-mod=vendor','./...','./vendor/go.bug.st/lsp/textedits'],{cwd:source,env,stdio:'inherit'});
    const target={ 'darwin-arm64':['darwin','arm64'],'darwin-x64':['darwin','amd64'],'linux-x64':['linux','amd64'],'win32-x64':['windows','amd64'] }[host];
    if(!target)throw new Error(`Unsupported ALS target: ${host}`);
    const dest=path.join(cache,`patched-${host}`);fs.mkdirSync(dest,{recursive:true});
    const binary=path.join(dest,`arduino-language-server${host.startsWith('win32')?'.exe':''}`),temporary=`${binary}.${process.pid}.tmp`;
    const namespace='github.com/arduino/arduino-language-server/version';
    try{execFileSync(go,['build','-trimpath','-buildvcs=false','-mod=vendor','-ldflags',`-X ${namespace}.versionString=${catalog.alsVersion} -X ${namespace}.commit=${sourceAsset.commit} -X ${namespace}.date=${sourceAsset.date}`,'-o',temporary,'.'],{cwd:source,env:{...env,GOOS:target[0],GOARCH:target[1]},stdio:'inherit'});fs.renameSync(temporary,binary);}finally{fs.rmSync(temporary,{force:true});}
    return {binary,metadata:{...sourceAsset,goVersion:catalog.goVersion,binarySha256:sha(fs.readFileSync(binary))}};
}
module.exports={buildArduinoLanguageServer};
