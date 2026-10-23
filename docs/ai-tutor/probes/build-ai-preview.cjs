// SPDX-License-Identifier: MIT
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const output=path.resolve(__dirname,'../../../artifacts/ai-tutor-m0/ai-probe');
fs.mkdirSync(output,{recursive:true});
fs.copyFileSync(__dirname+'/cline-preview.tsx',output+'/cline-preview.tsx');
fs.copyFileSync(__dirname+'/cline-preview.html',output+'/index.html');
const root=path.resolve(__dirname,'../../..');const esbuild=require(root+'/desktop/node_modules/esbuild');
(async()=>{const options={bundle:true,platform:'browser',format:'iife',target:'es2022',minify:true,metafile:true,nodePaths:[root+'/desktop/node_modules'],define:{'process.env.NODE_ENV':'"production"'}};
 const built=await esbuild.build({...options,entryPoints:[output+'/cline-preview.tsx'],outfile:output+'/preview.js'});fs.writeFileSync(output+'/preview.meta.json',JSON.stringify(built.metafile,null,2));
 const measured=await esbuild.build({...options,entryPoints:[output+'/packages/cline-ui/dist/components/agent-chat/index.js'],external:['react','react/jsx-runtime'],format:'esm',outfile:output+'/cline-ui-only.js'});
 const reactRoots=[...new Set(Object.keys(built.metafile.inputs).filter(p=>/node_modules\/react\//.test(p)).map(p=>p.split('/node_modules/react/')[0]))];
 if(reactRoots.length!==1)throw Error('React duplicated');
 const stats={node:process.version,react:require(root+'/desktop/node_modules/react/package.json').version,reactRoots,monacoInputs:Object.keys(built.metafile.inputs).filter(p=>p.includes('monaco')),previewJsBytes:fs.statSync(output+'/preview.js').size,uiOnlyMinifiedBytes:fs.statSync(output+'/cline-ui-only.js').size,uiOnlyGzipBytes:zlib.gzipSync(fs.readFileSync(output+'/cline-ui-only.js')).length,cssBytes:fs.statSync(output+'/packages/cline-ui/components/agent-chat/agent-chat.css').size};
 fs.writeFileSync(output+'/bundle-results.json',JSON.stringify(stats,null,2)+'\n');console.log(stats);
})();
