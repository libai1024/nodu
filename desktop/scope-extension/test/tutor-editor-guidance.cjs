// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const helpers = { ...require('../lib/common/tutor/tutor-guidance'), ...require('../lib/common/tutor/tutor-context'), ...require('../lib/common/tutor/tutor-conversation') };
// Execute the production class methods with a deterministic editor, without a browser or model service.
function methods(file, className, names, dependencies = {}) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '../src/browser', file), 'utf8'), ts.ScriptTarget.Latest, true);
    const cls = source.statements.find(n => ts.isClassDeclaration(n) && n.name.text === className);
    const members = cls.members.filter(m => names.includes(m.name?.getText(source))).map(m => m.getText(source)).join('\n');
    const js = ts.transpile(`class Subject { ${members} }`, { target: ts.ScriptTarget.ES2022 });
    return new Function(...Object.keys(dependencies), js + '; return Subject;')(...Object.values(dependencies));
}
const Model = methods('nodu-tutor-model.ts', 'NoduTutorModel', ['updateBuffer', 'invalidate', 'notify', 'restoreGoalGuidance', 'autoCheckFragment'], helpers);
const Controller = methods('nodu-tutor-hints.ts', 'TutorEditorController', ['edit', 'render', 'enabled', 'enqueue', 'historyKey', 'saveHistory', 'restoreHistory', 'drain', 'clear', 'tutorChanged', 'updateContext'], {
    ...helpers, monaco: { Range: class { constructor(line, col, endLine, endCol) { Object.assign(this, {startLineNumber:line,startColumn:col,endLineNumber:endLine,endColumn:endCol}); } }, editor: { InjectedTextCursorStops: {None:0}, TrackedRangeStickiness: {NeverGrowsWhenTypingAtEdges:0} } }
});
test('an already restored editor publishes its buffer when workspace authorization arrives',()=>{
 const t=model();t.buffer=undefined;t.guidance=undefined;
 let authorized=false,active=true,restores=0,renders=0;
 const c=Object.assign(new Controller(),{tutor:t,active:()=>active,
  buffer:()=>authorized?{path:'main.c',text:'int main(void) {}',version:1,line:1}:undefined,
  historyKey:()=>t.buffer?.path,clear(){},restoreHistory(){this.taskHistoryKey=this.historyKey();restores++;},render(){renders++;},schedule(){}});
 t.changed.fire=()=>c.tutorChanged();
 c.tutorChanged();assert.equal(t.buffer,undefined);
 authorized=true;c.tutorChanged();assert.equal(t.buffer.text,'int main(void) {}');assert.equal(restores,1,'nested notification must not restore twice');
 active=false;t.buffer={path:'other.c',text:'other',version:1,line:1};c.tutorChanged();assert.equal(t.buffer.path,'other.c','inactive editor must not replace the active file');
 const previous=renders;c.disposed=true;c.tutorChanged();assert.equal(renders,previous);
});
function model(text = '', plan) {
    return Object.assign(new Model(), { buffer: {path:'main.c',text,version:1,line:1}, guidance: {source:{path:'main.c',text,version:1,line:1},anchorLine:1,lines:['int x = 1;', 'int y = 2;']}, changed:{fire(){}},invalidated:{fire(){}}, teaching:true,autoReview:true,configured:true,plan });
}
function editor(tutor, lines, cursorLine) {
    const state = { lines, version:1, decorations:[], nextId:0 };
    const textModel = { isDisposed:()=>false, getValue:()=>state.lines.join('\n'), getLinesContent:()=>state.lines, getLineContent:n=>state.lines[n-1], getVersionId:()=>state.version,
        getDecorationRange:id=>({startLineNumber:Number(id)}), getLineMaxColumn:n=>state.lines[n-1].length+1,getLineCount:()=>state.lines.length,
        deltaDecorations:()=>[String(++state.nextId)] };
    const c = Object.assign(new Controller(), { tutor, tasks:new Map(), changed:new Set(),before:[...lines],composing:false,
        control:{getModel:()=>textModel,getPosition:()=>({lineNumber:cursorLine,column:state.lines[cursorLine-1].length+1})},
        decorations:{set:d=>{state.decorations=d;},clear:()=>{}}, removeOverlay(){}, renderTask(){}, setTracing(value){state.tracing=value;},renderTrace(value){state.reference=value;}, schedule(){}, queueHistory(){}, active:()=>true,
        buffer:()=>({path:'main.c',text:state.lines.join('\n'),version:state.version,line:cursorLine}),updateContext(){tutor.updateBuffer(this.buffer());} });
    return {c,state};
}
test('dynamic exercise survives typing, advances to its second line, and rejects edits outside its region', () => {
    const t = model(); t.presentation = {answer:{guidance:t.guidance}};
    t.updateBuffer({path:'main.c',text:'i',version:2,line:1});
    assert.ok(t.guidance); assert.equal(t.presentation,undefined);
    t.hintsVisible=true; t.currentStep=()=>undefined;
    const {c,state}=editor(t,['int x = 1;','i'],2);
    t.updateBuffer(c.buffer()); c.render();
    assert.equal(c.enabled(),true);
    assert.equal(state.reference.candidate,'int y = 2;'); assert.equal(state.reference.line,2);
    t.updateBuffer({path:'other.c',text:'i',version:3,line:1}); assert.equal(t.guidance,undefined);
    assert.equal(helpers.guidanceEditMatches({path:'a',text:'head\n\ntail'},{path:'a',text:'changed\ni\ntail'},2,2),false);
});
test('reference stays below the input after a typo and backspace without modifying code or requesting a review', () => {
    const t=model();t.hintsVisible=true;t.currentStep=()=>undefined;
    let requests=0;t.send=()=>{requests++;};
    const {c,state}=editor(t,['inx'],1);c.render();
    assert.deepEqual(state.reference,{candidate:'int x = 1;',typed:'inx',line:1,block:{lines:['int x = 1;', 'int y = 2;'],current:0}});
    assert.equal(state.decorations.some(d=>d.options.after),false,'no inline virtual code');
    const parts=helpers.traceReference(state.reference.typed,state.reference.candidate);
    assert.deepEqual(parts.slice(0,3),[{text:'in',state:'matched'},{text:'t',state:'different'},{text:' ',state:'next'}]);
    state.lines[0]='in';c.render();
    assert.equal(helpers.traceReference('in',state.reference.candidate).some(p=>p.state==='different'),false);
    assert.equal(helpers.traceReference('in',state.reference.candidate).map(p=>p.text).join(''),'int x = 1;');
    state.lines[0]='int x = 1;';c.render();
    assert.equal(helpers.traceReference(state.lines[0],state.reference.candidate)[0].state,'matched');
    assert.equal(requests,0);assert.equal(state.lines[0],'int x = 1;');
});
test('reference tolerates indentation and Unicode, preserves the target and marks extra input separately', () => {
    assert.deepEqual(helpers.traceReference('    inx','int'),[{text:'    ',state:'indent'},{text:'in',state:'matched'},{text:'t',state:'different'}]);
    assert.deepEqual(helpers.traceReference('😀x','😀y;'),[{text:'😀',state:'matched'},{text:'y',state:'different'},{text:';',state:'next'}]);
    assert.deepEqual(helpers.traceReference('int EXTRA','int'),[{text:'int',state:'matched'},{text:' EXTRA',state:'extra'}]);
    const t=model();t.hintsVisible=true;t.currentStep=()=>undefined;
    const {c,state}=editor(t,['int'],1);c.control.getPosition=()=>({lineNumber:1,column:2});c.render();
    assert.equal(state.reference.candidate,'int x = 1;');
    c.composing=true;c.render();assert.ok(state.reference);assert.equal(state.tracing,false);
    c.composing=false;t.hintsVisible=false;c.render();assert.equal(state.reference,undefined);assert.equal(state.tracing,false);
});
test('editing the next exercise line invalidates evidence but preserves unchanged-line guidance progress', () => {
    const t = model('// STEP\nint x = 1;\n', {}); t.guidance=undefined; t.hintsVisible=true;
    t.currentStep=()=>({anchors:[{id:'s',path:'main.c',marker:'// STEP'}],guidance:[{anchorId:'s',requiredSymbols:[],lines:['int x = 1;','int y = 2;']}]});
    const {c,state}=editor(t,['// STEP','int x = 1;',''],3);
    c.tasks.set('2',{decoration:'2',text:'int x = 1;',status:'ok',guided:true,note:''});
    state.lines[2]='i'; state.version++;
    c.edit({changes:[{range:{startLineNumber:3,endLineNumber:3},text:'i'}]});
    assert.equal(c.tasks.get('2').status,'stale'); assert.equal(c.tasks.get('2').guided,true);
    assert.equal(state.reference.candidate,'int y = 2;'); assert.equal(state.reference.line,3);
    state.lines[1]='int x = 9;'; c.edit({changes:[]});
    assert.equal(c.tasks.get('2').guided,false);
    assert.equal(state.reference.candidate,'int x = 1;');assert.equal(state.reference.line,2);
});
test('completed history does not consume the pending queue budget', () => {
    const t=model('',{}); const {c,state}=editor(t,Array.from({length:22},(_,i)=>`int x${i};`),22);
    for(let i=1;i<=20;i++) c.tasks.set(String(i),{decoration:String(i),text:state.lines[i-1],status:'ok',guided:true});
    state.nextId=20; c.enqueue(21);
    assert.equal(helpers.pendingReviewCount(c.tasks.values()),1);
    assert.equal(c.tasks.size,21);
    for(const task of c.tasks.values()) task.status='pending';
    t.notify=()=>{}; c.enqueue(22); assert.equal(c.tasks.size,21);
});


