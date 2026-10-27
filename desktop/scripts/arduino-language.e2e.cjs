// SPDX-License-Identifier: MIT
// Opt-in real LSP test. Uses a prepared NODU_ARDUINO_HOME and never contacts a serial port.
require('reflect-metadata');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawn}=require('node:child_process');
const vm=require('node:vm'),fsSync=require('node:fs');
const {restrictArduinoCapabilities}=require('./arduino-language-capabilities.cjs');
const {arduinoLineChange,arduinoPatchedChange,createArduinoResyncGate}=require('./arduino-language-sync.cjs');
const {NoduArduinoLanguageServer}=require('../scope-extension/lib/node/nodu-arduino-language');
const {createSourceProject,parseProjectRequest}=require('../scope-extension/lib/node/nodu-project-generator');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const throughMiddleware=process.argv.includes('--middleware'),guiSequence=process.argv.includes('--gui-sequence');
const edgeOnly=process.argv.includes('--edge-only'), incremental=process.argv.includes('--incremental');
function exactChange(before,after){let start=0,end=before.length,last=after.length;while(start<end&&start<last&&before[start]===after[start])start++;if(start>0&&/[\uDC00-\uDFFF]/.test(before[start]||after[start]||''))start--;while(end>start&&last>start&&before[end-1]===after[last-1]){end--;last--;}if(/[\uDC00-\uDFFF]/.test(before[end]||after[last]||'')){end++;last++;}const pos=offset=>{const lines=before.slice(0,offset).split('\n');return {line:lines.length-1,character:lines.at(-1).length};};return {range:{start:pos(start),end:pos(end)},text:after.slice(start,last)};}
async function run(chip,root){
    const name=`lsp_${chip}`,parent=path.join(root,`${chip}-${Date.now()}`);await fs.mkdir(parent,{recursive:true});
    const project=await createSourceProject(parseProjectRequest({parent,name,chip,template:'empty'}));
    let source=['#include <Arduino.h>','#include <ArduinoJson.h>','int twice(int value) { return value * 2; }','void setup() {','  Serial.begin(115200);','  JsonDocument doc;','  doc["ok"] = 1;','  Serial.println(twice(2));','}','void loop() {','  Serial.println("tick");','}',''].join('\n');
    if(guiSequence){source=JSON.parse(fsSync.readFileSync(path.join(__dirname,'arduino-language-plugin/gui-sync-fixture.json'),'utf8'))[0].before;await fs.writeFile(path.join(project.path,'review-helper.h'),'#pragma once\ninline int reviewValue() { return 42; }\n');}
    const file=path.join(project.path,`${name}.ino`);await fs.writeFile(file,source);
    const spec=await new NoduArduinoLanguageServer().spec({path:project.path});assert.equal(spec.ok,true,spec.error);
    const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('ARDUINO_'))),...spec.environment};
    const child=spawn(spec.command,spec.args,{cwd:spec.project,env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let buffer=Buffer.alloc(0),stderr='',sequence=0,currentText=source;const pending=new Map(),messages=[],resync=createArduinoResyncGate();
    child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString('utf8')).slice(-8*1024*1024);});
    function send(message){const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',...message}));child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`);child.stdin.write(bytes);}
    function wireRequest(method,params,timeout=120000){const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`LSP timeout: ${method}`));},timeout);pending.set(id,{resolve,reject,timer});send({id,method,params});});}
    child.stdout.on('data',bytes=>{
        buffer=Buffer.concat([buffer,bytes]);
        while(true){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const match=/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,end).toString());if(!match)throw new Error('Invalid LSP header');const length=Number(match[1]);if(buffer.length<end+4+length)return;
            const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);messages.push(message);
            if(message.method==='$/progress'){resync.progress(message.params.token,message.params.value);middleware?.handleWorkDoneProgress(message.params.token,message.params.value,()=>{});}
            if(message.method&&message.id!==undefined){send({id:message.id,result:message.method==='workspace/configuration'?[]:null});}
            else if(message.id!==undefined){const p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);if(message.error)p.reject(new Error(JSON.stringify(message.error)));else p.resolve(message.result);}}
        }
    });
    const closed=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Language server exited'));}pending.clear();};child.on('error',closed);child.on('exit',closed);
    const uri=pathToFileURL(file).href;let result,middleware,adapter;
    const document={uri:{fsPath:file,scheme:'file',toString:()=>uri},version:1,languageId:'cpp',getText:()=>currentText};
    if(throughMiddleware){
        const commands=new Map(),disposable={dispose(){}};
        class Client {constructor(_id,_name,_server,options){middleware=options.middleware;}registerFeature(){}onDidChangeState(){return disposable;}async start(){}async stop(){}async sendNotification(method,params){send({method,params});}}
        const vscode={commands:{registerCommand(name,handler){commands.set(name,handler);return disposable;}},Uri:{file:value=>({fsPath:value,scheme:'file'})},workspace:{textDocuments:[document],createFileSystemWatcher:()=>({dispose(){},onDidChange:()=>disposable,onDidCreate:()=>disposable,onDidDelete:()=>disposable})},window:{createOutputChannel:()=>({appendLine:line=>{stderr+='\nADAPTER '+line;},dispose(){}})}};
        const sandbox={exports:{},process,setTimeout,clearTimeout,require(name){if(name==='vscode')return vscode;if(name==='vscode-languageclient/node')return {LanguageClient:Client};return require(name);}};
        vm.runInNewContext(fsSync.readFileSync(path.join(__dirname,'arduino-language-adapter.cjs'),'utf8'),sandbox);adapter=sandbox.exports;adapter.activate({subscriptions:[]});await commands.get('nodu.arduino.language.start')({...spec,incrementalSync:true});
    }
    const providers={'textDocument/hover':'provideHover','textDocument/completion':'provideCompletionItem','textDocument/definition':'provideDefinition'};
    function request(method,params,timeout=120000){const provider=middleware&&providers[method];return provider?middleware[provider](document,params.position,{},()=>wireRequest(method,params,timeout)):wireRequest(method,params,timeout);}
    function save(text){return middleware?middleware.didSave(document,()=>{send({method:'textDocument/didSave',params:{textDocument:{uri},text}});}):send({method:'textDocument/didSave',params:{textDocument:{uri},text}});}

    function change(text,version){if(middleware){const contentChange=exactChange(currentText,text);currentText=text;document.version=version;return middleware.didChange({document,contentChanges:[contentChange]},event=>{send({method:'textDocument/didChange',params:{textDocument:{uri,version},contentChanges:event.contentChanges}});});}if(process.argv.includes('--raw-incremental')){const update=exactChange(currentText,text);currentText=text;send({method:'textDocument/didChange',params:{textDocument:{uri,version},contentChanges:[update]}});return;}const update=(incremental?arduinoPatchedChange:arduinoLineChange)(currentText,text);currentText=text;if(!update)return;
        if(update.reopen||resync.isPending()){resync.mark();send({method:'textDocument/didClose',params:{textDocument:{uri}}});send({method:'textDocument/didOpen',params:{textDocument:{uri,version,languageId:'cpp',text}}});}
        else send({method:'textDocument/didChange',params:{textDocument:{uri,version},contentChanges:[update.change]}});
    }
    async function rebuilt(){const deadline=Date.now()+90000;while(resync.isPending()&&Date.now()<deadline)await wait(100);assert.equal(resync.isPending(),false,'Actual ALS rebuild did not finish');}
    try{
        const capabilities=restrictArduinoCapabilities({workspace:{configuration:true,applyEdit:true,semanticTokens:{refreshSupport:true}},textDocument:{semanticTokens:{requests:{full:{delta:true},range:true},tokenTypes:['variable'],tokenModifiers:[],formats:['relative']},completion:{dynamicRegistration:true,completionItem:{snippetSupport:true}}},window:{workDoneProgress:true,showDocument:{support:true}}});
        const initialized=await request('initialize',{processId:process.pid,rootUri:pathToFileURL(project.path).href,workspaceFolders:[{uri:pathToFileURL(project.path).href,name}],capabilities});
        assert.equal(initialized.capabilities.textDocumentSync.change,2);
        send({method:'initialized',params:{}});const opened=()=>send({method:'textDocument/didOpen',params:{textDocument:{uri,languageId:'cpp',version:1,text:source}}});if(middleware)await middleware.didOpen(document,opened);else opened();
        if(guiSequence){
            const events=JSON.parse(fsSync.readFileSync(path.join(__dirname,'arduino-language-plugin/gui-sync-fixture.json'),'utf8'));
            async function tails(text){const values={};for(const token of ['JsonDocument','serializeJson','void loop']){const lines=text.split('\n'),line=lines.findIndex(line=>line.includes(token));const at=lines[line].indexOf(token)+(token==='void loop'?6:2);const value=await request('textDocument/hover',{textDocument:{uri},position:{line,character:at}});assert.match(value?.contents?.value||'',new RegExp(token==='void loop'?'loop':token));assert.equal(value.range.start.line,line);values[token]=line+1;}return values;}
            await tails(source);const timings=[];for(const [i,event] of events.entries()){const start=Date.now();assert(arduinoPatchedChange(currentText,event.after).change,event.name+' must remain incremental');change(event.after,i+2);await fs.writeFile(file,event.after);await save(event.after);const lines=await tails(event.after);timings.push({name:event.name,ms:Date.now()-start,lines});}
            // Overlap a real running rebuild with structural paste/undo/redo.
            const progressStart=messages.length;change(currentText.replace('body-edit','body-edit-again'),4);await save(currentText);
            const startLimit=Date.now()+10000;while(!messages.slice(progressStart).some(m=>m.method==='$/progress'&&m.params.token==='arduinoLanguageServerRebuild'&&m.params.value.kind==='begin')&&Date.now()<startLimit)await wait(20);
            assert(messages.slice(progressStart).some(m=>m.method==='$/progress'&&m.params.value.kind==='begin'),'No overlapping background rebuild');
            const earlier=currentText,latest='// Top-level paste 😀\n\n'+earlier;change(latest,5);change(earlier,6);change(latest,7);const overlapAt=Date.now();await fs.writeFile(file,latest);await save(latest);const finalLines=await tails(latest);
            result={chip,ok:true,middleware:true,server:initialized.serverInfo,guiEnterPaste:timings,overlapUndoRedoMs:Date.now()-overlapAt,finalLines,project:project.path};
        }else{

        const hover=await request('textDocument/hover',{textDocument:{uri},position:{line:5,character:4}});assert.match(hover.contents.value,/JsonDocument/);assert.equal(hover.range.start.line,5);
        const completion=await request('textDocument/completion',{textDocument:{uri},position:{line:10,character:9},context:{triggerKind:1}});const items=completion.items??completion;assert(items.some(item=>item.label.includes('println')));
        const definition=await request('textDocument/definition',{textDocument:{uri},position:{line:7,character:source.split('\n')[7].indexOf('twice')+1}});
        const location=(Array.isArray(definition)?definition[0]:definition);assert.equal(location.uri??location.targetUri,uri);assert.equal((location.range??location.targetSelectionRange).start.line,2);
        await wait(1000);const baseline=messages.filter(m=>m.method==='textDocument/publishDiagnostics').flatMap(m=>m.params.diagnostics.map(d=>({...d,uri:m.params.uri})));assert.equal(baseline.filter(d=>d.severity===1).length,0,JSON.stringify(baseline));
        if(!edgeOnly){
        const bodyText=source.replace('  Serial.println("tick");','  Serial.println("tick");\n  int body_value = 7;\n  Serial.println(body_value);');
        const bodyAt=Date.now();const bodyUpdate=arduinoPatchedChange(currentText,bodyText);assert(bodyUpdate.change,'Body multiline insert must stay incremental');change(bodyText,2);
        const bodyHover=await request('textDocument/hover',{textDocument:{uri},position:{line:11,character:8}});assert.match(bodyHover.contents.value,/body_value/);assert.equal(bodyHover.range.start.line,11);
        const bodyMultilineHoverMs=Date.now()-bodyAt;change(source,3);await rebuilt();
        const editedAt=Date.now();let unicodeHoverMs,replaceHoverMs;
        let previousLine=source.split('\n')[10];
        for(let i=0;i<12;i++){
            const text=`  Serial.println("测试 😀 ${i}");`;
            const lines=currentText.split('\n');lines[10]=text;change(lines.join('\n'),i+4);
            previousLine=text;await wait(40);
        }
        await rebuilt();
        await request('textDocument/hover',{textDocument:{uri},position:{line:5,character:4}});unicodeHoverMs=Date.now()-editedAt;
        {const lines=currentText.split('\n');lines[10]='  missing_function();';change(lines.join('\n'),16);}await rebuilt();
        const deadline=Date.now()+45000;let diagnostics=[];
        while(Date.now()<deadline){diagnostics=messages.filter(m=>m.method==='textDocument/publishDiagnostics'&&m.params.uri===uri).flatMap(m=>m.params.diagnostics);if(diagnostics.some(d=>d.message.includes('missing_function')))break;await wait(250);}
        const diagnostic=diagnostics.find(d=>d.message.includes('missing_function'));assert(diagnostic,'No diagnostics for unsaved .ino edit');assert.equal(diagnostic.range.start.line,10);
        assert.equal(await fs.readFile(file,'utf8'),source,'Unsaved LSP edit must not change disk source');
        const replacement=['#include <Arduino.h>','#include <ArduinoJson.h>','// 整份替换并保存 😀','','void setup() {','  Serial.begin(115200);','  JsonDocument doc;','  doc["ready"] = true;','  Serial.println("ready");','}','','void loop() {','  Serial.println("tick");','  delay(100);','}',''].join('\n');
        const replacedAt=Date.now();change(replacement,17);
        await fs.writeFile(file,replacement);await save(replacement);
        await rebuilt();
        const replacementHover=await request('textDocument/hover',{textDocument:{uri},position:{line:6,character:4}});assert.match(replacementHover.contents.value,/JsonDocument/);assert.equal(replacementHover.range.start.line,6);replaceHoverMs=Date.now()-replacedAt;
        const replacementCompletion=await request('textDocument/completion',{textDocument:{uri},position:{line:12,character:9},context:{triggerKind:1}});assert((replacementCompletion.items??replacementCompletion).some(item=>item.label.includes('println')));
        result={chip,ok:true,incremental,bodyMultilineHoverMs,unicodeHoverMs,replaceHoverMs,server:initialized.serverInfo,hoverLine:6,completionItems:items.length,definitionLine:3,unsavedDiagnosticLine:11,rapidUnicodeEdits:12,replaceAllAndSave:true,replacedHoverLine:7,baselineErrors:0,sourceMapping:'original .ino',project:project.path};
        }else{
            const edge=['#include <Arduino.h>','void setup() { Serial.begin(115200); }','void loop() {}','/* 😀 */ void edge_old() { Serial.println("ok"); }'].join('\n');
            change(edge,20);await rebuilt();
            const line=edge.split('\n')[3],column=line.indexOf('Serial.')+7;
            const edgeCompletion=await request('textDocument/completion',{textDocument:{uri},position:{line:3,character:column},context:{triggerKind:1}});
            const edgeItem=(edgeCompletion.items??edgeCompletion).find(item=>item.label.includes('println'));assert(edgeItem,'No completion after same-line emoji prefix');assert.equal(edgeItem.textEdit.range.start.character,column);
            const broken=edge.replace('edge_old','edge_new').replace('Serial.println("ok");','missing_edge();');
            const messageStart=messages.length;change(broken,21);await rebuilt();
            const edgeHover=await request('textDocument/hover',{textDocument:{uri},position:{line:3,character:broken.split('\n')[3].indexOf('edge_new')+2}});assert.match(edgeHover.contents.value,/edge_new/);
            const limit=Date.now()+15000;let bad;
            while(Date.now()<limit){bad=messages.slice(messageStart).filter(m=>m.method==='textDocument/publishDiagnostics'&&m.params.uri===uri).at(-1)?.params.diagnostics.find(d=>d.message.includes('missing_edge'));if(bad)break;await wait(100);}
            assert(bad,'No current diagnostic after EOF Unicode change');assert.equal(bad.range.start.line,3);assert.equal(bad.range.start.character,broken.split('\n')[3].indexOf('missing_edge'));
            const undoStart=messages.length;change(edge,22);await rebuilt();
            const undoHover=await request('textDocument/hover',{textDocument:{uri},position:{line:3,character:line.indexOf('edge_old')+2}});assert.match(undoHover.contents.value,/edge_old/);
            const undoLimit=Date.now()+15000;let clean;
            while(Date.now()<undoLimit){clean=messages.slice(undoStart).filter(m=>m.method==='textDocument/publishDiagnostics'&&m.params.uri===uri).at(-1)?.params.diagnostics;if(clean&&!clean.some(d=>d.severity===1))break;await wait(100);}
            assert(clean&&!clean.some(d=>d.severity===1),'Undo retains stale diagnostic');assert(!currentText.endsWith('\n'));assert.equal(await fs.readFile(file,'utf8'),source);
            result={chip,ok:true,incremental,server:initialized.serverInfo,noFinalNewline:true,sameLineEmojiCompletionColumn:column,sameLineEmojiDiagnosticColumn:bad.range.start.character,undoCurrentHover:true,undoClearsDiagnostic:true,unsavedDiskUnchanged:true,project:project.path};
        }
        }
        await request('shutdown',null,5000).catch(()=>{});send({method:'exit',params:null});
    }catch(error){result={chip,ok:false,error:error.stack,project:project.path};throw error;}
    finally{
        if(adapter)await adapter.deactivate();
        for(const p of pending.values())clearTimeout(p.timer);pending.clear();
        if(child.exitCode===null){if(process.platform==='win32')child.kill();else {try{process.kill(-child.pid,'SIGTERM');}catch{}}}
        await fs.writeFile(path.join(root,`${chip}-result.json`),JSON.stringify(result,null,2)+'\n');await fs.writeFile(path.join(root,`${chip}-stderr.txt`),stderr);
        await fs.writeFile(path.join(root,`${chip}-messages.json`),JSON.stringify(messages,null,2)+'\n');
    }
    return result;
}
(async()=>{if(!process.env.NODU_ARDUINO_HOME)throw new Error('Set NODU_ARDUINO_HOME to a prepared isolated Arduino environment.');
    const root=path.resolve(process.argv.find(arg=>arg.startsWith('--evidence='))?.slice(11)||path.join(process.env.NODU_ARDUINO_HOME,'language-e2e'));await fs.mkdir(root,{recursive:true});
    const chips=process.argv.find(arg=>arg.startsWith('--chips='))?.slice(8).split(',')||['esp32c3','esp32s3'];assert(chips.every(chip=>['esp32c3','esp32s3'].includes(chip)));
    const results=[];for(const chip of chips){const result=await run(chip,root);results.push(result);console.log(JSON.stringify(result));}
    await fs.writeFile(path.join(root,'result.json'),JSON.stringify({schema:1,results},null,2)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
