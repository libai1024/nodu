// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('Arduino sync preserves UTF-16 text, final newlines, paste, undo and only accepts the latest rebuild',async()=>{
    const {arduinoLineChange,createArduinoResyncGate}=require('./arduino-language-sync.cjs');
    const cases=[['void loop() {}\n','void loop() { }\n'],['abc','abXc'],['void f()\r\n','void g()\r\n'],
        ['// 中文😀\nvoid f() {}\n','// 中文😀改\nvoid f() {}\n'],['// 😀','// 新😀'],['one\ntwo\n','paste\nnew\ntext'],['paste\nnew\ntext','one\ntwo\n'],['','x'],['x','']];
    const offset=(text,position)=>{const lines=text.split('\n');assert(position.line<lines.length);assert(position.character<=lines[position.line].length);return lines.slice(0,position.line).reduce((n,line)=>n+line.length+1,0)+position.character;};
    for(const [before,after] of cases){const update=arduinoLineChange(before,after);assert(update);if(update.change){const {range,text}=update.change;assert.equal(before.slice(0,offset(before,range.start))+text+before.slice(offset(before,range.end)),after);}else assert.equal(update.reopen,true);}
    for(const after of ['a','ab','abc','abcd'])assert(arduinoLineChange(after.slice(0,-1),after));
    const gate=createArduinoResyncGate();gate.mark();gate.progress('arduinoLanguageServerRebuild',{kind:'begin'});gate.mark();gate.progress('arduinoLanguageServerRebuild',{kind:'end'});assert.equal(gate.isPending(),true);
    const ready=gate.wait();gate.progress('arduinoLanguageServerRebuild',{kind:'begin'});gate.progress('arduinoLanguageServerRebuild',{kind:'end'});await ready;assert.equal(gate.isPending(),false);
});
test('Arduino LSP is lazy, scoped to one project, reuses identical spec and disposes switched sessions', async () => {
    const commands = new Map(), clients = [], output = [], events = []; let disposed = 0;
    const vscode = { commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() { commands.delete(name); } }; } },
        Uri: { file: value => ({ fsPath: value, scheme: 'file' }) }, RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        workspace: { textDocuments: [], createFileSystemWatcher: () => { const callbacks={};events.push(callbacks);return {
            onDidChange(handler){callbacks.change=handler;return {dispose(){}};},onDidCreate(handler){callbacks.create=handler;return {dispose(){}};},onDidDelete(handler){callbacks.delete=handler;return {dispose(){}};},dispose() { disposed++; } }; } },
        window: { createOutputChannel: () => ({ appendLine(line) { output.push(line); }, dispose() { disposed++; } }) } };
    class Client { constructor(...args) { this.args=args; this.notifications=[];clients.push(this); } onDidChangeState(){return {dispose(){}};} async sendNotification(method,params){this.notifications.push({method,params});} registerFeature(feature) { this.feature=feature; } async start() { this.started=true; } async stop() { this.stopped=true; } }
    const timers=[];
    vscode.commands.executeCommand=(name,...args)=>commands.get(name)(...args);
    const context={subscriptions:[]}, sandbox={exports:{},setTimeout:callback=>{timers.push(callback);return callback;},clearTimeout:callback=>{const i=timers.indexOf(callback);if(i>=0)timers.splice(i,1);},process:{env:{ARDUINO_DIRECTORIES_DATA:'/wrong',KEEP:'yes'}},require(name){
        if(name==='vscode')return vscode;if(name==='vscode-languageclient/node')return {LanguageClient:Client};if(name==='node:fs')return {existsSync:()=>true};if(name==='node:path')return {...path,isAbsolute:value=>path.isAbsolute(value)||path.win32.isAbsolute(value)};if(['./arduino-language-capabilities.cjs','./arduino-language-sync.cjs'].includes(name))return require(name);throw new Error(name);
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'arduino-language-adapter.cjs'),'utf8'),sandbox);sandbox.exports.activate(context);
    assert.equal(clients.length,0);
    const spec={ok:true,command:'/tools/als',project:'/project',args:['-fqbn','esp32:esp32:esp32c3'],fingerprint:'one'};
    await commands.get('nodu.arduino.language.start')(spec);await commands.get('nodu.arduino.language.start')(spec);
    assert.equal(clients.length,1);assert.equal(clients[0].args[2].options.env.ARDUINO_DIRECTORIES_DATA,undefined);
    assert.equal(clients[0].args[3].documentSelector[0].pattern,'/project/**/*.{ino,pde,c,cpp,cxx,cc,h,hpp}');
    assert.equal(clients[0].args[3].synchronize,undefined,'ALS must never receive workspace/didChangeWatchedFiles');
    const uri={fsPath:'/project/header.h',toString:()=> 'file:///project/header.h'};
    vscode.workspace.textDocuments.push({uri,isClosed:false});events[0].change(uri);assert.equal(timers.length,0,'Open source edits stay on didChange/didSave');
    vscode.workspace.textDocuments=[];events[0].change(uri);assert.equal(timers.length,1,'Closed header changes schedule a fresh session');
    events[0].create(uri);assert.equal(timers.length,1,'Structural changes coalesce');
    const capabilities={workspace:{semanticTokens:{refreshSupport:true},configuration:true,applyEdit:true},window:{showDocument:{support:true}},textDocument:{semanticTokens:{dynamicRegistration:true},completion:{dynamicRegistration:true,snippetSupport:true}}};
    clients[0].feature.fillClientCapabilities(capabilities);
    assert.equal(capabilities.workspace.semanticTokens.refreshSupport,false);assert.equal(capabilities.workspace.configuration,false);
    assert.equal(capabilities.workspace.applyEdit,false);assert.equal(capabilities.window.showDocument.support,false);
    assert.equal(capabilities.textDocument.semanticTokens,undefined);assert.equal(capabilities.textDocument.completion.dynamicRegistration,false);
    assert.equal(capabilities.textDocument.completion.snippetSupport,true);
    const serverCapabilities={workspaceSymbolProvider:true,executeCommandProvider:{commands:['clangd.applyFix']},documentOnTypeFormattingProvider:{firstTriggerCharacter:'\n'},renameProvider:true};
    clients[0].feature.preInitialize(serverCapabilities);assert.equal(serverCapabilities.workspaceSymbolProvider,undefined);assert.equal(serverCapabilities.executeCommandProvider,undefined);assert.equal(serverCapabilities.documentOnTypeFormattingProvider,undefined);assert.equal(serverCapabilities.renameProvider,true);
    const actions=await clients[0].args[3].middleware.provideCodeActions(null,null,null,null,async()=>[{title:'edit',edit:{}},{title:'unsupported',command:'clangd.applyFix'},{title:'nested command',command:{command:'clangd.applyTweak'}}]);
    assert.equal(actions.length,1);assert.equal(actions[0].title,'edit');
    const middleware=clients[0].args[3].middleware;let text='void loop() {\n  Serial.println("中文 😀");\n}\n';
    const document={uri:{toString:()=> 'file:///project/main.ino'},version:1,languageId:'cpp',getText:()=>text};
    middleware.didOpen(document,()=>{});text='void loop() {\n  Serial.println("新的 😀");\n}\n';document.version=2;
    await middleware.didChange({document,contentChanges:[]},()=>assert.fail('Unsafe byte/UTF16 delta must not reach ALS'));
    await middleware.didSave(document,()=>{});
    assert.equal(clients[0].notifications[0].method,'textDocument/didClose');assert.equal(clients[0].notifications[1].method,'textDocument/didOpen');assert.equal(clients[0].notifications[1].params.textDocument.text,text);
    let queried=false;const hover=middleware.provideHover(document,{}, {},()=>{queried=true;});await Promise.resolve();assert.equal(queried,false);
    middleware.handleWorkDoneProgress('arduinoLanguageServerRebuild',{kind:'begin'},()=>{});middleware.handleWorkDoneProgress('arduinoLanguageServerRebuild',{kind:'end'},()=>{});await hover;assert.equal(queried,true);
    let got;clients[0].args[3].middleware.handleDiagnostics({scheme:'file',fsPath:'/project/main.ino'},[{message:'actual'}],(_,ds)=>got=ds);
    assert.equal(got[0].message,'actual');
    clients[0].args[3].middleware.handleDiagnostics({scheme:'file',fsPath:'/not-ino'},[{message:'toolchain problem'}],()=>assert.fail());
    assert.equal(output[0],'toolchain problem');
    await commands.get('nodu.arduino.language.start')({...spec,project:'/second [one]',fingerprint:'two'});
    assert.equal(clients[1].args[3].documentSelector[0].pattern,'/second [[]one[]]/**/*.{ino,pde,c,cpp,cxx,cc,h,hpp}');
    assert.equal(clients[0].stopped,true);assert.equal(disposed,2);
    await commands.get('nodu.arduino.language.start')({...spec,project:String.raw`C:\work\[board]`,fingerprint:'windows'});
    assert.equal(clients[2].args[3].documentSelector[0].pattern,'C:/work/[[]board[]]/**/*.{ino,pde,c,cpp,cxx,cc,h,hpp}');
    assert.equal(clients[1].stopped,true);assert.equal(disposed,4);
    await commands.get('nodu.arduino.language.start')({...spec,incrementalSync:true,fingerprint:'patched'});
    const fast=clients[3].args[3].middleware;let current='void loop() {\n  Serial.println("中文 😀");\n}\n';
    const edited={...document,getText:()=>current};fast.didOpen(edited,()=>{});current=current.replace('中文','测试');let forwarded;
    let finish;const sending=fast.didChange({document:edited,contentChanges:[]},event=>{forwarded=event.contentChanges[0];return new Promise(resolve=>{finish=resolve;});});
    let fastQueried=false;const queuedHover=fast.provideHover(edited,{}, {},()=>{fastQueried=true;});await Promise.resolve();assert.equal(fastQueried,false,'Semantic request must wait for pending didChange');finish();await sending;await queuedHover;assert.equal(fastQueried,true);assert(forwarded.range);assert.equal(clients[3].notifications.length,0);
    // Rapid structural paste/undo/redo collapses to the latest exact buffer on save.
    for(const suffix of ['A','B','C']){current='void setup() {}\nvoid loop() { /* '+suffix+' */ }';await fast.didChange({document:edited,contentChanges:[]},()=>assert.fail());}
    // An old background rebuild begins after edits were queued but before their flush.
    fast.handleWorkDoneProgress('arduinoLanguageServerRebuild',{kind:'begin'},()=>{});
    let latestQueried=false;const latestHover=fast.provideHover(edited,{}, {},()=>{latestQueried=true;});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(clients[3].notifications.length,2);assert.equal(clients[3].notifications[1].params.textDocument.text,current);
    fast.handleWorkDoneProgress('arduinoLanguageServerRebuild',{kind:'end'},()=>{});await Promise.resolve();assert.equal(latestQueried,false,'Old rebuild end must not release flushed latest text');
    fast.handleWorkDoneProgress('arduinoLanguageServerRebuild',{kind:'begin'},()=>{});fast.handleWorkDoneProgress('arduinoLanguageServerRebuild',{kind:'end'},()=>{});await latestHover;assert.equal(latestQueried,true);
    await commands.get('nodu.arduino.language.stop')();assert.equal(clients[3].stopped,true);assert.equal(disposed,8);
    await sandbox.exports.deactivate();assert.equal(disposed,8);
});