test('accepted goal restores its fragment after editor reopen without trusting old annotation evidence', () => {
    const t=model();t.guidance=undefined;t.paused=false;
    t.goalState={status:'active',revision:4,fragment:{source:{path:'main.c',text:'',line:1,version:1},answer:{text:'write',annotations:[],guidance:{anchorLine:1,lines:['int x = 1;']}}}};
    t.updateBuffer({path:'main.c',text:'int',line:1,version:20});
    assert.deepEqual(t.guidance.lines,['int x = 1;']);assert.equal(t.presentation,undefined);
    t.goalState.status='paused';t.guidance=undefined;t.updateBuffer({path:'main.c',text:'int x',line:1,version:21});assert.equal(t.guidance,undefined);
});
test('completed fragment schedules one semantic check and partial typing schedules none', () => {
    const t=model();t.goalState={status:'active',revision:4,fragment:{source:{path:'main.c',text:'',line:1,version:1},answer:{guidance:{anchorLine:1,lines:['int x = 1;']}}}};
    const calls=[];t.goalAction=action=>calls.push(action);
    t.buffer={path:'main.c',text:'int',line:1,version:2};t.autoCheckFragment();assert.equal(calls.length,0);
    t.buffer={path:'main.c',text:'int x = 1;\n',line:2,version:3};t.autoCheckFragment();t.autoCheckFragment();assert.deepEqual(calls,['check']);
});
test('editing while a fragment is being checked cancels the stale request', () => {
    const t=model();t.busy={goal:'check'};let cancelled=false;t.cancel=()=>{cancelled=true;t.busy=undefined;};
    t.updateBuffer({path:'main.c',text:'changed',version:2,line:1});assert.equal(cancelled,true);
});

