// SPDX-License-Identifier: MIT
// Test-only access to the unchanged esbuild backend's real module factories.
// No production file is rewritten and the application entry point is not run.
'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const cache=new Map();
module.exports=function loadPackagedArduino(app){
 const filename=path.join(app,'lib/backend/main.js');if(cache.has(filename))return cache.get(filename);
 const source=fs.readFileSync(filename,'utf8'),marker='// src-gen/backend/main.js\n',index=source.indexOf(marker);
 if(index<0||source.indexOf(marker,index+marker.length)!==-1)throw Error('Unrecognized packaged backend entry point');
 const code=source.slice(0,index)+`\nrequire_Reflect();\nmodule.exports={...require_nodu_arduino_server(),...require_nodu_embedded_server(),...require_nodu_project_generator(),...require_nodu_arduino_language()};\n`;
 const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded._compile(code,filename);
 loaded.exports.productionBackend={filename,sha256:crypto.createHash('sha256').update(source).digest('hex'),entryPointSuppressed:true,applicationFilesModified:false};
 cache.set(filename,loaded.exports);return loaded.exports;
};
