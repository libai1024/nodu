// SPDX-License-Identifier: MIT
// Real model/history methods, no Electron, credentials or hardware.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),{createRequire}=require('node:module'),crypto=require('node:crypto');
class Storage {data=new Map();get length(){return this.data.size;}key(i){return [...this.data.keys()][i]??null;}getItem(k){return this.data.get(k)??null;}setItem(k,v){this.data.set(k,v);}removeItem(k){this.data.delete(k);}}
const localStorage=new Storage(),sessionStorage=new Storage();
function source(file,stubs={},globals={}) {const filepath=path.join(__dirname,'../src',file),base=createRequire(path.join(__dirname,'../lib',file.replace(/\.ts$/,'.js'))),exports={};const code=ts.transpileModule(fs.readFileSync(filepath,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true}}).outputText;vm.runInNewContext(code,{exports,require:id=>id in stubs?stubs[id]:base(id),crypto,TextEncoder,Buffer,AbortController,Error,URL,setTimeout,clearTimeout,localStorage,sessionStorage,...globals},{filename:filepath});return exports;}
const context=source('common/tutor/tutor-context.ts');
const history=source('common/tutor/tutor-conversation.ts',{'./tutor-context':context});
const Chat=source('node/tutor/tutor-chat-session.ts',{'../../common/tutor/tutor-conversation':history,'../../common/tutor/tutor-context':context}).TutorChatSession;
const nop=()=>()=>{};class Emitter {event=()=>({dispose(){}});fire(){}dispose(){}}
const modelStubs={'@theia/core/shared/inversify':{inject:nop,injectable:nop,postConstruct:nop},'@theia/core/lib/common':{Emitter,DisposableCollection:class{push(){}dispose(){}}},'@theia/core/lib/common/uri':{default:class{constructor(s){this.path={toString:()=>s};}}},'@theia/core/lib/browser/messaging/ws-connection-provider':{},'@theia/workspace/lib/browser/workspace-service':{},'@theia/filesystem/lib/browser/file-service':{},'./scope-layout-state':{},'../common/tutor/tutor-conversation':history,'../common/tutor/tutor-context':context};
const {NoduTutorModel}=source('browser/nodu-tutor-model.ts',modelStubs);
const tick=()=>new Promise(r=>setImmediate(r));
const conversationKey=id=>'nodu.tutor.conversation.v1.'+id;
const storedConversation=(storage,id)=>JSON.parse(storage.getItem(conversationKey(id)));
const plain=value=>JSON.parse(JSON.stringify(value));
const pair=(text='question')=>{const user={id:crypto.randomUUID(),role:'user',text,status:'done'};return [user,{id:crypto.randomUUID(),role:'assistant',text:'answer',status:'done',replyTo:user.id,request:{prompt:text,mode:'ask',kind:'chat',goalRevision:0}}];};
function model(storage=new Storage(),Model=NoduTutorModel) {const m=new Model();m.layout={mode:'pro'};m.mode='ask';m.workspaceId='workspace-0001';m.connectionState='connected';m.conversationStore=new history.TutorConversationStore(storage);m.restoreConversations('project-inode-one');m.service={cancelChat:async()=>{},setPresentation:async()=>{},restoreChatHistory:async()=>{},clearChat:async()=>{},authorizeChatContexts:async(w,mode,pins)=>context.validateTutorContexts(pins,mode),chat:async()=>({ok:true,answer:{text:'reply',annotations:[]}})};return m;}
test('profile restores stopped state and drafts, scoped by project identity and mode',()=>{const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project-a','ask');c.messages=pair();c.messages[1].status='pending';c.draft='next question';const saved=store.save(c),reopened=new history.TutorConversationStore(storage),restored=reopened.read(saved.id,'project-a','ask');assert.equal(restored.messages[1].status,'stopped');assert.equal(restored.messages[1].note,'回复未完成');assert.equal(restored.draft,'next question');assert.equal(reopened.read(saved.id,'project-b','ask'),undefined);assert.equal(reopened.read(saved.id,'project-a','teach'),undefined);assert.equal(history.conversationPrompt(restored.messages).length,0);});
test('two windows selecting same history fork writes without overwriting',()=>{const storage=new Storage(),a=new history.TutorConversationStore(storage),b=new history.TutorConversationStore(storage),c=a.create('project','ask');c.messages=pair('original');const original=a.save(c),copy=b.read(original.id,'project','ask');copy.messages.push(...pair('window b'));const fork=b.save(copy);assert.notEqual(fork.id,original.id);assert.equal(a.read(original.id,'project','ask').messages.length,2);assert.equal(b.read(fork.id,'project','ask').messages.length,4);});
function browserWindowModel(storage,session) {
 const Model=source('browser/nodu-tutor-model.ts',modelStubs,{localStorage:storage,sessionStorage:session}).NoduTutorModel;
 const m=new Model();m.mode='ask';m.restoreConversations('reload-project');return m;
}
test('same-window reload continues the same conversation without adding a duplicate history entry',()=>{
 const storage=new Storage(),session=new Storage(),first=browserWindowModel(storage,session);
 first.messages.ask.push(...pair('existing conversation'));first.drafts.ask='saved draft';first.persistConversation('ask');
 const id=first.activeConversationId,owner=first.conversationStore.owner;
 const reloaded=browserWindowModel(storage,session);assert.equal(reloaded.activeConversationId,id);assert.equal(reloaded.drafts.ask,'saved draft');
 reloaded.drafts.ask='continued after reload';reloaded.messages.ask.push(...pair('new turn'));reloaded.persistConversation('ask');
 assert.equal(reloaded.activeConversationId,id);assert.equal(reloaded.conversationStore.owner,owner);assert.equal(reloaded.historyEntries.length,1);
 const again=browserWindowModel(storage,session);assert.equal(again.activeConversationId,id);assert.equal(again.messages.ask.length,4);assert.equal(again.drafts.ask,'continued after reload');
});
test('different window sessions keep independent owners and fork conflicting edits without overwriting',()=>{
 const storage=new Storage(),sessionA=new Storage(),sessionB=new Storage(),a=browserWindowModel(storage,sessionA);
 a.messages.ask.push(...pair('shared original'));a.persistConversation('ask');const id=a.activeConversationId;
 const b=browserWindowModel(storage,sessionB);assert.equal(b.activeConversationId,id);assert.notEqual(a.conversationStore.owner,b.conversationStore.owner);
 a.messages.ask.push(...pair('window a update'));a.persistConversation('ask');
 b.messages.ask.push(...pair('window b update'));b.persistConversation('ask');
 assert.equal(a.activeConversationId,id);assert.notEqual(b.activeConversationId,id);assert.equal(b.historyEntries.length,2);
 const original=a.conversationStore.read(id,'reload-project','ask'),fork=b.conversationStore.read(b.activeConversationId,'reload-project','ask');
 assert.equal(original.messages.at(-2).text,'window a update');assert.equal(fork.messages.at(-2).text,'window b update');
 assert.equal(browserWindowModel(storage,sessionB).activeConversationId,b.activeConversationId);
});
test('a new window owner does not take ownership of pre-migration history',()=>{
 const storage=new Storage(),legacy=new history.TutorConversationStore(storage,'legacy-renderer-owner');
 const record=legacy.create('reload-project','ask');record.messages=pair('legacy conversation');const saved=legacy.save(record);
 const before=storage.getItem('nodu.tutor.conversation.v1.'+saved.id),migrated=browserWindowModel(storage,new Storage());
 assert.equal(migrated.activeConversationId,saved.id);migrated.drafts.ask='first edit with the new window owner';migrated.persistConversation('ask');
 assert.notEqual(migrated.activeConversationId,saved.id);assert.equal(storage.getItem('nodu.tutor.conversation.v1.'+saved.id),before);
});
test('durable messages redact pasted credentials and discard affected retry snapshot',()=>{const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask'),fake='sk-'+'a'.repeat(24);c.messages=pair('API_KEY='+fake);c.draft='Authorization: Bearer '+fake;const saved=store.save(c),raw=[...storage.data.values()].join('');assert.ok(!raw.includes(fake));assert.match(raw,/已隐藏凭据/);assert.equal(store.read(saved.id,'project','ask').messages[1].request,undefined);});
test('corrupt history is ignored',()=>{const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask');c.messages=pair();const saved=store.save(c);storage.setItem('nodu.tutor.conversation.v1.'+saved.id,JSON.stringify({...saved,mode:'system'}));const reopened=new history.TutorConversationStore(storage);assert.equal(reopened.read(saved.id,'project','ask'),undefined);assert.equal(reopened.list('project','ask').length,0);});
test('new/select synchronizes backend prompt and never replays requests or tasks',async()=>{const m=model();m.messages.ask.push(...pair());m.drafts.ask='saved draft';m.persistConversation('ask');const old=m.activeConversationId,calls=[];m.service.restoreChatHistory=async(...args)=>calls.push(args);m.service.chat=async()=>{throw Error('must not call');};m.goalState={...m.goalState,status:'active',revision:7};await m.newConversation();assert.notEqual(m.activeConversationId,old);assert.equal(m.messages.ask.length,0);assert.equal(m.drafts.ask,'');assert.equal(calls.at(-1)[3].length,0);assert.equal(m.goalState.revision,7);await m.selectConversation(old);assert.equal(m.messages.ask.length,2);assert.equal(m.drafts.ask,'saved draft');assert.equal(calls.at(-1)[3][0].content,'question');assert.equal(m.goalState.status,'active');});
test('pending history selection blocks sends and restore failure stays disconnected',async()=>{const m=model();m.messages.ask.push(...pair());m.persistConversation('ask');const old=m.activeConversationId;await m.newConversation();let release;const gate=new Promise(r=>release=r);m.service.restoreChatHistory=async()=>gate;const selecting=m.selectConversation(old);await tick();assert.equal(m.canSendChat,false);let requests=0;m.service.chat=async()=>{requests++;};m.drafts.ask='do not send';await m.send();assert.equal(requests,0);release();await selecting;assert.equal(m.canSendChat,true);m.service.restoreChatHistory=async()=>{throw Error('history offline');};await m.newConversation();assert.equal(m.connectionState,'disconnected');assert.equal(m.canSendChat,false);});
test('retry keeps new draft and exact original source; changed source or revision is rejected',async()=>{const m=model();m.buffer={path:'main.c',text:'int a;',line:1,version:1};m.drafts.ask='original';m.service.chat=async()=>({ok:false,error:'interrupted'});await m.send();const failed=m.messages.ask.at(-1);m.drafts.ask='unsent next';let received;m.service.chat=async r=>{received=r;return {ok:true,answer:{text:'done',annotations:[]}};};await m.retryChat(failed.id);assert.equal(received.prompt,'original');assert.equal(received.buffer.text,'int a;');assert.equal(m.drafts.ask,'unsent next');received=undefined;m.buffer.text='int b;';await m.retryChat(failed.id);assert.equal(received,undefined);assert.match(m.error,/已变更/);m.buffer.text='int a;';m.goalState.revision++;await m.retryChat(failed.id);assert.equal(received,undefined);});
test('edit user message protects another draft and only stages text',()=>{const m=model();m.messages.ask.push(...pair('previous'));const id=m.messages.ask[0].id;m.drafts.ask='valuable draft';assert.equal(m.editMessage(id),false);assert.equal(m.drafts.ask,'valuable draft');assert.match(m.error,/已有草稿/);m.drafts.ask='';assert.equal(m.editMessage(id),true);assert.equal(m.drafts.ask,'previous');assert.equal(m.messages.ask.length,2);clearTimeout(m.draftSave);});
test('backend restore is authorized, bounded, epoch-safe and appears in next model prompt',async()=>{const prompts=[];let authorized=0;const session=new Chat({complete:async messages=>{prompts.push(messages);return 'new reply';}},{onChatDelta(){}},async()=>{authorized++;});await session.setPresentation('workspace-0001',1,'ask',false);await session.restore('workspace-0001',1,'ask',[{role:'user',content:'remember USART1'},{role:'assistant',content:'115200'}]);assert.equal((await session.chat({id:crypto.randomUUID(),workspaceId:'workspace-0001',epoch:1,mode:'ask',kind:'chat',prompt:'what baud?'})).ok,true);assert.equal(prompts[0][1].content,'remember USART1');assert.equal(prompts[0][2].content,'115200');assert.ok(authorized>=3);await assert.rejects(()=>session.restore('workspace-0001',0,'ask',[]),/已更新/);await assert.rejects(()=>session.restore('workspace-0001',1,'ask',[{role:'system',content:'bad'},{role:'assistant',content:'x'}]),/无效/);session.clear('workspace-0001','ask');await session.chat({id:crypto.randomUUID(),workspaceId:'workspace-0001',epoch:1,mode:'ask',kind:'chat',prompt:'fresh'});assert.equal(prompts[1].length,2);session.dispose();});
const pin=(path='main.c',text='int value;')=>({kind:'file',path,text,version:1,startLine:1,endLine:text.split('\n').length});
test('fixed contexts enforce six items and UTF8 64KiB rather than character count',()=>{
 assert.equal(context.validateTutorContexts(Array.from({length:6},(_,i)=>pin(`f${i}.c`)),'ask').length,6);
 assert.throws(()=>context.validateTutorContexts(Array.from({length:7},(_,i)=>pin(`f${i}.c`)),'ask'),/6/);
 assert.throws(()=>context.validateTutorContexts([pin('main.c','中'.repeat(22000))],'ask'),/64 KiB/);
 assert.throws(()=>context.validateTutorContexts([pin('../private.c')],'ask'),/无效/);
 assert.throws(()=>context.validateTutorContexts([pin('boot.py','print(1)')],'teach'),/Python/);
 assert.equal(context.validateTutorContexts([pin('boot.py','print(1)')],'ask').length,1);
});
test('fixed selection replaces automatic full-file context, survives file switch and preserves draft',async()=>{
 const m=model();m.buffer={path:'main.c',text:'int secret;\nint selected;',version:2,line:2,selection:{startLine:2,endLine:2,text:'int selected;'}};
 assert.equal(await m.addCurrentContext('selection'),true);assert.equal(m.currentContextIncluded,false);m.drafts.ask='explain selection';let request;
 m.service.chat=async r=>{request=r;return {ok:true,answer:{text:'selected only',annotations:[]}};};await m.send();
 assert.equal(request.buffer,undefined);assert.equal(request.contexts[0].text,'int selected;');assert.equal(request.contexts[0].startLine,2);assert.ok(!JSON.stringify(request).includes('secret'));
 m.buffer={path:'other.c',text:'int next;',version:1,line:1};assert.equal(m.currentContextIncluded,true);assert.equal(m.pins[0].path,'main.c');
 m.removeContext(0);assert.equal(m.pins.length,0);
});
test('attachment authorization completion after mode/workspace change cannot modify new context',async()=>{
 const m=model();m.buffer={path:'main.c',text:'int old;',version:1,line:1};let release;
 m.service.authorizeChatContexts=async()=>new Promise(r=>release=r);const adding=m.addCurrentContext('file');await tick();m.workspaceId='workspace-new';m.epoch++;release([pin()]);
 assert.equal(await adding,false);assert.equal(m.pins.length,0);assert.equal(m.contextError,undefined);
});
test('snapshot retry reuses fixed attachments and new unsent attachments remain untouched',async()=>{
 const m=model();m.contextDrafts.ask=[pin('main.c','int original;')];m.drafts.ask='what is this?';m.service.chat=async()=>({ok:false,error:'stream ended'});await m.send();const failed=m.messages.ask.at(-1);
 m.contextDrafts.ask=[pin('other.c','int new;')];m.drafts.ask='new draft';let request;
 m.service.chat=async r=>{request=r;return {ok:true,answer:{text:'answer',annotations:[]}};};await m.retryChat(failed.id);
 assert.equal(request.contexts[0].path,'main.c');assert.equal(m.pins[0].path,'other.c');assert.equal(m.drafts.ask,'new draft');
});
test('C goal requests include pinned context while Python and connection gates refuse them',async()=>{
 const m=model();m.mode='teach';m.contextDrafts.teach=[pin('main.h','void init(void);')];m.buffer={path:'main.c',text:'int main(void) {}',version:1,line:1,selection:{startLine:1,endLine:1,text:'int'}};
 const payload=m.goalRequestContexts('propose');assert.equal(payload.contexts[0].path,'main.h');assert.equal(payload.buffer.selection,undefined);
 let calls=0;m.goalAction=async()=>calls++;m.connectionState='connecting';m.drafts.teach='goal';await m.send();assert.equal(calls,0);
 m.contextDrafts.teach=[pin('boot.py','print(1)')];assert.throws(()=>m.goalRequestContexts('propose'),/Python/);
});
test('teaching proposal preserves sent terminal and file snapshots across draft edits and history restore without replay',async()=>{
 const storage=new Storage(),m=model(storage),prompt='teach me to fix this build';m.mode='teach';m.goalState={...m.goalState,revision:7,status:'none'};
 const terminal={kind:'terminal',path:'terminal:build-widget',text:'undefined reference\nlink failed',version:1,startLine:621,endLine:622},header=pin('Board/board.h','void init(void);');
 m.contextDrafts.teach=[terminal,header];m.buffer={path:'App/main.c',text:'int main(void) {\n}',version:1,line:1,selection:{startLine:1,endLine:1,text:'int'}};m.drafts.teach=prompt;
 let enter,release;const entered=new Promise(resolve=>enter=resolve),pending=new Promise(resolve=>release=resolve),goals=[],restores=[];let chats=0;
 m.service.goal=request=>{goals.push(request);enter();return pending;};m.service.chat=async()=>{chats++;throw Error('goal history must not enter chat');};m.service.restoreChatHistory=async(...args)=>restores.push(args);
 const sending=m.send();await entered;
 assert.equal(goals.length,1);assert.equal(goals[0].action,'propose');assert.equal(goals[0].revision,7);assert.equal(goals[0].buffer.selection,undefined);
 const sentPayload=JSON.parse(JSON.stringify({buffer:goals[0].buffer,contexts:goals[0].contexts}));
 terminal.text='different terminal output';terminal.startLine=801;terminal.endLine=801;header.text='void later(void);';m.buffer.text='int later;';m.buffer.version=2;
 m.contextDrafts.teach=[pin('Other/next.h','int next;')];m.drafts.teach='another unsent goal';m.goalState.revision=8;
 release({ok:true,state:{revision:8,status:'draft',current:0,steps:[]}});await sending;
 assert.equal(m.error,undefined);assert.equal(m.messages.teach.length,1);assert.equal(m.drafts.teach,'another unsent goal');
 const user=m.messages.teach[0],expectedSnapshot={prompt,mode:'teach',kind:'goal',goalRevision:7,...sentPayload},expectedRefs=[
  {kind:'file',path:'App/main.c',startLine:1,endLine:2},
  {kind:'terminal',path:'terminal:build-widget',startLine:621,endLine:622},
  {kind:'file',path:'Board/board.h',startLine:1,endLine:1},
 ];
 assert.equal(user.role,'user');assert.equal(user.text,prompt);assert.deepEqual(JSON.parse(JSON.stringify(user.request)),expectedSnapshot);
 assert.deepEqual(JSON.parse(JSON.stringify(user.contextRefs)),expectedRefs);assert.equal(history.conversationPrompt(m.messages.teach).length,0);assert.equal(m.canRetry(user),false);
 m.pins[0].text='int newer;';m.persistConversation('teach');
 const id=m.activeConversationId,restored=new history.TutorConversationStore(storage).read(id,'project-inode-one','teach');
 assert.ok(restored);assert.deepEqual(JSON.parse(JSON.stringify(restored.messages[0].request)),expectedSnapshot);assert.deepEqual(JSON.parse(JSON.stringify(restored.messages[0].contextRefs)),expectedRefs);
 assert.equal(restored.contexts[0].text,'int newer;');assert.equal(history.conversationPrompt(restored.messages).length,0);
 await m.newConversation();await m.selectConversation(id,'teach');await m.retryChat(user.id);
 assert.deepEqual(JSON.parse(JSON.stringify(m.messages.teach[0].request)),expectedSnapshot);assert.deepEqual(JSON.parse(JSON.stringify(m.messages.teach[0].contextRefs)),expectedRefs);
 assert.equal(goals.length,1);assert.equal(chats,0);assert.ok(restores.length>=2);assert.ok(restores.every(args=>args[3].length===0));
 sessionStorage.removeItem('nodu.tutor.mode');
});
test('goal snapshots cannot enter ordinary chat prompt replay or assistant retry paths',async()=>{
 const m=model(),ordinary=pair('ordinary question'),user={id:crypto.randomUUID(),role:'user',text:'goal proposal',status:'done',request:{prompt:'goal proposal',mode:'teach',kind:'goal',goalRevision:0}},
  reply={id:crypto.randomUUID(),role:'assistant',text:'goal response',status:'done',replyTo:user.id,request:user.request};
 assert.deepEqual(JSON.parse(JSON.stringify(history.conversationPrompt([user,reply,...ordinary]))),[{role:'user',content:'ordinary question'},{role:'assistant',content:'answer'}]);
 m.mode='teach';reply.status='failed';m.messages.teach.push(user,reply);let calls=0;m.service.chat=async()=>calls++;m.service.goal=async()=>calls++;
 assert.equal(m.canRetry(reply),false);await m.retryChat(reply.id);assert.equal(calls,0);
});
test('chat model receives authorized attachment snapshot and late revoked attachment cancels success',async()=>{
 const received=[];let revocation=false;
 const session=new Chat({complete:async messages=>{received.push(messages);revocation=true;return 'answer';}},{onChatDelta(){}},async()=>{},async()=>({files:['main.h']}),async(w,mode,pins)=>{if(revocation)throw Error('revoked attachment');return pins;});
 await session.setPresentation('workspace-0001',1,'ask',false);
 const result=await session.chat({id:crypto.randomUUID(),workspaceId:'workspace-0001',epoch:1,mode:'ask',kind:'chat',prompt:'explain',contexts:[pin('main.h','void init(void);')]});
 assert.equal(result.ok,false);assert.match(result.error,/revoked/);assert.match(received[0].at(-1).content,/固定上下文附件/);assert.match(received[0].at(-1).content,/void init/);session.dispose();
});
test('real workspace authorizes Python ask/navigation, skips C checker, rejects traversal and symlinks',async t=>{
 const fsp=require('node:fs/promises'),os=require('node:os'),{pathToFileURL}=require('node:url');
 const parent=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'nodu-context-'))),root=path.join(parent,'project');await fsp.mkdir(root);
 t.after(()=>fsp.rm(parent,{recursive:true,force:true}));await fsp.writeFile(path.join(root,'boot.py'),'print("hello")\n');await fsp.writeFile(path.join(parent,'outside.py'),'private');await fsp.symlink(path.join(parent,'outside.py'),path.join(root,'link.py'));
 const {TutorWorkspaceHost}=source('node/tutor/tutor-workspace-host.ts',{'../../common/tutor/tutor-context':context});
 const host=new TutorWorkspaceHost({authorizeWorkspace:async()=> 'workspace-0001',revokeWorkspace(){},dispose(){}},()=>{});t.after(()=>host.dispose());await host.select(pathToFileURL(root).href);
 let checked=0;host.checker={inspect:async()=>{checked++;throw Error('Python must not reach C AST');}};
 const b={path:'boot.py',text:'print("hello")\n',version:1,line:1};
 await assert.rejects(()=>host.authorize('workspace-0001',b),/无效/);await host.authorize('workspace-0001',b,true);
 const project=await host.context('workspace-0001',b,true);assert.equal(checked,0);assert.equal(project.localCheck,undefined);assert.ok(project.files.includes('boot.py'));
 assert.equal((await host.reference('workspace-0001','boot.py',1)).path,'boot.py');assert.equal((await host.readContext('workspace-0001','boot.py')).text,b.text);
 await assert.rejects(()=>host.readContext('workspace-0001','../outside.py'));await assert.rejects(()=>host.readContext('workspace-0001','link.py'));
 await assert.rejects(()=>host.contexts('workspace-0001','teach',[pin('boot.py','print(1)')]),/Python/);
});

test('Arduino ask references retain sketch lines and use the real project boundary without entering tutorials',async t=>{
 const fsp=require('node:fs/promises'),os=require('node:os'),{pathToFileURL}=require('node:url');
 const root=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'nodu-arduino-context-')));
 t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const text='void setup() {\n  Serial.begin(115200);\n}\nvoid loop() {}';
 const sketchName=path.basename(root)+'.ino';
 await fsp.writeFile(path.join(root,'blink.ino'),text); await fsp.writeFile(path.join(root,sketchName),text);
 await fsp.writeFile(path.join(root,'nodu.json'),JSON.stringify({kind:'esp32-arduino',target:{mcu:'esp32c3'}}));
 await fsp.writeFile(path.join(root,'sketch.yaml'),'default_profile: nodu\nprofiles:\n  nodu:\n    fqbn: esp32:esp32:esp32c3\n    platforms:\n      - platform: esp32:esp32 (3.3.12)\n        platform_index_url: https://espressif.github.io/arduino-esp32/package_esp32_index.json\n    libraries:\n      - ArduinoJson (7.4.3)\n');
 await fsp.mkdir(path.join(root,'.nodu'));await fsp.writeFile(path.join(root,'.nodu','arduino.local.json'),JSON.stringify({port:'/dev/private',secret:'never-send-this'}));
 const {TutorWorkspaceHost}=source('node/tutor/tutor-workspace-host.ts',{'../../common/tutor/tutor-context':context});
 const host=new TutorWorkspaceHost({authorizeWorkspace:async()=> 'workspace-0001',revokeWorkspace(){},dispose(){}},()=>{});
 t.after(()=>host.dispose()); await host.select(pathToFileURL(root).href);
 host.checker={inspect:async()=>{throw Error('Arduino must not enter the C tutorial checker');}};
 const b={path:'blink.ino',text,version:2,line:2};
 const project=await host.context('workspace-0001',b,true); assert.equal(project.mcu,'esp32c3');assert.equal(project.sdk,'Arduino');assert.ok(project.files.includes('blink.ino')); assert.equal(project.arduino.fqbn,'esp32:esp32:esp32c3');assert.equal(project.arduino.libraries[0].version,'7.4.3');assert.ok(!JSON.stringify(project).includes('never-send-this'));
 const pin=await host.readContext('workspace-0001','blink.ino'); assert.equal(pin.text,text);assert.equal(pin.endLine,4);
 const selection={...pin,kind:'selection',text:'  Serial.begin(115200);',startLine:2,endLine:2};
 assert.equal((await host.contexts('workspace-0001','ask',[selection]))[0].startLine,2);
 assert.equal((await host.reference('workspace-0001','blink.ino',2)).line,2);
 await assert.rejects(()=>host.contexts('workspace-0001','teach',[selection]),/仅用于提问/);
 await assert.rejects(()=>host.readContext('workspace-0001','../blink.ino'));
});