test('line history reopens exact content, preserves guidance and never replays pending model calls', () => {
    const { TutorLineHistoryCache } = require('../lib/common/tutor/tutor-line-history');
    const cache = new TutorLineHistoryCache();
    cache.save('project/a.c', 'int a;\nint b;', [
        {line:1,text:'int a;',status:'stale',guided:true,note:'上下文已修改'},
        {line:2,text:'int b;',status:'pending',note:'检查中'},
    ]);
    const restored=cache.restore('project/a.c','int a;\nint b;');
    assert.equal(restored[0].guided,true);assert.equal(restored[0].status,'stale');
    assert.equal(restored[1].status,'stale');assert.equal(restored[1].guided,false);
    restored[0].guided=false;
    assert.equal(cache.restore('project/a.c','int a;\nint b;')[0].guided,true);
    assert.deepEqual(cache.restore('other/a.c','int a;\nint b;'),[]);
    assert.deepEqual(cache.restore('project/a.c','int a;\nint c;'),[]);
    assert.deepEqual(cache.restore('project/a.c','int a;\nint b;'),[]);
});


test('production editor saves line decorations and rebinds them to the reopened document version', () => {
    const { TutorLineHistoryCache } = require('../lib/common/tutor/tutor-line-history');
    const t=model('int a;');t.rootUri={toString:()=> 'file:///project'};t.goalState={goal:'serial'};t.lineHistory=new TutorLineHistoryCache();
    const first=editor(t,['int a;'],1);
    first.c.restoreHistory();
    first.c.tasks.set('1',{decoration:'1',text:'int a;',status:'ok',guided:true,note:'AI 已检查',version:1});
    first.c.saveHistory();
    const second=editor(t,['int a;'],1);second.state.version=80;second.c.restoreHistory();
    assert.equal(second.c.tasks.size,1);assert.equal(second.c.tasks.get('1').guided,true);assert.equal(second.c.tasks.get('1').version,80);
    t.goalState.goal='another exercise';const other=editor(t,['int a;'],1);other.c.restoreHistory();assert.equal(other.c.tasks.size,0);
});

test('manual fragment checks use local evidence offline and ignore results after editing', async () => {
    const Sender = methods('nodu-tutor-model.ts', 'NoduTutorModel', ['send','settle','updateBuffer','invalidate','notify'], helpers);
    const make = () => Object.assign(new Sender(), {
        enabled:true, mode:'teach', workspaceId:'workspace', epoch:1, configured:false,
        goalState:{status:'active'}, buffer:{path:'main.c',text:'int main(void){return 0;}',version:1,line:1},
        messages:{teach:[],ask:[]}, drafts:{teach:'',ask:''}, sync:Promise.resolve(),
        currentStep:()=>undefined, changed:{fire(){}}, invalidated:{fire(){}}, restoreGoalGuidance(){}, autoCheckFragment(){},
        service:{chat:()=>{throw Error('Offline check must not call model');}, inspectBuffer:async()=>({syntax:'valid',findings:[],errorLines:[]})}
    });
    const t=make();await t.send('step');
    assert.match(t.messages.teach.at(-1).text,/尚未验证编译和运行/);
    assert.equal(t.presentation.answer.review.verdict,'context');assert.equal(t.goalState.status,'active');
    const edited=make();let resolve;edited.service.inspectBuffer=()=>new Promise(r=>resolve=r);
    edited.cancel=()=>{edited.busy=undefined;};const p=edited.send('step');await Promise.resolve();await Promise.resolve();
    edited.updateBuffer({path:'main.c',text:'int main(void){',version:2,line:1});
    resolve({syntax:'valid',findings:[],errorLines:[]});await p;assert.equal(edited.presentation,undefined);
});

function historyStorage() {
    const map = new Map();
    return { get length(){return map.size;}, key:i=>[...map.keys()][i] ?? null,
        getItem:k=>map.get(k) ?? null, setItem:(k,v)=>map.set(k,v), removeItem:k=>map.delete(k), map };
}
test('history survives application restart as stale evidence without losing typed guidance progress', () => {
    const {TutorLineHistoryCache}=require('../lib/common/tutor/tutor-line-history');const disk=historyStorage();
    new TutorLineHistoryCache(disk).save('project/course/main.c','int a;',[{line:1,text:'int a;',status:'ok',guided:true,note:'AI已检查'}]);
    const restored=new TutorLineHistoryCache(disk).restore('project/course/main.c','int a;');
    assert.equal(restored[0].status,'stale');assert.equal(restored[0].guided,true);assert.match(restored[0].note,/历史/);
    assert.deepEqual(new TutorLineHistoryCache(disk).restore('project/other-course/main.c','int a;'),[]);
    assert.deepEqual(new TutorLineHistoryCache(disk).restore('project/course/main.c','int b;'),[]);
});
test('persistent history validates corruption, never replays pending calls, and bounds stored files', () => {
    const {TutorLineHistoryCache}=require('../lib/common/tutor/tutor-line-history');const disk=historyStorage();
    const first=new TutorLineHistoryCache(disk),other=new TutorLineHistoryCache(disk);
    for(let i=0;i<20;i++)(i%2 ? first:other).save(`file-${i}`,'int a;',[{line:1,text:'int a;',status:'pending',guided:true,note:'working'}]);
    assert.equal(disk.length,16);
    const key=disk.key(0), raw=JSON.parse(disk.getItem(key));
    const restored=new TutorLineHistoryCache(disk).restore(raw.key,'int a;');assert.equal(restored[0].guided,false);assert.equal(restored[0].status,'stale');
    raw.lines[0].line=999;disk.setItem(key,JSON.stringify(raw));assert.deepEqual(new TutorLineHistoryCache(disk).restore(raw.key,'int a;'),[]);
    disk.setItem('unrelated','keep');first.clear();assert.equal(disk.getItem('unrelated'),'keep');assert.equal(disk.length,1);
    const unavailable=new TutorLineHistoryCache({setItem(){throw Error('quota');},getItem(){throw Error('unavailable');},removeItem(){}});
    unavailable.save('x','int a;',[{line:1,text:'int a;',status:'ok',note:'ok'}]);assert.equal(unavailable.restore('x','int a;').length,1);
});

