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
const pair=(text='question')=>{const user={id:crypto.randomUUID(),role:'user',text,status:'done'};return [user,{id:crypto.randomUUID(),role:'assistant',text:'answer',status:'done',replyTo:user.id,request:{prompt:text,mode:'ask',kind:'chat',goalRevision:0}}];};
function model(storage=new Storage()) {const m=new NoduTutorModel();m.layout={mode:'pro'};m.mode='ask';m.workspaceId='workspace-0001';m.connectionState='connected';m.conversationStore=new history.TutorConversationStore(storage);m.restoreConversations('project-inode-one');m.service={cancelChat:async()=>{},setPresentation:async()=>{},restoreChatHistory:async()=>{},clearChat:async()=>{},authorizeChatContexts:async(w,mode,pins)=>context.validateTutorContexts(pins,mode),chat:async()=>({ok:true,answer:{text:'reply',annotations:[]}})};return m;}
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