test('sent user references retain original file/selection metadata after editor changes and profile restore',async()=>{
 const storage=new Storage(),m=model(storage);
 m.buffer={path:'App/main.c',text:'int main(void) {\n}\n',version:1,line:1};
 m.contextDrafts.ask=[{kind:'selection',path:'Board/board.h',text:'void init(void);',version:1,startLine:12,endLine:12}];
 m.drafts.ask='explain attached source';await m.send();
 const user=m.messages.ask.find(message=>message.role==='user');
 const expected=[{kind:'file',path:'App/main.c',startLine:1,endLine:3},{kind:'selection',path:'Board/board.h',startLine:12,endLine:12}];
 assert.equal(JSON.stringify(user.contextRefs),JSON.stringify(expected));assert.ok(user.contextRefs.every(ref=>!('text'in ref)&&!('version'in ref)));
 m.buffer={path:'other.c',text:'int other;',version:2,line:1};m.contextDrafts.ask=[];m.persistConversation('ask');
 assert.equal(JSON.stringify(user.contextRefs),JSON.stringify(expected));
 const restored=new history.TutorConversationStore(storage).read(m.activeConversationId,'project-inode-one','ask');
 assert.equal(JSON.stringify(restored.messages[0].contextRefs),JSON.stringify(expected));
 const invalid={...restored,messages:[{...restored.messages[0],contextRefs:[{kind:'file',path:'../private.c',startLine:1,endLine:1}]}]};
 storage.setItem('nodu.tutor.conversation.v1.'+restored.id,JSON.stringify(invalid));
 assert.equal(new history.TutorConversationStore(storage).read(restored.id,'project-inode-one','ask'),undefined);
});
test('overlapping reconnect loads retain stable project messages, draft, fixed contexts and buffer',async()=>{
 const m=model(),root={toString:()=>'/project',path:{toString:()=>'/project'}};m.rootUri=root;m.workspace={roots:Promise.resolve([{resource:root}])};
 m.messages.ask.push(...pair('retain this'));m.drafts.ask='last unsent character';m.contextDrafts.ask=[pin('main.h','int kept;')];m.buffer={path:'main.c',text:'int unsaved;',version:3,line:1};
 let enter,release,calls=0;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);const restored=[];
 Object.assign(m.service,{workspaces:async()=>{if(++calls===1){enter();await gate;}return [{id:'workspace-0001',uri:'/project',projectKey:'project-inode-one'}];},aiSettings:async()=>({providers:[]}),openSession:async()=>({ok:true,value:{sessionId:crypto.randomUUID(),plan:{kind:'none'}}}),closeSession:async()=>({ok:true}),goalSnapshot:async()=>({revision:0,status:'none',steps:[],current:0}),restoreChatHistory:async(w,e,mode,history)=>restored.push(history)});
 const first=m.load();await entered;assert.equal(m.rootUri,undefined);const second=m.load();await second;release();await first;
 assert.equal(m.messages.ask[0].text,'retain this');assert.equal(m.drafts.ask,'last unsent character');assert.equal(m.buffer.text,'int unsaved;');assert.equal(m.pins[0].path,'main.h');assert.equal(restored.at(-1)[0].content,'retain this');assert.equal(m.connectionState,'connected');
});
test('failed local storage write keeps latest memory ahead of old disk and retry flush recovers',()=>{
 const storage=new Storage(),store=new history.TutorConversationStore(storage),original=store.create('project','ask');original.messages=pair('old on disk');const saved=store.save(original),write=storage.setItem.bind(storage);
 storage.setItem=()=>{throw Error('quota exceeded');};saved.messages.push(...pair('new retained in memory'));saved.draft='latest draft';store.save(saved);
 assert.match(store.storageError,/暂未保存/);assert.equal(store.read(saved.id,'project','ask').messages.at(-2).text,'new retained in memory');assert.equal(store.read(saved.id,'project','ask').draft,'latest draft');
 assert.equal(new history.TutorConversationStore(storage).read(saved.id,'project','ask').messages.length,2,'disk really still contains the earlier record');
 storage.setItem=write;store.flush();assert.equal(store.storageError,undefined);const reopened=new history.TutorConversationStore(storage).read(saved.id,'project','ask');assert.equal(reopened.messages.length,4);assert.equal(reopened.draft,'latest draft');
});
test('model exposes storage failure and history reselection retains the newest unsaved reply',async()=>{
 const storage=new Storage(),m=model(storage);m.messages.ask.push(...pair('first'));m.persistConversation('ask');const id=m.activeConversationId,write=storage.setItem.bind(storage);
 storage.setItem=()=>{throw Error('quota exceeded');};m.messages.ask.push(...pair('keep this reply'));m.drafts.ask='draft stays';m.persistConversation('ask');assert.match(m.historyStorageError,/暂未保存/);
 await m.newConversation();await m.selectConversation(id);assert.equal(m.messages.ask.length,4);assert.equal(m.messages.ask.at(-2).text,'keep this reply');assert.equal(m.drafts.ask,'draft stays');
 storage.setItem=write;m.retryHistorySave();assert.equal(m.historyStorageError,undefined);
});
test('failed writes stay bounded without silently evicting earlier unsaved transcripts',()=>{
 const storage=new Storage();storage.setItem=()=>{throw Error('quota');};const store=new history.TutorConversationStore(storage);let first;
 for(let i=0;i<40;i++){const c=store.create('project','ask');c.messages=pair(`unsaved ${i}`);const saved=store.save(c);first??=saved.id;}
 const overflow=store.create('project','ask');overflow.messages=pair('over limit');assert.throws(()=>store.save(overflow),/未保存对话已达上限/);assert.equal(store.list('project','ask').length,40);assert.equal(store.read(first,'project','ask').messages[0].text,'unsaved 0');
});
test('read-only foreign history selection and exit are idempotent; actual edits still fork',async()=>{
 const storage=new Storage(),first=model(storage);first.messages.ask.push(...pair('one original'));first.persistConversation('ask');const original=first.activeConversationId;
 const before=storage.getItem('nodu.tutor.conversation.v1.'+original),beforeCount=first.conversations.length;
 const other=model(storage);await other.selectConversation(original);other.persistConversation('ask');other.persistConversation('teach');
 assert.equal(other.activeConversationId,original);assert.equal(other.conversations.length,beforeCount);assert.equal(storage.getItem('nodu.tutor.conversation.v1.'+original),before);
 await other.newConversation();assert.equal(other.messages.ask.length,0);assert.equal(other.conversations.length,beforeCount,'blank composer must not become an extra history entry');
 await other.selectConversation(original);other.persistConversation('ask');assert.equal(other.conversations.length,beforeCount);
 other.drafts.ask='an actual edit';other.persistConversation('ask');assert.notEqual(other.activeConversationId,original);assert.equal(other.conversations.length,beforeCount+1);assert.equal(storage.getItem('nodu.tutor.conversation.v1.'+original),before);
});
test('pending recovery and omitted default metadata do not fork or create empty history',()=>{
 const storage=new Storage(),a=new history.TutorConversationStore(storage),b=new history.TutorConversationStore(storage),c=a.create('project','ask');c.messages=pair('interrupted');c.messages[1].status='pending';const original=a.save(c),recovered=b.read(original.id,'project','ask');
 recovered.contexts=[];recovered.includeCode=true;assert.equal(recovered.messages[1].status,'stopped');assert.equal(b.save(recovered).id,original.id);assert.equal(b.list('project','ask').length,1);
 const blank=b.create('project','ask');blank.includeCode=false;b.save(blank);assert.equal(b.list('project','ask').length,1);assert.equal(storage.getItem('nodu.tutor.conversation.v1.'+blank.id),null);
});
test('an unchanged dirty save still retries persistence without changing identity or creating duplicates',()=>{
 const storage=new Storage(),a=new history.TutorConversationStore(storage),c=a.create('project','ask');c.messages=pair('draft');const first=a.save(c),write=storage.setItem.bind(storage);storage.setItem=()=>{throw Error('quota');};first.draft='latest';const dirty=a.save(first);const time=dirty.updatedAt;
 assert.equal(a.save(dirty).id,dirty.id);assert.match(a.storageError,/暂未保存/);storage.setItem=write;const recovered=a.save(dirty);assert.equal(recovered.id,dirty.id);assert.equal(recovered.updatedAt,time);assert.equal(a.storageError,undefined);assert.equal(a.list('project','ask').length,1);
});