test('static course ghost continues through incomplete constructs and comments without waiting on model review', () => {
    const t=model('',{});t.guidance=undefined;t.hintsVisible=true;
    t.currentStep=()=>({anchors:[{id:'s',path:'main.c',marker:'// STEP'}],guidance:[{anchorId:'s',requiredSymbols:[],lines:['void sample(void)','{','// setup','int x = 1;','}']}]});
    const {c,state}=editor(t,['// STEP','void sample(void)','{','// setup','i'],5);
    c.render();assert.equal(state.reference.candidate,'int x = 1;');assert.equal(state.reference.line,5);
    state.lines[1]='void different(void)';c.render();assert.equal(state.reference.candidate,'void sample(void)');assert.equal(state.reference.line,2);
});

test('course navigation authorizes files and abandons a location after switching projects', async () => {
    const commands={openReference:'ref',toggleHints:'h',highlight:'hi',annotations:'a',float:'f',guidance:'g',check:'c',revealStep:'reveal'};
    const Subject=methods('nodu-tutor-hints.ts','NoduTutorHintsContribution',['registerCommands','openTeachingFile'],{TUTOR_COMMANDS:commands,MonacoEditor:{get:w=>w},...helpers});
    const handlers=new Map(),step={anchors:[{path:'drivers/sensor.c',marker:'// STEP'}]},root={resolve:p=>p};
    let opens=0,position;const control={getModel:()=>({getLinesContent:()=>['// STEP',''],getLineCount:()=>2}),setPosition:p=>position=p,revealLineInCenterIfOutsideViewport(){},focus(){}};
    const tutor={enabled:true,rootUri:root,currentStep:()=>step,notify(){},resolveReference:async()=>{throw Error('outside project');}};
    const editors={open:async()=>{opens++;const widget={getControl:()=>control};editors.currentEditor=widget;return widget;}};
    const subject=Object.assign(new Subject(),{tutor,editors,shell:{activateWidget:async()=>{}}});
    subject.registerCommands({registerCommand:(c,h)=>handlers.set(c.id,h)});
    await handlers.get('reveal').execute();assert.equal(opens,0);assert.match(tutor.error,/outside/);
    tutor.resolveReference=async()=>({path:'drivers/sensor.c',line:1});await handlers.get('reveal').execute();assert.equal(opens,1);assert.equal(position.lineNumber,2);
    tutor.resolveReference=async()=>{tutor.rootUri={resolve:p=>p};return {path:'drivers/sensor.c',line:1};};
    await handlers.get('reveal').execute();assert.equal(opens,1);
});

test('dynamic lesson opens the next file and focuses validated guidance without editing source', async () => {
    const Subject=methods('nodu-tutor-hints.ts','NoduTutorHintsContribution',['prepareGoal','openTeachingFile'],{MonacoEditor:{get:w=>w}});
    const text='int main(){\n\n}',state={revision:2,status:'active',steps:[{path:'next.c'}],current:0};let position,opened;
    const model={getValueLength:()=>text.length,getValue:()=>text,getVersionId:()=>7,isDisposed:()=>false,getLineMaxColumn:()=>1};
    const control={getModel:()=>model,getPosition:()=>({lineNumber:1}),setPosition:p=>position=p,revealLineInCenterIfOutsideViewport(){},focus(){}};
    const widget={getControl:()=>control},editors={currentEditor:undefined,open:async p=>{opened=p;editors.currentEditor=widget;return widget;}};
    const tutor={rootUri:{resolve:p=>p},workspaceId:'w',teaching:true,goalState:state,notify(){},resolveReference:async p=>({path:p,line:1}),updateBuffer:b=>tutor.buffer=b,
        goalAction:async(a,p,placement)=>{assert.equal(placement,'suggest');tutor.goalState={...state,revision:3,fragment:{source:{path:'next.c',text},answer:{guidance:{anchorLine:2}}}};}};
    await Object.assign(new Subject(),{tutor,editors,shell:{activateWidget:async()=>{}}}).prepareGoal();assert.equal(opened,'next.c');assert.equal(position.lineNumber,2);assert.equal(tutor.buffer.text,text);
    // A user switching editors during the request must retain their focus.
    position=undefined;tutor.goalState=state;tutor.goalAction=async()=>{editors.currentEditor={};tutor.goalState={...state,fragment:{source:{path:'next.c',text},answer:{guidance:{anchorLine:2}}}};};
    await Object.assign(new Subject(),{tutor,editors,shell:{activateWidget:async()=>{}}}).prepareGoal();assert.equal(position,undefined);
});
test('reviewed equivalent lines trigger a fresh fragment review without being marked complete locally',()=>{
 const t=model();t.goalState={status:'active',revision:4,fragment:{source:{path:'main.c',text:'\n\n',line:1,version:1},answer:{guidance:{anchorLine:1,lines:['int x = 1;','x += 1;']}}}};
 const calls=[];t.goalAction=a=>calls.push(a);t.buffer={path:'main.c',text:'int x=1;\nx=x+1;',version:3,line:2};
 t.autoCheckFragment();assert.equal(calls.length,0);t.autoCheckFragment([1]);assert.equal(calls.length,0);
 t.autoCheckFragment([1,2]);t.autoCheckFragment([1,2]);assert.deepEqual(calls,['check']);assert.equal(t.goalState.status,'active');
 t.goalState.status='paused';t.lastAutoFragment=undefined;t.autoCheckFragment([1,2]);assert.equal(calls.length,1);
});


test('same-revision fragment removal and failed reads clear a restored ghost',async()=>{
 const Refresh=methods('nodu-tutor-model.ts','NoduTutorModel',['refreshGoal','invalidate','restoreGoalGuidance','notify'],helpers);
 const m=Object.assign(new Refresh(),{workspaceId:'workspace-1',goalState:{revision:4,status:'active',fragment:{old:true}},guidance:{old:true},invalidated:{fire(){}},changed:{fire(){}}});
 m.service={goalSnapshot:async()=>({revision:4,status:'active',steps:[],current:0})};await m.refreshGoal();assert.equal(m.guidance,undefined);assert.equal(m.goalState.fragment,undefined);
 m.guidance={old:true};m.goalState.fragment={old:true};m.service={goalSnapshot:async()=>{throw Error('revoked');}};await m.refreshGoal();assert.equal(m.guidance,undefined);assert.equal(m.goalState.fragment,undefined);
 const before=m.goalState;m.service={goalSnapshot:async()=>{m.workspaceId='workspace-2';throw Error('late');}};await m.refreshGoal();assert.equal(m.goalState,before);assert.equal(m.error,'revoked');
});