test('patched ALS keeps body Unicode/newlines fast and conservatively resynchronizes declarations',()=>{
 const {arduinoPatchedChange}=require('./arduino-language-sync.cjs');
 const before='#include <Arduino.h>\nvoid setup() {}\nvoid loop() {\n  Serial.println("中文 😀 { }"); // } {\n}\n';
 for(const after of [before.replace('中文','新的'),before.replace('void setup() {}','void setup() {\n}'),before.replace('  Serial.println','  int n = 1;\n  Serial.println'),before.replace('  Serial.println','  /* } { */\n  Serial.println')]) assert(arduinoPatchedChange(before,after).change,after);
 for(const after of [before.replace('#include <Arduino.h>','#include <Arduino.h>\n#include <Wire.h>'),before+'void added() {}\n',before.replace('void loop() {','int data[] = {1,2};\nvoid loop() {')])assert.equal(arduinoPatchedChange(before,after).reopen,true,after);
 for(const before of ['namespace N {\nvoid a();\n}', 'struct Driver {\nvoid a();\n};', 'int values[]={1,2};', '#define OPEN \\\n{\nvoid a();'])assert.equal(arduinoPatchedChange(before,before.replace('a();','a();\nvoid b();').replace('1,2','1,\n2')).reopen,true,before);
 assert.equal(arduinoPatchedChange(before,before.replace('Arduino.h','Wire.h')).reopen,true);assert.equal(arduinoPatchedChange(before,before.replace('setup()','setup2()')).reopen,true);
 const comment='void setup() {\n  // 中文 😀\n  JsonDocument doc;\n}';const enter=comment.replace('// 中文 😀','// 中文 😀\n  ');assert(arduinoPatchedChange(comment,enter).change);const pasted=enter.replace('  \n  JsonDocument','  // 多行 🧩\n  Serial.println(1);\n  JsonDocument');assert(arduinoPatchedChange(enter,pasted).change);
 const constants='#define LED_PIN 2\n#define SERIAL_BAUD 115200UL\n#define DEVICE_NAME "nodu"\n'+before;assert(arduinoPatchedChange(constants,constants.replace('中文','测试')).change);
 const continuation='// comment \\\n{\nvoid top();';assert.equal(arduinoPatchedChange(continuation,continuation.replace('top','other')).reopen,true);
 const raw='void loop() {\n  auto text=R"x( } )x";\n  Serial.println(1);\n}';assert.equal(arduinoPatchedChange(raw,raw.replace('Serial.println(1);','Serial.println(1);\n  Serial.println(2);')).reopen,true);
});

test('patched sync rejects same-line body escape, directives and EOL conversions',()=>{
 const {arduinoPatchedChange}=require('./arduino-language-sync.cjs');
 const before='void loop() {\n  run();\n}';
 for(const after of [before.replace('run();','run(); } void added() {'),before.replace('run();','#include <Wire.h>')])assert.equal(arduinoPatchedChange(before,after).reopen,true);
 const crlf=before.replaceAll('\n','\r\n');assert.equal(arduinoPatchedChange(crlf,before).reopen,true);assert(arduinoPatchedChange(crlf,crlf.replace('run','work')).change);
});

test('GUI Enter then paste remains incremental with the exact captured document',()=>{const {arduinoPatchedChange}=require('./arduino-language-sync.cjs');for(const event of JSON.parse(fs.readFileSync(path.join(__dirname,'arduino-language-plugin/gui-sync-fixture.json'),'utf8')))assert(arduinoPatchedChange(event.before,event.after).change,event.name);});