test('history lists both modes and cross-mode switching preserves drafts, pins and active mode on reload', async () => {
    const m=model(), sent=[]; m.service.chat=async()=>{sent.push(1);};
    m.messages.ask.push(...pair('ask history')); m.drafts.ask='ask draft'; m.contextDrafts.ask=[pin('main.h')]; m.persistConversation('ask'); const ask=m.activeConversationId;
    m.mode='teach'; m.messages.teach.push(...pair('teach history')); m.drafts.teach='teach draft'; m.persistConversation('teach'); const teach=m.activeConversationId;
    assert.equal(m.historyEntries.length,2); assert.ok(m.historyEntries.every(c=>c.hasDraft));
    await m.selectConversation(ask,'ask'); assert.equal(m.mode,'ask'); assert.equal(m.drafts.ask,'ask draft'); assert.equal(m.pins[0].path,'main.h');
    assert.equal(new NoduTutorModel().mode,'ask');
    await m.selectConversation(teach,'teach'); assert.equal(m.drafts.teach,'teach draft'); assert.equal(m.pins.length,0); assert.deepEqual(sent,[]);
    sessionStorage.removeItem('nodu.tutor.mode');
});
test('explicit terminal selection captures immutable name, range and text and redacts credentials before sending', async () => {
    const storage=new Storage(),m=model(storage),secret='sk-'+'z'.repeat(24), terminal={id:'term-1',terminalId:7,title:{label:'build'},getSelection:()=> 'error: missing symbol\nAPI_KEY='+secret,
        getTerminal:()=>({getSelectionPosition:()=>({start:{x:0,y:46},end:{x:30,y:47}})}),buffer:{length:300,getLines(){throw Error('must prefer selection');}}};
    m.terminals={all:[terminal],getById:id=>id===terminal.id?terminal:undefined};
    assert.equal(await m.addTerminalContext('term-1',true),true); assert.equal(m.pins[0].kind,'terminal'); assert.match(m.pins[0].text,/missing symbol/); assert.ok(!m.pins[0].text.includes(secret));
    assert.equal(m.pins[0].startLine,47);assert.equal(m.pins[0].endLine,48);
    assert.equal(m.pins[0].terminalName,'build');assert.equal(m.pins[0].terminalSelection,true);
    assert.equal(m.historyEntries.find(entry=>entry.id===m.activeConversationId).preview,'build (47-48)');
    const captured=JSON.parse(JSON.stringify(m.pins[0]));
    terminal.title.label='renamed terminal';terminal.getSelection=()=> 'different text';terminal.getTerminal=()=>({getSelectionPosition:()=>({start:{x:0,y:299},end:{x:14,y:299}})});assert.match(m.pins[0].text,/missing symbol/);
    m.drafts.ask='explain'; const requests=[]; m.service.chat=async request=>{requests.push(request);return {ok:true,answer:{text:'ok'}};}; await m.send();
    assert.equal(JSON.stringify(requests[0].contexts[0]),JSON.stringify(captured));
    const expectedRef={kind:captured.kind,path:captured.path,startLine:47,endLine:48,terminalName:'build',terminalSelection:true};
    assert.equal(JSON.stringify(m.messages.ask[0].contextRefs[0]),JSON.stringify(expectedRef));
    const id=m.activeConversationId,restored=new history.TutorConversationStore(storage).read(id,'project-inode-one','ask');
    assert.equal(JSON.stringify(restored.contexts[0]),JSON.stringify(captured));
    assert.equal(JSON.stringify(restored.messages[0].contextRefs[0]),JSON.stringify(expectedRef));
    assert.equal(JSON.stringify(restored.messages[1].request.contexts[0]),JSON.stringify(captured));
    await m.newConversation(); await m.selectConversation(id); assert.equal(JSON.stringify(m.pins[0]),JSON.stringify(captured));
});
test('terminal output is bounded to last 200 lines; closed and empty terminals do not add attachments',async()=>{
    const m=model(),calls=[],lines=Array.from({length:200},(_,index)=>`output ${601+index}`),terminal={id:'term',terminalId:1,title:{label:'zsh'},getSelection:()=>'',buffer:{length:800,getLines:(...args)=>{calls.push(args);return lines;}}};
    m.terminals={getById:()=>terminal}; assert.equal(await m.addTerminalContext('term'),true); assert.deepEqual(calls,[[600,200,true]]); assert.equal(m.pins.length,1);
    assert.equal(m.pins[0].startLine,601);assert.equal(m.pins[0].endLine,800);assert.equal(m.pins[0].text,lines.join('\n'));
    assert.equal(m.pins[0].terminalName,'zsh');assert.equal(m.pins[0].terminalSelection,false);assert.equal(context.terminalContextLabel(m.pins[0]),'zsh');
    terminal.isDisposed=true; assert.equal(await m.addTerminalContext('term'),false); assert.match(m.contextError,/已关闭/);
    terminal.isDisposed=false; terminal.buffer.getLines=()=>['']; assert.equal(await m.addTerminalContext('term'),false); assert.match(m.contextError,/没有输出/); assert.equal(m.pins.length,1);
});
test('recent terminal range excludes trimmed empty grid rows while retaining its real starting row',async()=>{
    const m=model(),lines=Array.from({length:200},(_,index)=>index<198?`output ${601+index}`:'   ');
    m.terminals={getById:()=>({terminalId:3,title:{label:'build'},getSelection:()=>'',buffer:{length:800,getLines:()=>lines}})};
    assert.equal(await m.addTerminalContext('term'),true);assert.equal(m.pins[0].startLine,601);assert.equal(m.pins[0].endLine,798);
    assert.equal(m.pins[0].text,lines.slice(0,198).join('\n'));assert.equal(m.pins[0].text.split('\n').length,198);
});
test('terminal selection range excludes an end at column zero and preserves wrapped buffer rows',async()=>{
    const m=model(),terminal={terminalId:4,title:{label:'build'},getSelection:()=> 'first selected line\r\nsecond selected line\r\n',
        getTerminal:()=>({getSelectionPosition:()=>({start:{x:3,y:39},end:{x:0,y:41}})}),buffer:{length:300,getLines(){throw Error('must prefer selection');}}};
    m.terminals={getById:()=>terminal};assert.equal(await m.addTerminalContext('term',true),true);
    assert.equal(m.pins[0].startLine,40);assert.equal(m.pins[0].endLine,41);assert.equal(m.pins[0].text,'first selected line\nsecond selected line');
    terminal.getSelection=()=> 'one logical line wrapped across three terminal rows';
    terminal.getTerminal=()=>({getSelectionPosition:()=>({start:{x:4,y:70},end:{x:9,y:72}})});
    assert.equal(await m.addTerminalContext('term',true),true);assert.equal(m.pins.length,2);assert.equal(m.pins[1].startLine,71);assert.equal(m.pins[1].endLine,73);
    assert.equal(m.pins[1].text,terminal.getSelection());assert.equal(m.pins[0].text,'first selected line\nsecond selected line');
});
test('whole terminal refresh keeps selected excerpts and repeated selection replaces only the same range',async()=>{
    const m=model(),terminal={id:'shell',title:{label:'zsh'},getSelection:()=> 'selected output',
        getTerminal:()=>({getSelectionPosition:()=>({start:{x:0,y:0},end:{x:15,y:0}})}),buffer:{length:1,getLines:()=>['whole output']}};
    m.terminals={getById:()=>terminal};assert.equal(await m.addTerminalContext('shell',true),true);
    assert.equal(await m.addTerminalContext('shell'),true);assert.equal(m.pins.length,2);
    terminal.buffer.getLines=()=>['refreshed whole output'];assert.equal(await m.addTerminalContext('shell'),true);assert.equal(m.pins.length,2);
    assert.equal(m.pins[0].text,'selected output');assert.equal(m.pins[1].text,'refreshed whole output');
    terminal.getSelection=()=> 'new selection';assert.equal(await m.addTerminalContext('shell',true),true);assert.equal(m.pins.length,2);
    assert.equal(m.pins[0].text,'refreshed whole output');assert.equal(m.pins[1].text,'new selection');
});
test('terminal selection without a verified range cannot attach different recent output or fabricate row one',async()=>{
    for(const getTerminal of [undefined,()=>({getSelectionPosition:()=>undefined})]){
        const m=model();let bufferReads=0;
        m.terminals={getById:()=>({terminalId:5,title:{label:'build'},getSelection:()=> 'selected text',getTerminal,buffer:{length:800,getLines:()=>{bufferReads++;return ['unselected output'];}}})};
        assert.equal(await m.addTerminalContext('term',true),false);assert.equal(m.pins.length,0);assert.equal(bufferReads,0);assert.ok(m.contextError);
    }
});
test('whole terminal attachment ignores any selection and explicit empty selection never falls back to whole output',async()=>{
    const m=model(),reads=[],terminal={id:'shell',title:{label:'zsh'},getSelection(){throw Error('whole terminal must not read selection');},buffer:{length:240,getLines:(...args)=>{reads.push(args);return ['whole terminal output'];}}};
    m.terminals={getById:()=>terminal};assert.equal(await m.addTerminalContext('shell'),true);assert.deepEqual(reads,[[40,200,true]]);
    assert.equal(m.pins[0].text,'whole terminal output');assert.equal(m.pins[0].startLine,41);assert.equal(m.pins[0].endLine,41);assert.equal(m.pins[0].terminalSelection,false);
    terminal.getSelection=()=>'';assert.equal(await m.addTerminalContext('shell',true),false);assert.equal(reads.length,1);assert.equal(m.pins[0].text,'whole terminal output');assert.match(m.contextError,/选择/);
});
test('terminal source activation uses its widget id and never creates terminals or opens file paths',async()=>{
    const m=model(),terminal={id:'shell:one',isDisposed:false},opened=[],lookups=[];
    m.terminals={getById:id=>{lookups.push(id);return id===terminal.id?terminal:undefined;},open:async(...args)=>opened.push(args),newTerminal(){throw Error('must not create a terminal');}};
    assert.equal(await m.openTerminalContext('terminal:shell:one'),true);assert.equal(opened.length,1);assert.equal(opened[0][0],terminal);assert.equal(opened[0][1].mode,'activate');
    for(const path of ['App/main.c','build #1 · 选区','terminal:']){assert.equal(await m.openTerminalContext(path),false);}assert.deepEqual(lookups,['shell:one']);
    assert.equal(await m.openTerminalContext('terminal:closed'),false);terminal.isDisposed=true;assert.equal(await m.openTerminalContext('terminal:shell:one'),false);assert.equal(opened.length,1);
    terminal.isDisposed=false;m.terminals.open=async()=>{throw Error('disposed during activation');};assert.equal(await m.openTerminalContext('terminal:shell:one'),false);
});
test('terminal name and selection metadata are validated, labels are bounded to captured names and old snapshots use a neutral fallback',()=>{
    const selected={kind:'terminal',path:'terminal:source-id',terminalName:'zsh',terminalSelection:true,text:'chosen output',version:1,startLine:3,endLine:3};
    assert.equal(context.terminalContextLabel(selected),'zsh (3)');assert.equal(context.terminalContextLabel({...selected,startLine:2}),'zsh (2-3)');
    assert.equal(context.terminalContextLabel({...selected,terminalSelection:false}),'zsh');assert.equal(context.terminalContextLabel({path:'terminal:source-id',startLine:2,endLine:3}),'终端');
    assert.deepEqual(JSON.parse(JSON.stringify(context.validateTutorContexts([selected],'ask')[0])),selected);
    const refs=history.chatContextRefs(undefined,[selected]);assert.equal(refs[0].terminalName,'zsh');assert.equal(refs[0].terminalSelection,true);assert.equal(history.isTutorContextRef(refs[0]),true);
    for(const terminalName of ['', 'bad\nname','x'.repeat(161),42]){
        assert.throws(()=>context.validateTutorContexts([{...selected,terminalName}],'ask'));assert.equal(history.isTutorContextRef({...refs[0],terminalName}),false);
    }
    for(const terminalSelection of ['true',1,null]){
        assert.throws(()=>context.validateTutorContexts([{...selected,terminalSelection}],'ask'));assert.equal(history.isTutorContextRef({...refs[0],terminalSelection}),false);
    }
    assert.throws(()=>context.validateTutorContexts([{...pin(),terminalName:'zsh'}],'ask'));assert.throws(()=>context.validateTutorContexts([{...pin(),terminalSelection:false}],'ask'));
    assert.equal(history.isTutorContextRef({kind:'file',path:'main.c',startLine:1,endLine:1,terminalName:'zsh'}),false);
    assert.equal(history.isTutorContextRef({kind:'file',path:'main.c',startLine:1,endLine:1,terminalSelection:false}),false);
});
test('terminal context validation keeps file path rules, shared budgets and workspace authorization',async()=>{
    const terminal={...pin('/not/a/file','terminal output'),kind:'terminal'};
    assert.equal(context.validateTutorContexts([terminal],'teach')[0].kind,'terminal');
    assert.equal(context.validateTutorContexts([{...terminal,startLine:71,endLine:73}],'ask')[0].endLine,73,'soft wrapped terminal output retains physical buffer range');
    assert.throws(()=>context.validateTutorContexts([{...terminal,text:'two\nlines',startLine:71,endLine:71}],'ask'));
    assert.throws(()=>context.validateTutorContexts([{...pin(),startLine:1,endLine:3}],'ask'),'file line counts remain exact');
    assert.throws(()=>context.validateTutorContexts([{...terminal,path:'bad\nname'}],'ask'));
    assert.throws(()=>context.validateTutorContexts([{...terminal,kind:'file'}],'ask'));
    assert.throws(()=>context.validateTutorContexts([{...terminal,text:'x'.repeat(65537)}],'ask'),/64 KiB/);
    const {TutorWorkspaceHost}=source('node/tutor/tutor-workspace-host.ts',{'../../common/tutor/tutor-context':context});
    const calls=[], host=Object.create(TutorWorkspaceHost.prototype); host.authorize=async(...args)=>calls.push(args);
    await host.contexts('workspace-0001','ask',[terminal]); assert.deepEqual(calls,[['workspace-0001']]);
    host.authorize=async()=>{throw Error('revoked');}; await assert.rejects(()=>host.contexts('workspace-0001','ask',[terminal]),/revoked/);
});