// Delayed RPCs exercise the production lifecycle across real request boundaries.
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const Lifecycle = methods('nodu-tutor-model.ts','NoduTutorModel',[
    'load','sessionOperation','unwrap','importLegacy','refresh','action','previewMigration','acceptMigration',
    'clearChat','goalAction','goalRequestContexts','send','settle','syncPresentation'
], { ...helpers, emptyGoal:()=>({revision:0,status:'none',steps:[],current:0}), sameUri:(a,b)=>a===b?.toString(), localStorage:{getItem:()=>null} });
function lifecycle(overrides={}) {
    return Object.assign(new Lifecycle(),{loading:0,refreshing:0,epoch:0,sessionQueue:Promise.resolve(),sync:Promise.resolve(),
        workspaceId:'a',rootUri:{toString:()=>'/a'},workspace:{roots:Promise.resolve([{resource:{toString:()=>'/a'}}])},
        session:{sessionId:'old',plan:{kind:'none'}},goalState:{revision:0,status:'none',steps:[],current:0},
        mode:'teach',enabled:true,includeCode:true,currentContextIncluded:true,pins:[],messages:{teach:[],ask:[]},drafts:{teach:'goal',ask:'question'},
        cancelAll(){this.busy=undefined;},cancel(){this.busy=undefined;},invalidate(){this.guidance=undefined;},notify(){},
        refreshGoal:async()=>{},restoreGoalGuidance(){},fragmentRequested:{fire(){}},
        service:{closeSession:async()=>({ok:true}),workspaces:async()=>[{id:'a',uri:'/a'}],aiSettings:async()=>({providers:[]}),
            openSession:async()=>({ok:true,value:{sessionId:'new',plan:{kind:'none'}}}),setPresentation:async()=>{}},...overrides});
}
test('reconnect preserves same-project conversation and buffer, tolerates expired handle, clears on project switch',async()=>{
    const m=lifecycle();m.messages.teach.push({text:'previous feedback'});m.buffer={path:'main.c',text:'int a;'};
    m.service.closeSession=async()=>{throw Error('disconnected');};await m.load();
    assert.equal(m.session.sessionId,'new');assert.equal(m.messages.teach.length,1);assert.equal(m.buffer.text,'int a;');assert.equal(m.error,undefined);
    m.workspace.roots=Promise.resolve([{resource:{toString:()=>'/b'}}]);m.service.workspaces=async()=>[{id:'b',uri:'/b'}];
    await m.load();assert.equal(m.workspaceId,'b');assert.equal(m.messages.teach.length,0);assert.equal(m.buffer,undefined);assert.equal(m.drafts.teach,'');
});
test('superseded session open is closed before a deduplicated reconnect adopts its own handle',async()=>{
    const m=lifecycle(), gate=deferred(), entered=deferred(),closed=[];let opens=0,live;
    m.service.closeSession=async id=>{closed.push(id);if(live===id) live=undefined;return {ok:true};};
    m.service.openSession=async()=>{opens++;live??=`session-${opens}`;const id=live;if(opens===1){entered.resolve();await gate.promise;}return {ok:true,value:{sessionId:id,plan:{kind:'none'}}};};
    const first=m.load();await entered.promise;const second=m.load();gate.resolve();await Promise.all([first,second]);
    assert.equal(m.session.sessionId,'session-2');assert.equal(live,'session-2');assert.deepEqual(closed,['old','session-1']);
});
test('settings completion from an obsolete load cannot open or overwrite the new workspace',async()=>{
    const m=lifecycle(),gate=deferred(),entered=deferred();let calls=0,opens=[];
    m.service.aiSettings=async()=>{if(++calls===1){entered.resolve();return gate.promise;}return {providers:[],label:'new'};};
    m.service.openSession=async id=>{opens.push(id);return {ok:true,value:{sessionId:id,plan:{kind:'none'}}};};
    const first=m.load();await entered.promise;m.workspace.roots=Promise.resolve([{resource:{toString:()=>'/b'}}]);m.service.workspaces=async()=>[{id:'b',uri:'/b'}];
    await m.load();gate.resolve({providers:[],label:'old'});await first;
    assert.deepEqual(opens,['b']);assert.equal(m.settings.label,'new');assert.equal(m.session.sessionId,'b');
});
test('course snapshots never regress and stale workspace failures do not surface',async()=>{
    const m=lifecycle();m.session.learning={snapshot:{sequence:4,planHash:'new'}};
    m.service.getSnapshot=async()=>({ok:true,value:{sessionId:'old',plan:{kind:'none'},learning:{snapshot:{sequence:3,planHash:'old'}}}});
    await m.refresh();assert.equal(m.session.learning.snapshot.sequence,4);
    m.service.getSnapshot=async()=>{m.session={sessionId:'other'};throw Error('old failure');};await m.refresh();assert.equal(m.error,undefined);
    m.session.learning={snapshot:{sequence:1,planHash:'b'}};
    m.service.recordAction=async()=>{m.session={sessionId:'third'};throw Error('old write failure');};await m.action({type:'reset'});assert.equal(m.error,undefined);
});
test('migration preview and accepted migration cannot overwrite a newly selected project',async()=>{
    const m=lifecycle();m.service.previewMigration=async()=>{m.session={sessionId:'other'};return {ok:true,value:{id:'preview'}};};await m.previewMigration({});assert.equal(m.migration,undefined);
    m.migration={id:'preview',sourceDigest:'x'};m.service.acceptMigration=async()=>{m.session={sessionId:'third'};return {ok:true,value:{sessionId:'other'}};};
    await m.acceptMigration();assert.equal(m.session.sessionId,'third');
});
test('clearing a conversation is mode-scoped and does not erase messages entered during delayed completion',async()=>{
    const m=lifecycle(),gate=deferred();m.messages.teach.push({text:'old'});m.messages.ask.push({text:'keep'});
    m.service.clearChat=async(w,mode)=>{assert.equal(w,'a');assert.equal(mode,'teach');await gate.promise;};
    const pending=m.clearChat();assert.equal(m.messages.teach.length,0);m.messages.teach.push({text:'new'});m.mode='ask';
    gate.resolve();await pending;assert.equal(m.messages.ask[0].text,'keep');assert.equal(m.messages.teach[0].text,'new');
    m.service.clearChat=async()=>{m.workspaceId='b';throw Error('old clear');};await m.clearChat();assert.equal(m.error,undefined);
});
test('delayed goal failure after cancellation cannot replace current error or new request',async()=>{
    const m=lifecycle(),gate=deferred(),entered=deferred();m.service.goal=async()=>{entered.resolve();return gate.promise;};
    const pending=m.goalAction('propose','hello');await entered.promise;m.busy={id:'new'};m.epoch++;m.error='new state';
    gate.reject(Error('old failure'));await pending;assert.equal(m.error,'new state');assert.equal(m.busy.id,'new');
});
test('queued sends cannot carry an old-project prompt or buffer into a newly selected project',async()=>{
    for(const kind of ['goal','chat']){
        const m=lifecycle(),gate=deferred();m.sync=gate.promise;m.buffer={path:'main.c',text:'old private code'};m.mode=kind==='goal'?'teach':'ask';
        let calls=0;m.service.goal=m.service.chat=async()=>{calls++;throw Error('must not send');};
        const pending=kind==='goal'?m.goalAction('propose','old goal'):m.send();m.workspaceId='b';m.epoch++;gate.resolve();await pending;assert.equal(calls,0);
    }
});
test('failed presentation synchronization prevents queued model requests without an unhandled rejection',async()=>{
    const m=lifecycle();m.sync=Promise.reject(Error('offline'));let calls=0;m.service.goal=async()=>{calls++;};
    await m.goalAction('propose','goal');assert.equal(calls,0);
    m.mode='ask';m.sync=Promise.reject(Error('offline'));await m.send();assert.equal(calls,0);
});
test('late file navigation neither steals focus nor reports errors in another project',async()=>{
    const Subject=methods('nodu-tutor-hints.ts','NoduTutorHintsContribution',['registerCommands','openTeachingFile'],{TUTOR_COMMANDS:{openReference:'ref',revealStep:'step'},MonacoEditor:{get:w=>w},...helpers});
    const handlers=new Map(),root={resolve:p=>p},step={anchors:[{path:'main.c',marker:'// STEP'}]};let focused=0;
    const control={getModel:()=>({getLinesContent:()=>['// STEP',''],getLineCount:()=>2}),setPosition(){},revealLineInCenterIfOutsideViewport(){},focus(){focused++;}},widget={getControl:()=>control};
    const tutor={rootUri:root,epoch:1,enabled:true,currentStep:()=>step,notify(){},resolveReference:async()=>({path:'main.c',line:1})};
    const editors={currentEditor:widget,open:async(p,options)=>{assert.equal(options.mode,'open');return widget;}};Object.assign(new Subject(),{tutor,editors,shell:{activateWidget:async()=>{}}}).registerCommands({registerCommand:(c,h)=>handlers.set(c.id,h)});
    await handlers.get('ref').execute('main.c');assert.equal(focused,1);
    editors.open=async()=>{tutor.epoch++;return widget;};await handlers.get('ref').execute('main.c');await handlers.get('step').execute();assert.equal(focused,1);
    editors.open=async()=>{editors.currentEditor={};return widget;};await handlers.get('ref').execute('main.c');assert.equal(focused,1);
    tutor.resolveReference=async()=>{tutor.rootUri={resolve:p=>p};throw Error('old path failed');};await handlers.get('ref').execute('main.c');assert.equal(tutor.error,undefined);
});
test('goal snapshot from a previous connection cannot restore ghosts in the same reopened workspace',async()=>{
    const Subject=methods('nodu-tutor-model.ts','NoduTutorModel',['refreshGoal'],{}),gate=deferred();
    const state={revision:1,status:'paused'};const m=Object.assign(new Subject(),{workspaceId:'a',loading:1,goalState:state,service:{goalSnapshot:()=>gate.promise},invalidate(){throw Error('must not apply');}});
    const pending=m.refreshGoal();m.loading++;gate.resolve({revision:10,status:'active',fragment:{old:true}});await pending;assert.equal(m.goalState,state);
});
test('legacy progress import cannot write its result into a different live session',async()=>{
    const Subject=methods('nodu-tutor-model.ts','NoduTutorModel',['importLegacy','unwrap'],{localStorage:{getItem:()=>'{"done":true}'}}),gate=deferred(),entered=deferred();
    const m=Object.assign(new Subject(),{rootUri:{toString:()=>'/a'},plan:{id:'course'},session:{sessionId:'a',learning:{snapshot:{sequence:0,planHash:'hash',progress:{log:[]}}}},
        service:{importLegacyProgress:async()=>{entered.resolve();return gate.promise;}}});
    const pending=m.importLegacy();await entered.promise;const fresh={sessionId:'b',learning:{snapshot:{sequence:4}}};m.session=fresh;
    gate.resolve({ok:true,value:{sequence:1}});await pending;assert.equal(m.session,fresh);assert.equal(m.session.learning.snapshot.sequence,4);
});
test('a new message waits for server conversation clearing before starting its model request',async()=>{
    const m=lifecycle({mode:'ask'}),gate=deferred(),entered=deferred(),events=[];
    m.service.clearChat=async()=>{entered.resolve();await gate.promise;events.push('clear');};
    m.service.chat=async()=>{events.push('send');return {ok:true,answer:{text:'answer',annotations:[]}};};
    const clear=m.clearChat();await entered.promise;const send=m.send();assert.deepEqual(events,[]);gate.resolve();await Promise.all([clear,send]);
    assert.deepEqual(events,['clear','send']);assert.equal(m.messages.ask.at(-1).status,'done');
});
test('removing a course clears it and a late snapshot cannot restore the deleted plan',async()=>{
    const m=lifecycle(),gate=deferred();m.session.learning={snapshot:{sequence:4,planHash:'old'}};let calls=0;
    m.service.getSnapshot=async()=>++calls===1?gate.promise:{ok:true,value:{sessionId:'old',plan:{kind:'none'}}};
    const old=m.refresh();await m.refresh();assert.equal(m.session.learning,undefined);
    gate.resolve({ok:true,value:{sessionId:'old',plan:{kind:'course'},learning:{snapshot:{sequence:5,planHash:'old'}}}});await old;
    assert.equal(m.session.plan.kind,'none');assert.equal(m.session.learning,undefined);
});


