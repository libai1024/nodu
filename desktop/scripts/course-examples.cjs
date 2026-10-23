// SPDX-License-Identifier: MIT
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const COURSES=['stm32f103-uart-tutor','stm32-sht30-tutor'];
const SKIP=new Set(['build','.nodu','.git','.theia','.cache','node_modules','__pycache__','.DS_Store']);
const ALLOWED=/\.(?:c|h|s|md|txt|json|cmake)$/i;
function courseFiles(desktop) {
    const files=[];let total=0;
    for(const course of COURSES){
        const root=path.join(desktop,'examples',course);
        if(!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())throw Error('Invalid course root: '+course);
        function walk(dir){
            for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
                if(SKIP.has(e.name))continue;
                const full=path.join(dir,e.name),rel=path.relative(root,full).split(path.sep).join('/');
                if(e.isSymbolicLink())throw Error('Course symlink rejected: '+rel);
                if(e.isDirectory()){walk(full);continue;}
                if(!e.isFile()||(!ALLOWED.test(e.name)&&!['.gitignore','.gitattributes','.clangd','.clang-format'].includes(e.name)))continue;
                const size=fs.statSync(full).size;total+=size;
                if(size>1024*1024||total>10*1024*1024||files.length>=2000)throw Error('Course resources exceed budget');
                files.push({source:full,path:course+'/'+rel});
            }
        }
        walk(root);
        for(const required of ['nodu.json','README.md','.nodu-tutor/plan.json'])if(!files.some(f=>f.path===course+'/'+required))throw Error('Incomplete course: '+course+'/'+required);
    }
    return files;
}
function courseExamplesStamp(desktop){const h=crypto.createHash('sha256');for(const f of courseFiles(desktop)){h.update(f.path);h.update('\0');h.update(fs.readFileSync(f.source));h.update('\0');}return h.digest('hex');}
function copyCourseExamples(desktop,destination){for(const f of courseFiles(desktop)){const to=path.join(destination,f.path);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(f.source,to);}}
module.exports={COURSES,courseFiles,courseExamplesStamp,copyCourseExamples};