test('conversation sidebar toggles only layout, preserving active generation, draft, attachments and conversation identity',()=>{
    const storage=new Storage(),session=new Storage();
    const Model=source('browser/nodu-tutor-model.ts',modelStubs,{localStorage:storage,sessionStorage:session}).NoduTutorModel;
    const m=model(storage,Model);m.messages.ask.push(...pair('keep transcript'));m.drafts.ask='keep unsent text';m.contextDrafts.ask=[pin('main.h','int retained;')];m.persistConversation('ask');
    const before={id:m.activeConversationId,messages:m.messages.ask,pins:m.pins,epoch:m.epoch,owner:m.conversationStore.owner,session:[...session.data],storage:[...storage.data]};
    const busy={id:crypto.randomUUID(),mode:'ask',kind:'chat'};m.busy=busy;m.historyOpen=true;let notifications=0,calls=0;m.notify=()=>notifications++;
    m.service=new Proxy({}, {get(){return()=>{calls++;throw Error('layout must not call the service');};}});
    assert.equal(m.conversationSidebarOpen,false);m.setConversationSidebarOpen(true);
    assert.equal(m.conversationSidebarOpen,true);assert.equal(m.historyOpen,false);assert.equal(storage.getItem('nodu.tutor.conversation-sidebar'),'true');
    m.historyOpen=true;m.setConversationSidebarOpen(false);
    assert.equal(m.conversationSidebarOpen,false);assert.equal(m.historyOpen,false);assert.equal(storage.getItem('nodu.tutor.conversation-sidebar'),'false');
    assert.equal(m.activeConversationId,before.id);assert.equal(m.messages.ask,before.messages);assert.equal(m.messages.ask[0].text,'keep transcript');
    assert.equal(m.pins,before.pins);assert.equal(m.drafts.ask,'keep unsent text');assert.equal(m.busy,busy);assert.equal(m.epoch,before.epoch);assert.equal(m.conversationStore.owner,before.owner);
    assert.deepEqual([...session.data],before.session);assert.deepEqual([...storage.data].filter(([key])=>key!=='nodu.tutor.conversation-sidebar'),before.storage);
    assert.equal(calls,0);assert.equal(notifications,2);
});
test('conversation sidebar preference survives new, selection, project changes and window reload',async()=>{
    const storage=new Storage(),session=new Storage();
    const make=()=>model(storage,source('browser/nodu-tutor-model.ts',modelStubs,{localStorage:storage,sessionStorage:session}).NoduTutorModel);
    const m=make();m.setConversationSidebarOpen(true);m.messages.ask.push(...pair('first conversation'));m.drafts.ask='return to this draft';m.persistConversation('ask');const original=m.activeConversationId;
    await m.newConversation();assert.equal(m.conversationSidebarOpen,true);
    await m.selectConversation(original);assert.equal(m.conversationSidebarOpen,true);assert.equal(m.drafts.ask,'return to this draft');
    m.restoreConversations('another-project');assert.equal(m.conversationSidebarOpen,true);
    const reloaded=make();assert.equal(reloaded.conversationSidebarOpen,true);reloaded.setConversationSidebarOpen(false);
    assert.equal(make().conversationSidebarOpen,false);
});
test('conversation sidebar defaults closed for invalid or unavailable storage and stays usable after write failure',()=>{
    const key='nodu.tutor.conversation-sidebar';
    for(const value of [null,'', 'TRUE','1','undefined','{}','false']){
        const storage=new Storage();if(value!==null)storage.setItem(key,value);
        const Model=source('browser/nodu-tutor-model.ts',modelStubs,{localStorage:storage,sessionStorage:new Storage()}).NoduTutorModel;
        assert.equal(new Model().conversationSidebarOpen,false,`invalid or closed setting ${value}`);
    }
    const unavailable={getItem(){throw Error('read blocked');},setItem(){throw Error('write blocked');}};
    const Model=source('browser/nodu-tutor-model.ts',modelStubs,{localStorage:unavailable,sessionStorage:new Storage()}).NoduTutorModel;
    const m=new Model();let notifications=0;m.notify=()=>notifications++;
    assert.equal(m.conversationSidebarOpen,false);assert.doesNotThrow(()=>m.setConversationSidebarOpen(true));assert.equal(m.conversationSidebarOpen,true);
    assert.doesNotThrow(()=>m.setConversationSidebarOpen(false));assert.equal(m.conversationSidebarOpen,false);assert.equal(notifications,2);
    const storage=new Storage();storage.setItem=()=>{throw Error('quota');};
    const ReadableModel=source('browser/nodu-tutor-model.ts',modelStubs,{localStorage:storage,sessionStorage:new Storage()}).NoduTutorModel;
    const volatile=new ReadableModel();volatile.setConversationSidebarOpen(true);assert.equal(volatile.conversationSidebarOpen,true);assert.equal(new ReadableModel().conversationSidebarOpen,false);
});