test('pending line review cannot affect a replaced or disposed editor document', async () => {
 for (const action of ['switch','dispose']) {
  const t=model('',{});t.epoch=1;let finish,checks=0;t.autoCheckFragment=()=>checks++;
  t.send=()=>new Promise(resolve=>finish=resolve);
  const {c}=editor(t,['int x;'],1);const old=c.control.getModel();
  const task={decoration:'1',text:'int x;',status:'pending',note:''};c.tasks.set('1',task);
  let renders=0,saves=0;c.render=()=>renders++;c.queueHistory=()=>saves++;
  const pending=c.drain();assert.equal(task.note,'检查中');
  if(action==='switch') {c.control.getModel=()=>({...old});c.tasks=new Map();}
  else {c.disposed=true;old.isDisposed=()=>true;old.getVersionId=()=>{throw Error('disposed model accessed');};}
  finish({ok:true,answer:{review:{verdict:'ok',note:'valid'}}});await pending;
  assert.notEqual(task.status,'ok');assert.equal(checks,0);assert.equal(c.processing,false);
  if(action==='dispose'){assert.equal(renders,1);assert.equal(saves,0);}
 }
});

test('unexpected line-check failure clears processing and allows following work without an unhandled rejection', async () => {
 const t=model('',{});t.epoch=1;t.send=async()=>{throw Error('transport closed');};t.autoCheckFragment=()=>{};
 const {c}=editor(t,['int x;'],1);c.render=()=>{};
 const task={decoration:'1',text:'int x;',status:'pending',note:''};c.tasks.set('1',task);
 await c.drain();assert.equal(c.processing,false);assert.equal(task.status,'unavailable');assert.equal(task.note,'AI 检查未完成');
});


test('render and disposal cleanup tolerate Monaco destroying the document before its widget', () => {
 const t=model('',{});const {c}=editor(t,['int x;'],1);const document=c.control.getModel();
 document.isDisposed=()=>true;document.deltaDecorations=()=>{throw Error('disposed document accessed');};
 c.buffer=()=>{throw Error('disposed buffer accessed');};c.tasks.set('1',{});c.changed.add(1);
 c.render();c.clear();assert.equal(c.tasks.size,0);assert.equal(c.changed.size,0);
});

test('reference view zone stays below the input, reflows on narrow layout, and cleans up without editing the document',()=>{
 const nodes=[];
 const document={createElement:()=>{const node={style:{},children:[],setAttribute(){},append(child){this.children.push(child);},replaceChildren(){this.children=[];},get scrollHeight(){return this.style.width==='100px'?64:32;}};nodes.push(node);return node;}};
 const Subject=methods('nodu-tutor-hints.ts','TutorEditorController',['renderTrace'],{document,traceReference:helpers.traceReference,monaco:{editor:{EditorOption:{fontInfo:'fontInfo',lineHeight:'lineHeight'}}}});
 const zones=new Map();let width=700,adds=0,layouts=0,removes=0;
 const c=Object.assign(new Subject(),{control:{getLayoutInfo:()=>({contentWidth:width,lineNumbersLeft:20,lineNumbersWidth:36}),getOption:key=>key==='lineHeight'?24:{fontFamily:'mono',fontSize:14},getModel:()=>({getOptions:()=>({tabSize:4})}),applyFontInfo(){},changeViewZones:fn=>fn({addZone(zone){const id=String(++adds);zones.set(id,zone);return id;},layoutZone(){layouts++;},removeZone(id){zones.delete(id);removes++;}})}});
 c.renderTrace({typed:'in',candidate:'int x = 1;',line:4});
 assert.equal(zones.get('1').afterLineNumber,4);assert.equal(zones.get('1').heightInPx,38);
 assert.equal(c.traceZone.content.children.map(s=>s.textContent).join(''),'int x = 1;');
 c.renderTrace({typed:'inx',candidate:'int x = 1;',line:4});assert.equal(adds,1);assert.ok(c.traceZone.content.children.some(s=>s.className.endsWith('different')));
 width=120;c.renderTrace({typed:'inx',candidate:'int x = 1;',line:4});assert.equal(zones.get('1').heightInPx,66);
 width=700;c.renderTrace({typed:'re',candidate:'    return 0;',line:5,block:{lines:['if (ready) {','    return 0;','}'],current:1}});
 assert.equal(adds,1,'a whole block shares one bounded reference region');
 assert.equal(zones.get('1').afterLineNumber,5);assert.equal(zones.get('1').heightInPx,86);
 assert.equal(c.traceZone.content.children.map(s=>s.textContent).join(''),'if (ready) {\n    return 0;\n}');
 assert.equal(c.traceZone.content.children.filter(s=>s.className?.endsWith('next')).length,1,'only the active reference row has a next-character cue');
 assert.equal(zones.get('1').marginDomNode.children.length,1,'the whole block has one AI icon, not one per line');
 assert.equal(c.traceZone.icon.className,'codicon codicon-sparkle');
 assert.deepEqual(c.traceZone.icon.style,{left:'20px',width:'36px',height:'24px',fontSize:'14px'});
 c.renderTrace();assert.equal(zones.size,0);assert.equal(removes,1);assert.equal(c.traceZone,undefined);
 c.renderTrace({typed:'',candidate:'return 0;',line:8});assert.equal(zones.get('2').afterLineNumber,8);assert.ok(layouts>=4);
});
test('typing practice temporarily suppresses completion and paired insertion then restores editor settings',()=>{
 const keys=['quickSuggestions','suggestOnTriggerCharacters','inlineSuggest','autoClosingBrackets','autoClosingQuotes','autoSurround'];
 const original={quickSuggestions:{other:'on',comments:'off',strings:'off'},suggestOnTriggerCharacters:true,inlineSuggest:{enabled:true},autoClosingBrackets:'languageDefined',autoClosingQuotes:'languageDefined',autoSurround:'languageDefined'};
 const Subject=methods('nodu-tutor-hints.ts','TutorEditorController',['setTracing'],{monaco:{editor:{EditorOption:Object.fromEntries(keys.map(k=>[k,k]))}}});
 const updates=[];const c=Object.assign(new Subject(),{control:{getOption:k=>original[k],updateOptions:options=>updates.push(options)}});
 c.setTracing(true);c.setTracing(true);assert.equal(updates.length,1);assert.equal(updates[0].quickSuggestions,false);assert.equal(updates[0].autoClosingQuotes,'never');
 c.setTracing(false);assert.deepEqual(updates[1],original);assert.equal(c.tracingOptions,undefined);
 c.setTracing(false);assert.equal(updates.length,2);
});