test('schema 1 records without management metadata remain readable and unchanged by no-op saves',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),legacy=store.create('project','ask');
    legacy.messages=pair('旧问题。补充说明');legacy.title='旧问题。补充说明';legacy.updatedAt=1234;
    storage.setItem(conversationKey(legacy.id),JSON.stringify(legacy));const before=storage.getItem(conversationKey(legacy.id));
    const reopened=new history.TutorConversationStore(storage),restored=reopened.read(legacy.id,'project','ask');
    assert.equal(restored.schema,1);assert.equal(restored.customTitle,undefined);assert.equal(restored.archived,undefined);
    assert.equal(reopened.list('project','ask').length,1);assert.equal(reopened.history('project')[0].title,'旧问题。');
    assert.equal(reopened.save(restored).id,legacy.id);assert.equal(storage.getItem(conversationKey(legacy.id)),before);
});
test('invalid persisted management metadata and mismatched record identities are rejected, even with a clean cache',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask');c.messages=pair();const saved=store.save(c);
    const invalid=[...['', '   ', 'x'.repeat(61), 42, null, {}, ['name'], 'bad\u0000name', 'bad\nname', ' padded ', 'API_KEY=unsafe-token'].map(customTitle=>({customTitle})),
        ...['true',0,1,null,{}].map(archived=>({archived})),{id:crypto.randomUUID()}];
    for(const metadata of invalid){
        storage.setItem(conversationKey(saved.id),JSON.stringify({...saved,...metadata}));
        for(const reader of [store,new history.TutorConversationStore(storage)]){
            assert.equal(reader.read(saved.id,'project','ask'),undefined,JSON.stringify(metadata));
            assert.equal(reader.list('project','ask',true).length,0);assert.equal(reader.history('project').length,0);
            assert.throws(()=>reader.rename(saved.id,'project','ask','valid'),/对话不存在|记录无效/);
            assert.throws(()=>reader.setArchived(saved.id,'project','ask',true),/对话不存在|记录无效/);
        }
    }
});
test('rename rejects blank and overlong names, normalizes controls and whitespace, and redacts credentials',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask');c.messages=pair();const saved=store.save(c),before=storage.getItem(conversationKey(saved.id));
    for(const title of ['', ' \t\r\n ', '\u0000\u001b\u202e', null, 42]){assert.throws(()=>store.rename(saved.id,'project','ask',title),/不能为空/);}
    assert.throws(()=>store.rename(saved.id,'project','ask','长'.repeat(61)),/60/);assert.equal(storage.getItem(conversationKey(saved.id)),before);
    const renamed=store.rename(saved.id,'project','ask',' \t串口\u0000\u202e  调试\n记录\t ');assert.equal(renamed.customTitle,'串口 调试 记录');
    const secret='sk-'+'s'.repeat(24),safe=store.rename(saved.id,'project','ask','API_KEY='+secret);
    assert.ok(!safe.customTitle.includes(secret));assert.match(safe.customTitle,/已隐藏凭据/);assert.ok(!storage.getItem(conversationKey(saved.id)).includes(secret));
    assert.equal(store.rename(saved.id,'project','ask','长'.repeat(60)).customTitle.length,60);
    assert.equal(new history.TutorConversationStore(storage).read(saved.id,'project','ask').customTitle,'长'.repeat(60));
});
test('metadata operations reject missing, deleted, wrong-project and wrong-mode records without writes',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask');c.messages=pair();const saved=store.save(c),before=[...storage.data];
    for(const [id,project,mode] of [[crypto.randomUUID(),'project','ask'],[saved.id,'other','ask'],[saved.id,'project','teach']]){
        assert.throws(()=>store.rename(id,project,mode,'new title'),/对话不存在|当前项目和模式/);
        assert.throws(()=>store.setArchived(id,project,mode,true),/对话不存在|当前项目和模式/);
    }
    assert.throws(()=>store.setArchived(saved.id,'project','ask','true'),/归档状态无效/);assert.deepEqual([...storage.data],before);
    storage.removeItem(conversationKey(saved.id));assert.throws(()=>store.rename(saved.id,'project','ask','must not resurrect'),/对话不存在/);assert.equal(storage.length,0);
});
test('foreign metadata edits preserve raw pending messages, draft, contexts, identity, owner and content timestamp',()=>{
    const storage=new Storage(),a=new history.TutorConversationStore(storage),b=new history.TutorConversationStore(storage),c=a.create('project','ask');
    c.messages=pair('keep exact request');c.messages[1].status='pending';c.messages[1].note='still streaming';c.draft='  retain draft  ';c.contexts=[pin()];c.includeCode=false;
    const original=a.save(c),before=storedConversation(storage,original.id),renamed=b.rename(original.id,'project','ask','managed title');
    assert.equal(renamed.messages[1].status,'pending');assert.equal(renamed.messages[1].note,'still streaming');
    const archived=b.setArchived(original.id,'project','ask',true),after=storedConversation(storage,original.id);
    assert.deepEqual(after,{...before,customTitle:'managed title',archived:true});assert.equal(archived.id,original.id);assert.equal(archived.owner,a.owner);assert.equal(archived.updatedAt,original.updatedAt);assert.equal(storage.length,1);
    assert.equal(b.read(original.id,'project','ask').messages[1].status,'stopped');assert.equal(storedConversation(storage,original.id).messages[1].status,'pending');
});
test('ordinary stale saves cannot undo renaming or archiving and genuine foreign content edits fork with latest metadata',()=>{
    const storage=new Storage(),a=new history.TutorConversationStore(storage),b=new history.TutorConversationStore(storage),c=a.create('project','ask');c.messages=pair('original');
    const original=a.save(c),staleA=plain(original),staleB=b.read(original.id,'project','ask');
    b.rename(original.id,'project','ask','latest title');b.setArchived(original.id,'project','ask',true);const before=storage.getItem(conversationKey(original.id));
    for(const [store,stale] of [[a,staleA],[b,staleB]]){
        stale.customTitle='stale title';stale.archived=false;const unchanged=store.save(stale);
        assert.equal(unchanged.id,original.id);assert.equal(unchanged.owner,original.owner);assert.equal(unchanged.updatedAt,original.updatedAt);
        assert.equal(unchanged.customTitle,'latest title');assert.equal(unchanged.archived,true);assert.equal(storage.getItem(conversationKey(original.id)),before);
    }
    staleB.messages.push(...pair('window b change'));const fork=b.save(staleB);
    assert.notEqual(fork.id,original.id);assert.equal(fork.owner,b.owner);assert.equal(fork.customTitle,'latest title');assert.equal(fork.archived,true);
    assert.equal(storage.getItem(conversationKey(original.id)),before);assert.equal(storage.length,2);
    staleA.draft='owner continues content';const continued=a.save(staleA);assert.equal(continued.id,original.id);assert.equal(continued.customTitle,'latest title');assert.equal(continued.archived,true);
    assert.equal(a.list('project','ask').length,0);assert.equal(a.list('project','ask',true).length,2);
});
test('restoring archive metadata remains authoritative over stale true snapshots, including subsequent forks',()=>{
    const storage=new Storage(),a=new history.TutorConversationStore(storage),b=new history.TutorConversationStore(storage),c=a.create('project','ask');c.messages=pair();
    const original=a.save(c);a.rename(original.id,'project','ask','kept name');a.setArchived(original.id,'project','ask',true);const stale=b.read(original.id,'project','ask');
    a.setArchived(original.id,'project','ask',false);assert.equal(b.save(stale).archived,false);assert.equal(storage.length,1);
    stale.draft='fork after restore';const fork=b.save(stale);assert.notEqual(fork.id,original.id);assert.equal(fork.archived,false);assert.equal(fork.customTitle,'kept name');
    assert.equal(a.list('project','ask').length,2);
});
test('archiving is reversible, list filters by default, and history includes both modes without reordering content',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),ask=store.create('project','ask'),teach=store.create('project','teach');
    ask.messages=pair('ask first');teach.messages=pair('teach first');ask.updatedAt=100;teach.updatedAt=200;
    storage.setItem(conversationKey(ask.id),JSON.stringify(ask));storage.setItem(conversationKey(teach.id),JSON.stringify(teach));
    store.rename(ask.id,'project','ask','ask name');store.setArchived(ask.id,'project','ask',true);store.setArchived(teach.id,'project','teach',true);
    assert.equal(store.list('project','ask').length,0);assert.equal(store.list('project','teach').length,0);
    assert.equal(store.list('project','ask',true)[0].archived,true);assert.equal(store.history('other').length,0);
    assert.deepEqual(plain(store.history('project').map(c=>[c.id,c.archived,c.updatedAt])),[[teach.id,true,200],[ask.id,true,100]]);
    store.setArchived(ask.id,'project','ask',false);assert.equal(store.list('project','ask')[0].id,ask.id);
    assert.equal(store.history('project').find(c=>c.id===ask.id).title,'ask name');assert.equal(storage.length,2);
});
test('failed metadata writes remain visible in memory and retry merges latest owner content and unrelated archive metadata',()=>{
    const disk=new Storage(),a=new history.TutorConversationStore(disk),proxy=Object.create(disk),b=new history.TutorConversationStore(proxy),c=a.create('project','ask');
    c.messages=pair('before');const original=a.save(c),before=disk.getItem(conversationKey(original.id));proxy.setItem=()=>{throw Error('quota');};
    const renamed=b.rename(original.id,'project','ask','offline rename');assert.equal(renamed.id,original.id);assert.match(b.storageError,/暂未保存/);
    assert.equal(b.read(original.id,'project','ask').customTitle,'offline rename');assert.equal(b.history('project')[0].title,'offline rename');assert.equal(disk.getItem(conversationKey(original.id)),before);
    original.messages.push(...pair('owner latest reply'));original.draft='owner latest draft';const latest=a.save(original);a.setArchived(original.id,'project','ask',true);
    assert.equal(b.read(original.id,'project','ask').messages.length,4);assert.equal(b.read(original.id,'project','ask').archived,true);
    proxy.setItem=disk.setItem.bind(disk);b.flush();assert.equal(b.storageError,undefined);
    const reopened=new history.TutorConversationStore(disk).read(original.id,'project','ask');
    assert.equal(reopened.messages.length,4);assert.equal(reopened.draft,'owner latest draft');assert.equal(reopened.updatedAt,latest.updatedAt);
    assert.equal(reopened.customTitle,'offline rename');assert.equal(reopened.archived,true);assert.equal(reopened.owner,a.owner);assert.equal(disk.length,1);
});
test('failed content writes retry with newer foreign title and archive rather than stale cached metadata',()=>{
    const disk=new Storage(),proxy=Object.create(disk),a=new history.TutorConversationStore(proxy),b=new history.TutorConversationStore(disk),c=a.create('project','ask');c.messages=pair('original');const saved=a.save(c);
    proxy.setItem=()=>{throw Error('quota');};saved.messages.push(...pair('unsaved reply'));saved.draft='unsaved draft';const pending=a.save(saved);
    b.rename(saved.id,'project','ask','foreign title');b.setArchived(saved.id,'project','ask',true);
    assert.equal(a.read(saved.id,'project','ask').messages.length,4);assert.equal(a.read(saved.id,'project','ask').customTitle,'foreign title');assert.equal(a.read(saved.id,'project','ask').archived,true);
    proxy.setItem=disk.setItem.bind(disk);const retried=a.save(pending);assert.equal(a.storageError,undefined);assert.equal(retried.id,saved.id);assert.equal(retried.updatedAt,pending.updatedAt);
    assert.equal(retried.customTitle,'foreign title');assert.equal(retried.archived,true);const reopened=b.read(saved.id,'project','ask');
    assert.equal(reopened.messages.length,4);assert.equal(reopened.draft,'unsaved draft');assert.equal(reopened.customTitle,'foreign title');assert.equal(reopened.archived,true);assert.equal(disk.length,1);
});
test('failed rename and archive patches compose, preserve content and can be retried by an unchanged save',()=>{
    const storage=new Storage(),a=new history.TutorConversationStore(storage),b=new history.TutorConversationStore(storage),c=a.create('project','ask');c.messages=pair();const original=a.save(c),before=storedConversation(storage,original.id),write=storage.setItem.bind(storage);
    storage.setItem=()=>{throw Error('unavailable');};b.rename(original.id,'project','ask','pending name');b.setArchived(original.id,'project','ask',true);
    assert.equal(b.list('project','ask').length,0);assert.equal(b.history('project')[0].archived,true);assert.equal(b.history('project')[0].title,'pending name');assert.equal(storage.length,1);
    storage.setItem=write;const retried=b.save(b.read(original.id,'project','ask'));assert.equal(b.storageError,undefined);assert.equal(retried.id,original.id);assert.equal(retried.owner,a.owner);
    assert.deepEqual(storedConversation(storage,original.id),{...before,customTitle:'pending name',archived:true});
});
test('metadata-only retries stay bounded without evicting failed writes or leaking changes through rejected operations',()=>{
    const storage=new Storage(),a=new history.TutorConversationStore(storage),ids=[];
    for(let i=0;i<41;i++){const c=a.create('project','ask');c.messages=pair('record '+i);storage.setItem(conversationKey(c.id),JSON.stringify(c));ids.push(c.id);}
    const b=new history.TutorConversationStore(storage);storage.setItem=()=>{throw Error('quota');};
    for(const id of ids.slice(0,40)){b.rename(id,'project','ask','pending');}
    assert.throws(()=>b.setArchived(ids[40],'project','ask',true),/未保存对话已达上限/);
    assert.equal(b.read(ids[0],'project','ask').customTitle,'pending');assert.equal(b.read(ids[40],'project','ask').archived,undefined);assert.equal(storage.length,41);
});
test('display titles use custom names then the first original question sentence or line without touching messages',()=>{
    const store=new history.TutorConversationStore(new Storage()),c=store.create('project','ask');c.messages=pair('  如何初始化串口？然后说明波特率。\n第二行');c.title='stale generated title';c.draft='different unsent question';c.contexts=[pin()];
    const before=JSON.stringify(c);assert.equal(history.conversationDisplayTitle(c),'如何初始化串口？');assert.equal(JSON.stringify(c),before);
    c.customTitle='自己的名字';assert.equal(history.conversationDisplayTitle(c),'自己的名字');delete c.customTitle;
    c.messages[0].text='First sentence. Second question?';assert.equal(history.conversationDisplayTitle(c),'First sentence.');
    c.messages[0].text='Explain main.c\nDo not use this line';assert.equal(history.conversationDisplayTitle(c),'Explain main.c');
    c.messages.push(...pair('newer question'));assert.equal(history.conversationDisplayTitle(c),'Explain main.c');
});
test('display titles are at most 40 Unicode characters and redact before sentence selection or truncation',()=>{
    const store=new history.TutorConversationStore(new Storage()),c=store.create('project','ask'),secret='sk-'+'q'.repeat(24);c.messages=pair('中'.repeat(41));
    assert.equal(history.conversationDisplayTitle(c),'中'.repeat(39)+'…');c.messages[0].text='𠮷'.repeat(41);assert.equal(Array.from(history.conversationDisplayTitle(c)).length,40);assert.ok(!history.conversationDisplayTitle(c).includes('\ufffd'));
    c.customTitle='名'.repeat(60);assert.equal(history.conversationDisplayTitle(c),'名'.repeat(39)+'…');delete c.customTitle;
    c.messages[0].text='前'.repeat(10)+secret+' end';assert.equal(history.conversationDisplayTitle(c),'前'.repeat(10)+'[已隐藏凭据] end');
    c.messages[0].text='api_key=abcdef.secret?private-more';assert.equal(history.conversationDisplayTitle(c),'api_key=[已隐藏凭据]');
    assert.ok(c.messages[0].text.includes('private-more'),'displaying a title must not alter a message');
});
test('display titles fall back to trimmed drafts, context names and neutral empty labels in both modes',()=>{
    const store=new history.TutorConversationStore(new Storage()),c=store.create('project','ask');c.title='';c.draft=' \t draft   question\n ';
    assert.equal(history.conversationDisplayTitle(c),'draft question');c.draft=' \t ';c.contexts=[pin('App/main.c')];assert.equal(history.conversationDisplayTitle(c),'main.c 的提问');
    c.mode='teach';assert.equal(history.conversationDisplayTitle(c),'main.c 的教学');
    c.contexts=[{kind:'terminal',path:'terminal:build-id',terminalName:'build',text:'output',version:1,startLine:1,endLine:1}];assert.equal(history.conversationDisplayTitle(c),'build 的教学');
    c.contexts=[];assert.equal(history.conversationDisplayTitle(c),'新对话');c.title='新对话';assert.equal(history.conversationDisplayTitle(c),'新对话');
    c.title='legacy explicit title';assert.equal(history.conversationDisplayTitle(c),'legacy explicit title');
});
test('history title is independent of the durable legacy 60-character title and context-only records have useful titles',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask');c.messages=pair('第一句。'+'余'.repeat(70));const saved=store.save(c);
    assert.equal(storedConversation(storage,saved.id).title.length,60);assert.equal(store.history('project')[0].title,'第一句。');assert.equal(saved.messages[0].text,c.messages[0].text);
    const contextOnly=store.create('project','teach');contextOnly.contexts=[pin('App/main.c')];const pinned=store.save(contextOnly),entry=store.history('project').find(c=>c.id===pinned.id);
    assert.equal(entry.title,'main.c 的教学');assert.equal(entry.preview,'main.c');assert.equal(entry.empty,false);assert.equal(entry.hasDraft,false);assert.equal(entry.status,undefined);
});
test('history status comes only from the latest assistant while pending recovers to stopped without persistence',()=>{
    for(const status of ['pending','done','stopped','failed']){
        const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask');c.messages=pair('first');c.messages.push(...pair('second'));c.messages[3].status=status;
        c.messages.push({id:crypto.randomUUID(),role:'user',text:'new user without an answer',status:'done'});const saved=store.save(c),entry=store.history('project')[0];
        assert.equal(entry.status,status==='pending'?'stopped':status);assert.equal(storedConversation(storage,saved.id).messages[3].status,status);
    }
    const store=new history.TutorConversationStore(new Storage()),userOnly=store.create('project','teach');userOnly.messages=[pair('goal request')[0]];store.save(userOnly);assert.equal(store.history('project')[0].status,undefined);
});
test('history trims preview and hasDraft, redacts legacy text, and marks only genuinely contentless entries empty',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),blank=store.create('project','ask');blank.title='obsolete title';blank.draft=' \n\t ';
    blank.messages=[{id:crypto.randomUUID(),role:'user',text:' \t ',status:'done'}];storage.setItem(conversationKey(blank.id),JSON.stringify(blank));
    let entry=store.history('project')[0];assert.equal(entry.empty,true);assert.equal(entry.preview,'');assert.equal(entry.hasDraft,false);assert.equal(entry.status,undefined);
    store.rename(blank.id,'project','ask','named empty record');assert.equal(store.history('project')[0].empty,false);
    const c=store.create('project','ask');c.messages=pair('question');c.messages[1].text=' \n answer   with \t spaces  ';c.draft=' \t ';const saved=store.save(c);
    entry=store.history('project').find(c=>c.id===saved.id);assert.equal(entry.preview,'answer with spaces');assert.equal(entry.hasDraft,false);assert.equal(entry.empty,false);
    saved.draft=' \n  draft    with spaces  ';store.save(saved);entry=store.history('project').find(c=>c.id===saved.id);assert.equal(entry.preview,'draft with spaces');assert.equal(entry.hasDraft,true);
    const legacy={...storedConversation(storage,saved.id),draft:'API_KEY=private-value'};storage.setItem(conversationKey(saved.id),JSON.stringify(legacy));
    assert.equal(store.history('project').find(c=>c.id===saved.id).preview,'API_KEY=[已隐藏凭据]');
    const referenced=store.create('project','ask');referenced.messages=[{id:crypto.randomUUID(),role:'user',text:'',status:'done',contextRefs:history.chatContextRefs(undefined,[pin()])}];const kept=store.save(referenced);
    assert.equal(store.history('project').find(c=>c.id===kept.id).empty,false);
});
test('whitespace-only composers do not become permanent records but named, attached and existing empty records are preserved',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage);
    for(const draft of ['', '   ', '\t\r\n', '\u3000\u00a0']){
        const c=store.create('project','ask');c.draft=draft;c.includeCode=false;const saved=store.save(c);assert.equal(saved.id,c.id);assert.equal(saved.draft,draft);assert.equal(storage.getItem(conversationKey(c.id)),null);
    }
    assert.equal(store.history('project').length,0);
    const named=store.create('project','ask');named.customTitle='named';store.save(named);assert.equal(store.history('project')[0].empty,false);
    const c=store.create('project','ask');c.draft='real draft';const saved=store.save(c);saved.draft=' \t ';store.save(saved);
    assert.ok(store.read(saved.id,'project','ask'));assert.equal(store.history('project').find(c=>c.id===saved.id).empty,true);
    const archived=store.setArchived(saved.id,'project','ask',true);assert.equal(archived.id,saved.id);assert.equal(store.history('project').find(c=>c.id===saved.id).empty,true);
});
test('store metadata management and history queries never send, restore or replay model requests',()=>{
    const storage=new Storage(),m=model(storage);m.messages.ask.push(...pair('local history only'));m.drafts.ask='keep composer';m.contextDrafts.ask=[pin()];m.persistConversation('ask');
    const id=m.activeConversationId,before={messages:JSON.stringify(m.messages.ask),draft:m.drafts.ask,pins:JSON.stringify(m.pins),epoch:m.epoch};let calls=0;
    m.service=new Proxy({}, {get(){return()=>{calls++;throw Error('must remain local');};}});
    m.conversationStore.rename(id,'project-inode-one','ask','local name');m.conversationStore.setArchived(id,'project-inode-one','ask',true);
    m.conversationStore.history('project-inode-one');m.conversationStore.list('project-inode-one','ask');m.conversationStore.setArchived(id,'project-inode-one','ask',false);m.conversationStore.flush();
    assert.equal(calls,0);assert.equal(m.activeConversationId,id);assert.equal(JSON.stringify(m.messages.ask),before.messages);assert.equal(m.drafts.ask,before.draft);assert.equal(JSON.stringify(m.pins),before.pins);assert.equal(m.epoch,before.epoch);
});
test('storage and previews redact full credentials before truncation and legacy titles use their first sentence',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask'),secret='sk-'+'a'.repeat(24);c.messages=pair('x'.repeat(54)+' '+secret);const saved=store.save(c),raw=storedConversation(storage,saved.id);
    assert.ok(!raw.title.includes('sk-'),'truncating first must not leave a short undetectable token prefix');assert.ok(!JSON.stringify(raw).includes(secret));assert.ok(raw.title.length<=60);
    saved.draft='x'.repeat(119)+' next';store.save(saved);assert.equal(store.history('project')[0].preview,'x'.repeat(119));
    const legacy=store.create('project','ask');legacy.title='旧记录首句。补充说明';assert.equal(history.conversationDisplayTitle(legacy),'旧记录首句。');
});
test('metadata no-ops never rewrite disk and mutating their returned records cannot mutate the store cache',()=>{
    const storage=new Storage(),store=new history.TutorConversationStore(storage),c=store.create('project','ask');c.messages=pair();const original=store.save(c);
    store.rename(original.id,'project','ask','stable name');store.setArchived(original.id,'project','ask',true);const before=storage.getItem(conversationKey(original.id)),write=storage.setItem.bind(storage);let writes=0;
    storage.setItem=(key,value)=>{writes++;write(key,value);};const renamed=store.rename(original.id,'project','ask','stable name'),archived=store.setArchived(original.id,'project','ask',true);
    renamed.messages[0].text='external mutation';archived.customTitle='external title';assert.equal(writes,0);assert.equal(storage.getItem(conversationKey(original.id)),before);
    assert.equal(store.read(original.id,'project','ask').messages[0].text,'question');assert.equal(store.read(original.id,'project','ask').customTitle,'stable name');
});

test('model metadata actions preserve the live composer and goal, stay local, and archived conversations can be selected and restored',async()=>{
    const storage=new Storage(),m=model(storage);m.messages.ask.push(...pair('original question'));m.drafts.ask='saved draft';m.contextDrafts.ask=[pin('main.h')];m.persistConversation('ask');
    const id=m.activeConversationId,owner=m.conversationRecords.ask.owner;m.drafts.ask='latest unsaved draft';m.contextDrafts.ask.push(pin('other.h','int latest;'));m.messages.ask.push(...pair('latest turn'));
    m.goalState={...m.goalState,status:'active',revision:9};m.buffer={path:'main.c',text:'int unsaved;',version:3,line:1};m.includeCode=false;
    const before={messages:m.messages.ask,messageText:JSON.stringify(m.messages.ask),pins:m.pins,pinText:JSON.stringify(m.pins),draft:m.drafts.ask,goal:m.goalState,goalText:JSON.stringify(m.goalState),buffer:m.buffer,epoch:m.epoch};
    const forbidden=[];m.service=new Proxy({}, {get:(_,name)=>()=>{forbidden.push(String(name));throw Error('metadata must remain local');}});
    m.renameConversation(id,'ask','local conversation name');m.setConversationArchived(id,'ask',true);
    assert.equal(m.activeConversationId,id);assert.equal(m.activeConversationArchived,true);assert.equal(m.activeConversationTitle,'local conversation name');assert.equal(m.conversationName(id,'ask'),'local conversation name');
    assert.equal(m.conversations.length,0);assert.equal(m.historyEntries.find(c=>c.id===id).archived,true);assert.equal(m.conversationRecords.ask.owner,owner);assert.equal(storage.length,1);
    assert.equal(m.messages.ask,before.messages);assert.equal(JSON.stringify(m.messages.ask),before.messageText);assert.equal(m.pins,before.pins);assert.equal(JSON.stringify(m.pins),before.pinText);
    assert.equal(m.drafts.ask,before.draft);assert.equal(m.goalState,before.goal);assert.equal(JSON.stringify(m.goalState),before.goalText);assert.equal(m.buffer,before.buffer);assert.equal(m.epoch,before.epoch);assert.equal(m.includeCode,false);assert.deepEqual(forbidden,[]);
    const persisted=new history.TutorConversationStore(storage).read(id,'project-inode-one','ask');assert.equal(persisted.archived,true);assert.equal(persisted.draft,before.draft);assert.equal(JSON.stringify(persisted.messages),before.messageText);assert.equal(JSON.stringify(persisted.contexts),before.pinText);
    const restores=[];m.service=new Proxy({cancelChat:async()=>{},setPresentation:async()=>{},restoreChatHistory:async(...args)=>restores.push(args)}, {get:(target,name)=>name in target?target[name]:()=>{forbidden.push(String(name));throw Error('archive recovery must not send or run hardware');}});
    await m.newConversation();await m.selectConversation(id,'ask');assert.equal(m.activeConversationId,id);assert.equal(m.activeConversationArchived,true);assert.equal(m.drafts.ask,before.draft);assert.equal(JSON.stringify(m.messages.ask),before.messageText);assert.equal(JSON.stringify(m.pins),before.pinText);
    const restoreCount=restores.length;m.setConversationArchived(id,'ask',false);assert.equal(m.activeConversationArchived,false);assert.equal(m.conversations[0].id,id);assert.equal(m.conversationName(id,'ask'),'local conversation name');
    assert.equal(new history.TutorConversationStore(storage).read(id,'project-inode-one','ask').archived,false);assert.equal(restores.length,restoreCount);assert.ok(restoreCount>=2);assert.deepEqual(forbidden,[]);assert.equal(m.goalState,before.goal);
});
test('model metadata actions reject busy and history-syncing states before any persistence, notification or service call',()=>{
    const storage=new Storage(),m=model(storage);m.messages.ask.push(...pair());m.persistConversation('ask');const id=m.activeConversationId;
    m.drafts.ask='unsaved draft must remain unsaved';m.contextDrafts.ask=[pin()];const before={disk:[...storage.data],session:[...sessionStorage.data],record:JSON.stringify(m.conversationRecords),messages:JSON.stringify(m.messages),pins:JSON.stringify(m.pins),goal:JSON.stringify(m.goalState),epoch:m.epoch};
    const calls=[];m.notify=()=>calls.push('notify');m.service=new Proxy({}, {get:(_,name)=>()=>calls.push(String(name))});
    for(const method of ['save','rename','setArchived']){const original=m.conversationStore[method].bind(m.conversationStore);m.conversationStore[method]=(...args)=>{calls.push(method);return original(...args);};}
    for(const gate of ['busy','historySyncing']){
        if(gate==='busy')m.busy={id:crypto.randomUUID(),mode:'ask',kind:'chat'};else m.historySyncing=true;
        assert.throws(()=>m.renameConversation(id,'ask','blocked name'),/等待.*完成/);assert.throws(()=>m.setConversationArchived(id,'ask',true),/等待.*完成/);
        if(gate==='busy')m.busy=undefined;else m.historySyncing=false;
    }
    assert.deepEqual(calls,[]);assert.deepEqual([...storage.data],before.disk);assert.deepEqual([...sessionStorage.data],before.session);assert.equal(JSON.stringify(m.conversationRecords),before.record);
    assert.equal(JSON.stringify(m.messages),before.messages);assert.equal(JSON.stringify(m.pins),before.pins);assert.equal(m.drafts.ask,'unsaved draft must remain unsaved');assert.equal(JSON.stringify(m.goalState),before.goal);assert.equal(m.epoch,before.epoch);
});
test('model metadata actions reject missing, corrupt, other-project and wrong-mode targets without touching active state',()=>{
    const storage=new Storage(),m=model(storage);m.messages.ask.push(...pair('active'));m.persistConversation('ask');const active=m.activeConversationId;
    const foreign=m.conversationStore.create('another-project','ask');foreign.messages=pair('other project');m.conversationStore.save(foreign);
    const teaching=m.conversationStore.create('project-inode-one','teach');teaching.messages=pair('other mode');m.conversationStore.save(teaching);
    const corrupt=m.conversationStore.create('project-inode-one','ask');corrupt.messages=pair('corrupt');storage.setItem(conversationKey(corrupt.id),JSON.stringify({...corrupt,archived:'yes'}));
    m.drafts.ask='do not persist on invalid target';m.contextDrafts.ask=[pin()];m.goalState={...m.goalState,status:'active',revision:7};const before={disk:[...storage.data],session:[...sessionStorage.data],records:JSON.stringify(m.conversationRecords),messages:JSON.stringify(m.messages),pins:JSON.stringify(m.pins),goal:JSON.stringify(m.goalState)};
    let saves=0,notifications=0;const save=m.conversationStore.save.bind(m.conversationStore);m.conversationStore.save=(...args)=>{saves++;return save(...args);};m.notify=()=>notifications++;
    m.service=new Proxy({}, {get:(_,name)=>()=>{throw Error('unexpected service call '+String(name));}});
    for(const [id,mode] of [[crypto.randomUUID(),'ask'],[corrupt.id,'ask'],[foreign.id,'ask'],[teaching.id,'ask'],[active,'teach']]){
        assert.throws(()=>m.renameConversation(id,mode,'must not rename'),/对话不存在|记录无效|当前项目和模式/);assert.throws(()=>m.setConversationArchived(id,mode,true),/对话不存在|记录无效|当前项目和模式/);
    }
    m.conversationProject=undefined;try{assert.throws(()=>m.renameConversation(active,'ask','no project'),/等待.*完成/);assert.throws(()=>m.setConversationArchived(active,'ask',true),/等待.*完成/);}finally{m.conversationProject='project-inode-one';}
    assert.equal(saves,0);assert.equal(notifications,0);assert.equal(m.activeConversationId,active);assert.deepEqual([...storage.data],before.disk);assert.deepEqual([...sessionStorage.data],before.session);
    assert.equal(JSON.stringify(m.conversationRecords),before.records);assert.equal(JSON.stringify(m.messages),before.messages);assert.equal(JSON.stringify(m.pins),before.pins);assert.equal(m.drafts.ask,'do not persist on invalid target');assert.equal(JSON.stringify(m.goalState),before.goal);
});
test('model history overlays only active busy status and derives header titles from live draft, contexts and messages',()=>{
    const storage=new Storage(),m=model(storage);m.messages.ask.push(...pair('active question'));m.persistConversation('ask');const active=m.activeConversationId;
    const old=m.conversationStore.create('project-inode-one','ask');old.messages=pair('interrupted historical question');old.messages[1].status='pending';const saved=m.conversationStore.save(old);m.conversationStore.setArchived(saved.id,'project-inode-one','ask',true);
    const teaching=m.conversationStore.create('project-inode-one','teach');teaching.messages=pair('interrupted teaching');teaching.messages[1].status='pending';const teach=m.conversationStore.save(teaching);
    const disk=[...storage.data];m.busy={id:crypto.randomUUID(),mode:'ask',kind:'chat'};let entries=m.historyEntries;
    assert.equal(entries.find(c=>c.id===active).status,'pending');assert.equal(entries.find(c=>c.id===saved.id).status,'stopped');assert.equal(entries.find(c=>c.id===saved.id).archived,true);assert.equal(entries.find(c=>c.id===teach.id).status,'stopped');
    m.busy=undefined;assert.equal(m.historyEntries.find(c=>c.id===active).status,'done');m.messages.ask.at(-1).status='failed';assert.equal(m.historyEntries.find(c=>c.id===active).status,'failed');
    m.messages.ask[0].text='当前真实问题？其余内容';assert.equal(m.activeConversationTitle,'当前真实问题？');assert.equal(m.historyEntries.find(c=>c.id===active).title,'当前真实问题？');assert.deepEqual([...storage.data],disk);
    const draftOnly=model();draftOnly.drafts.ask=' \t current unsaved question  ';assert.equal(draftOnly.activeConversationTitle,'current unsaved question');draftOnly.drafts.ask=' \n ';draftOnly.contextDrafts.ask=[pin('App/main.c')];assert.equal(draftOnly.activeConversationTitle,'main.c 的提问');
    assert.equal(storedConversation(storage,saved.id).messages[1].status,'pending');assert.equal(storedConversation(storage,teach.id).messages[1].status,'pending');
});
test('model metadata persistence failures report an error, preserve the latest composer and remain retryable',()=>{
    const silentSuccesses=[];
    for(const action of ['rename','archive'])for(const failure of ['content pre-save','metadata write']){
        const storage=new Storage(),m=model(storage);m.messages.ask.push(...pair('disk reply'));m.drafts.ask='disk draft';m.contextDrafts.ask=[pin()];m.persistConversation('ask');const id=m.activeConversationId,write=storage.setItem.bind(storage);
        m.messages.ask.push(...pair('latest unsaved reply'));m.drafts.ask='latest unsaved draft';m.contextDrafts.ask.push(pin('latest.h'));m.goalState={...m.goalState,status:'active',revision:5};
        if(failure==='metadata write')m.persistConversation('ask');
        const before={disk:[...storage.data],messages:m.messages.ask,messageText:JSON.stringify(m.messages.ask),pins:m.pins,pinText:JSON.stringify(m.pins),draft:m.drafts.ask,goal:m.goalState};let calls=0;
        m.service=new Proxy({}, {get:()=>()=>{calls++;throw Error('persistence failures must stay local');}});storage.setItem=()=>{throw Error('quota exceeded');};
        let reported;try{if(action==='rename')m.renameConversation(id,'ask','retryable name');else m.setConversationArchived(id,'ask',true);}catch(error){reported=error;}
        assert.match(m.historyStorageError,/暂未保存/);assert.equal(m.activeConversationId,id);assert.equal(m.messages.ask,before.messages);assert.equal(JSON.stringify(m.messages.ask),before.messageText);assert.equal(m.pins,before.pins);assert.equal(JSON.stringify(m.pins),before.pinText);assert.equal(m.drafts.ask,before.draft);assert.equal(m.goalState,before.goal);assert.equal(calls,0);assert.deepEqual([...storage.data],before.disk);
        const memory=m.conversationStore.read(id,'project-inode-one','ask');assert.equal(memory.draft,before.draft);assert.equal(JSON.stringify(memory.messages),before.messageText);assert.equal(JSON.stringify(memory.contexts),before.pinText);
        if(reported)assert.match(reported.message,/暂未保存|quota/i);else silentSuccesses.push(`${action}: ${failure}`);
        storage.setItem=write;m.retryHistorySave();assert.equal(m.historyStorageError,undefined);const reopened=new history.TutorConversationStore(storage).read(id,'project-inode-one','ask');
        assert.equal(reopened.draft,before.draft);assert.equal(JSON.stringify(reopened.messages),before.messageText);assert.equal(JSON.stringify(reopened.contexts),before.pinText);assert.equal(m.drafts.ask,before.draft);
        if(action==='rename')m.renameConversation(id,'ask','retryable name');else m.setConversationArchived(id,'ask',true);
        const saved=new history.TutorConversationStore(storage).read(id,'project-inode-one','ask');assert.equal(action==='rename'?saved.customTitle:saved.archived,action==='rename'?'retryable name':true);assert.equal(calls,0);
    }
    assert.deepEqual(silentSuccesses,[],'metadata APIs must throw rather than return apparent success when storage is still dirty');
});
test('model conversationName preserves full 41-to-60-character custom titles while header and history titles remain abbreviated',()=>{
    for(const length of [41,50,60]){
        const storage=new Storage(),m=model(storage);m.messages.ask.push(...pair('original question'));m.persistConversation('ask');const id=m.activeConversationId,title='名'.repeat(length);
        m.renameConversation(id,'ask',title);assert.equal(m.conversationName(id,'ask'),title);assert.equal(m.conversationRecords.ask.customTitle,title);assert.equal(m.activeConversationTitle,'名'.repeat(39)+'…');assert.equal(m.historyEntries.find(c=>c.id===id).title,'名'.repeat(39)+'…');
        const other=m.conversationStore.create('project-inode-one','ask');other.messages=pair('inactive named conversation');const historical=m.conversationStore.save(other);m.conversationStore.rename(historical.id,'project-inode-one','ask',title);
        assert.equal(m.conversationName(historical.id,'ask'),title);assert.equal(m.historyEntries.find(c=>c.id===historical.id).title,'名'.repeat(39)+'…');assert.equal(new history.TutorConversationStore(storage).read(id,'project-inode-one','ask').customTitle,title);
    }
});