test('AI reference is anchored to its insertion region across cursor moves and focus loss',()=>{
 const t=model('head\n\ntail');t.hintsVisible=true;t.currentStep=()=>undefined;
 t.guidance={source:{path:'main.c',text:'head\n\ntail'},anchorLine:2,lines:['int x = 1;','int y = 2;']};
 const {c,state}=editor(t,['head','int','tail'],2);c.render();const original=structuredClone(state.reference);
 c.control.getPosition=()=>({lineNumber:1,column:1});c.render();assert.deepEqual(state.reference,original);assert.equal(state.tracing,false);
 c.active=()=>false;c.render();assert.deepEqual(state.reference,original);
 c.control.getPosition=()=>null;c.render();assert.deepEqual(state.reference,original);
 state.lines=['head','int x = 1;','','tail'];c.render();assert.equal(state.reference.line,3);assert.equal(state.reference.candidate,'int y = 2;');
 c.control.getPosition=()=>({lineNumber:4,column:1});c.render();assert.equal(state.reference.line,3);
 t.teaching=false;c.render();assert.equal(state.reference,undefined);
});
test('course reference stays at its marker with the cursor elsewhere or no focused editor',()=>{
 const t=model();t.guidance=undefined;t.hintsVisible=true;
 t.currentStep=()=>({anchors:[{id:'s',path:'main.c',marker:'// STEP'}],guidance:[{anchorId:'s',requiredSymbols:[],lines:['int x;','int y;']}]});
 const {c,state}=editor(t,['// STEP','','tail'],3);c.active=()=>false;c.render();
 assert.equal(state.reference.line,2);assert.equal(state.reference.candidate,'int x;');assert.equal(state.tracing,false);
});

test('shared task overlay obeys the AI switches without depending on the active file',()=>{
 const Subject=methods('nodu-tutor-hints.ts','NoduTutorHintsContribution',['renderTask']);
 for(const state of [{teaching:false,floatVisible:true},{teaching:true,floatVisible:false},{teaching:true,floatVisible:true,empty:true}]){
  let removed=0;const c=Object.assign(new Subject(),{tutor:{...state,goalState:{status:state.empty?'none':'active'}},removeTask(){removed++;}});
  c.renderTask();assert.equal(removed,1);
 }
});
test('task window can cross editor splits and clamps only to the whole editor area',()=>{
 const Subject=methods('nodu-tutor-hints.ts','NoduTutorHintsContribution',['moveTask']);
 const c=Object.assign(new Subject(),{taskHost:{offsetWidth:324,offsetHeight:220,style:{}},taskLayer:{clientWidth:1200,clientHeight:700},taskOffset:{x:0,y:0}});
 c.moveTask(-650,100);assert.deepEqual(c.taskOffset,{x:-650,y:100});
 c.moveTask(-900,1000);assert.deepEqual(c.taskOffset,{x:-876,y:480});
 c.taskLayer.clientWidth=500;c.taskLayer.clientHeight=300;c.moveTask(0,0);assert.deepEqual(c.taskOffset,{x:-176,y:80});
 c.moveTask(1000,-1000);assert.deepEqual(c.taskOffset,{x:0,y:0});
});
test('split editors share one React task host and retain its position on file switches',()=>{
 let mounts=0,renders=0,appends=0;const bounds={left:200,top:50,width:1200,height:700};
 const node=()=>({style:{setProperty(){}},append(){},offsetWidth:324,offsetHeight:220,clientWidth:1200,clientHeight:700});
 const Subject=methods('nodu-tutor-hints.ts','NoduTutorHintsContribution',['renderTask','moveTask'],{
  document:{createElement:node,body:{append(){appends++;}}},createRoot:()=>{mounts++;return{render(){renders++;}};},
  React:{createElement:(_type,props)=>props},TutorTaskWindow:{},TUTOR_COMMANDS:{openReference:'open',openPanel:'panel'},
 });
 const c=Object.assign(new Subject(),{tutor:{teaching:true,floatVisible:true,goalState:{status:'active'}},shell:{mainPanel:{node:{getBoundingClientRect:()=>bounds}}},taskOffset:{x:0,y:0}});
 c.renderTask();c.moveTask(-500,80);const host=c.taskHost;
 c.editors={currentEditor:{id:'other-file'}};c.renderTask();
 assert.equal(c.taskHost,host);assert.equal(mounts,1);assert.equal(appends,1);assert.equal(renders,2);
 assert.deepEqual(c.taskOffset,{x:-500,y:80});assert.equal(c.taskLayer.style.left,'200px');
});