test('copy ranges exclude an untouched next line and normalize CRLF without expanding partial lines',()=>{
 assert.deepEqual(plain(context.tutorSelection('first\r\nsecond\r\n',4,6,1)),{text:'first\nsecond',startLine:4,endLine:5});
 assert.deepEqual(plain(context.tutorSelection('suffix\r\nprefix',4,5,7)),{text:'suffix\nprefix',startLine:4,endLine:5});
 assert.deepEqual(plain(context.tutorSelection('x',9,9,12)),{text:'x',startLine:9,endLine:9});
});
test('a file read started in one conversation cannot attach to a newly created conversation',async()=>{
 const m=model();m.drafts.ask='original draft';let resolve;
 m.service.readChatContext=async()=>new Promise(done=>resolve=done);
 const pending=m.addContextFile('main.c');await tick();const original=m.activeConversationId;
 await m.newConversation();assert.notEqual(m.activeConversationId,original);resolve(pin());
 assert.equal(await pending,false);assert.equal(m.pins.length,0);assert.equal(m.contextError,undefined);
});
test('copy-time selection authorization cannot attach to a different conversation or overwrite its errors',async()=>{
 const m=model();m.drafts.ask='original';let reject;
 m.service.authorizeChatContexts=async()=>new Promise((_,fail)=>reject=fail);
 const pending=m.addContextSnapshot({...pin(),kind:'selection'});await tick();await m.newConversation();
 m.contextError='new conversation error';reject(Error('old authorization failure'));
 assert.equal(await pending,false);assert.equal(m.pins.length,0);assert.equal(m.contextError,'new conversation error');
});
test('copied selection keeps its source snapshot after the active editor changes',async()=>{
 const m=model();m.buffer={path:'other.c',text:'int other;',version:4,line:1};
 const snapshot={kind:'selection',path:'main.c',text:'one\ntwo',version:2,startLine:7,endLine:8};
 assert.equal(await m.addContextSnapshot(snapshot),true);
 assert.deepEqual(plain(m.pins[0]),snapshot);assert.equal(m.buffer.path,'other.c');
});

test('pasting then immediately sending waits for file reading and attachment authorization without losing the draft',async()=>{
 const m=model();m.drafts.ask='inspect this file';let read,authorize,requests=[];
 m.service.readChatContext=async()=>new Promise(resolve=>read=resolve);
 m.service.authorizeChatContexts=async()=>new Promise(resolve=>authorize=resolve);
 m.service.chat=async request=>{requests.push(request);return {ok:true,answer:{text:'answer',annotations:[]}};};
 const pending=m.addContextFile('main.c');assert.equal(m.contextLoading,true);assert.equal(m.canSendChat,false);
 await m.send();assert.equal(requests.length,0);assert.equal(m.drafts.ask,'inspect this file');
 read(pin());await tick();assert.equal(m.contextLoading,true);await m.send();assert.equal(requests.length,0);
 authorize([pin()]);assert.equal(await pending,true);assert.equal(m.contextLoading,false);assert.equal(m.canSendChat,true);
 await m.send();assert.equal(requests.length,1);assert.equal(requests[0].contexts[0].path,'main.c');
});
test('a pending attachment in another conversation does not block the new composer',async()=>{
 const m=model();m.drafts.ask='first';let finish;
 m.service.authorizeChatContexts=async()=>new Promise(resolve=>finish=resolve);
 const pending=m.addContextSnapshot(pin());assert.equal(m.contextLoading,true);await m.newConversation();
 assert.equal(m.contextLoading,false);assert.equal(m.canSendChat,true);finish([pin()]);assert.equal(await pending,false);assert.equal(m.pins.length,0);
});

function nativeComposerTransfer(m) {
 const URI=require('@theia/core/lib/common/uri').default;
 class Composer {closest(selector){return selector==='.nodu-ai-composer'?this:undefined;}}
 const composer=new Composer(),events=new Map(),clipboardEvents=new Set(),inserted=[];
 const document={activeElement:composer,addEventListener(){},removeEventListener(){},execCommand(action,_ui,text){if(action==='insertText'){inserted.push(text);m.drafts[m.mode]+=text;}return true;}};
 const window={addEventListener:(name,callback)=>events.set(name,callback),removeEventListener:name=>events.delete(name)};
 const clipboard={readText:async()=>'',onDidWriteText:callback=>{clipboardEvents.add(callback);return {dispose:()=>clipboardEvents.delete(callback)};}};
 const copied={text:undefined};
 const Transfer=source('browser/nodu-tutor-context-transfer.ts',{
  ...modelStubs,'@theia/core/lib/common/uri':{default:URI},'@theia/core/lib/browser':{},'@theia/core/lib/browser/clipboard-service':{},
  '@theia/editor/lib/browser/editor-manager':{},'@theia/monaco/lib/browser/monaco-editor':{MonacoEditor:{get:()=>undefined}},
  '@theia/navigator/lib/browser/navigator-file-clipboard':{},'./nodu-tutor-model':{NoduTutorModel}
 },{document,window,HTMLTextAreaElement:Composer}).NoduTutorContextTransfer;
 m.rootUri=new URI('file:///project');
 const transfer=Object.assign(new Transfer(),{tutor:m,clipboard,fileClipboard:{get:()=>copied.text},editors:{all:[]}});transfer.onStart();
 return {transfer,clipboard,copied,composer,document,inserted,blur:()=>events.get('blur')?.(),dispose:()=>transfer.onStop()};
}
test('native clipboard reading blocks immediate sends until ordinary pasted text reaches the same draft',async()=>{
 const m=model(),c=nativeComposerTransfer(m);m.drafts.ask='original ';let read;const requests=[];
 c.clipboard.readText=()=>new Promise(resolve=>read=resolve);m.service.chat=async request=>{requests.push(request);return {ok:true,answer:{text:'answer',annotations:[]}};};
 const pasting=c.transfer.pasteIntoComposer();assert.equal(m.contextLoading,true);assert.equal(m.canSendChat,false);
 await m.send();assert.equal(requests.length,0);assert.equal(m.drafts.ask,'original ');
 read('pasted text');await pasting;assert.equal(m.contextLoading,false);assert.equal(m.canSendChat,true);assert.equal(m.drafts.ask,'original pasted text');
 await m.send();assert.equal(requests.length,1);assert.equal(requests[0].prompt,'original pasted text');c.dispose();
});
test('native clipboard guard hands off to file reading and authorization without a sendable gap',async()=>{
 const m=model(),c=nativeComposerTransfer(m);m.drafts.ask='inspect pasted file';let readClipboard,readFile,authorize;const requests=[];
 c.copied.text='file:///project/main.c';c.clipboard.readText=()=>new Promise(resolve=>readClipboard=resolve);
 m.service.readChatContext=()=>new Promise(resolve=>readFile=resolve);m.service.authorizeChatContexts=()=>new Promise(resolve=>authorize=resolve);
 m.service.chat=async request=>{requests.push(request);return {ok:true,answer:{text:'answer',annotations:[]}};};
 const pasting=c.transfer.pasteIntoComposer();assert.equal(m.canSendChat,false);await m.send();assert.equal(requests.length,0);
 readClipboard(c.copied.text);await pasting;assert.equal(m.contextLoading,true);assert.equal(m.canSendChat,false);
 await m.send();assert.equal(requests.length,0);readFile(pin());await tick();assert.equal(m.contextLoading,true);
 await m.send();assert.equal(requests.length,0);assert.equal(m.drafts.ask,'inspect pasted file');authorize([pin()]);await tick();
 assert.equal(m.contextLoading,false);assert.equal(m.canSendChat,true);await m.send();
 assert.equal(requests.length,1);assert.equal(requests[0].contexts[0].path,'main.c');c.dispose();
});
test('clipboard rejection or focus loss releases the originating guard without altering its draft',async()=>{
 for(const outcome of ['error','focus','blur']){
  const m=model(),c=nativeComposerTransfer(m);m.drafts.ask='keep draft';let resolve,reject;
  c.clipboard.readText=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});
  const pasting=c.transfer.pasteIntoComposer();assert.equal(m.canSendChat,false);
  if(outcome==='error'){reject(Error('clipboard unavailable'));}else{if(outcome==='focus'){c.document.activeElement=undefined;}else{c.blur();}resolve('late text');}
  await pasting;assert.equal(m.contextLoading,false);assert.equal(m.canSendChat,true);assert.equal(m.drafts.ask,'keep draft');assert.deepEqual(c.inserted,[]);
  if(outcome==='error'){assert.equal(m.contextError,'clipboard unavailable');}else{assert.equal(m.contextError,undefined);}c.dispose();
 }
});
test('late clipboard completion releases only its old conversation while a new transfer stays pending',async()=>{
 const m=model(),c=nativeComposerTransfer(m);m.drafts.ask='old draft';let read;
 c.clipboard.readText=()=>new Promise(resolve=>read=resolve);const pasting=c.transfer.pasteIntoComposer();const oldId=m.activeConversationId;
 assert.equal(m.canSendChat,false);await m.newConversation();assert.notEqual(m.activeConversationId,oldId);assert.equal(m.canSendChat,true);assert.equal(m.contextLoading,false);
 m.drafts.ask='new draft';const finishNew=m.beginContextTransfer();assert.equal(m.canSendChat,false);
 read('old clipboard');await pasting;assert.equal(m.contextLoading,true);assert.equal(m.drafts.ask,'new draft');assert.deepEqual(c.inserted,[]);
 finishNew();assert.equal(m.contextLoading,false);assert.equal(m.canSendChat,true);assert.equal(m.pendingContexts.size,0);c.dispose();
});
test('context transfer releases are idempotent and retain other active operations',()=>{
 const m=model(),first=m.beginContextTransfer(),second=m.beginContextTransfer();
 assert.equal(m.contextLoading,true);assert.equal(m.canSendChat,false);first();first();
 assert.equal(m.contextLoading,true);assert.equal(m.canSendChat,false);second();second();
 assert.equal(m.contextLoading,false);assert.equal(m.canSendChat,true);assert.equal(m.pendingContexts.size,0);
});
