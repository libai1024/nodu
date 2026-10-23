// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const helpers = require('../lib/common/tutor/tutor-guidance');
// Execute the production class methods with a deterministic editor, without a browser or model service.
function methods(file, className, names, dependencies = {}) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '../src/browser', file), 'utf8'), ts.ScriptTarget.Latest, true);
    const cls = source.statements.find(n => ts.isClassDeclaration(n) && n.name.text === className);
    const members = cls.members.filter(m => names.includes(m.name?.getText(source))).map(m => m.getText(source)).join('\n');
    const js = ts.transpile(`class Subject { ${members} }`, { target: ts.ScriptTarget.ES2022 });
    return new Function(...Object.keys(dependencies), js + '; return Subject;')(...Object.values(dependencies));
}
const Model = methods('nodu-tutor-model.ts', 'NoduTutorModel', ['updateBuffer', 'invalidate', 'notify', 'restoreGoalGuidance', 'autoCheckFragment'], helpers);
const Controller = methods('nodu-tutor-hints.ts', 'TutorEditorController', ['edit', 'render', 'enabled', 'enqueue', 'historyKey', 'saveHistory', 'restoreHistory'], {
    ...helpers, monaco: { Range: class { constructor(line, col, endLine, endCol) { Object.assign(this, {startLineNumber:line,startColumn:col,endLineNumber:endLine,endColumn:endCol}); } }, editor: { InjectedTextCursorStops: {None:0}, TrackedRangeStickiness: {NeverGrowsWhenTypingAtEdges:0} } }
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
        decorations:{set:d=>{state.decorations=d;},clear:()=>{}}, removeOverlay(){}, schedule(){}, queueHistory(){}, active:()=>true,
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
    assert.equal(state.decorations.find(d=>d.options.after)?.options.after.content,'nt y = 2;');
    t.updateBuffer({path:'other.c',text:'i',version:3,line:1}); assert.equal(t.guidance,undefined);
    assert.equal(helpers.guidanceEditMatches({path:'a',text:'head\n\ntail'},{path:'a',text:'changed\ni\ntail'},2,2),false);
});
test('editing the next exercise line invalidates evidence but preserves unchanged-line guidance progress', () => {
    const t = model('// STEP\nint x = 1;\n', {}); t.guidance=undefined; t.hintsVisible=true;
    t.currentStep=()=>({anchors:[{id:'s',path:'main.c',marker:'// STEP'}],guidance:[{anchorId:'s',requiredSymbols:[],lines:['int x = 1;','int y = 2;']}]});
    const {c,state}=editor(t,['// STEP','int x = 1;',''],3);
    c.tasks.set('2',{decoration:'2',text:'int x = 1;',status:'ok',guided:true,note:''});
    state.lines[2]='i'; state.version++;
    c.edit({changes:[{range:{startLineNumber:3,endLineNumber:3},text:'i'}]});
    assert.equal(c.tasks.get('2').status,'stale'); assert.equal(c.tasks.get('2').guided,true);
    assert.equal(state.decorations.find(d=>d.options.after)?.options.after.content,'nt y = 2;');
    state.lines[1]='int x = 9;'; c.edit({changes:[]});
    assert.equal(c.tasks.get('2').guided,false);
    assert.equal(state.decorations.some(d=>d.options.after),false);
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
    c.render();assert.equal(state.decorations.find(d=>d.options.after)?.options.after.content,'nt x = 1;');
    state.lines[1]='void different(void)';c.render();assert.equal(state.decorations.some(d=>d.options.after),false);
});

test('course navigation authorizes files and abandons a location after switching projects', async () => {
    const commands={openReference:'ref',toggleHints:'h',highlight:'hi',annotations:'a',float:'f',guidance:'g',check:'c',revealStep:'reveal'};
    const Subject=methods('nodu-tutor-hints.ts','NoduTutorHintsContribution',['registerCommands'],{TUTOR_COMMANDS:commands,MonacoEditor:{get:w=>w},...helpers});
    const handlers=new Map(),step={anchors:[{path:'drivers/sensor.c',marker:'// STEP'}]},root={resolve:p=>p};
    let opens=0,position;const control={getModel:()=>({getLinesContent:()=>['// STEP',''],getLineCount:()=>2}),setPosition:p=>position=p,revealLineInCenterIfOutsideViewport(){},focus(){}};
    const tutor={enabled:true,rootUri:root,currentStep:()=>step,notify(){},resolveReference:async()=>{throw Error('outside project');}};
    const subject=Object.assign(new Subject(),{tutor,editors:{open:async()=>{opens++;return {getControl:()=>control};}}});
    subject.registerCommands({registerCommand:(c,h)=>handlers.set(c.id,h)});
    await handlers.get('reveal').execute();assert.equal(opens,0);assert.match(tutor.error,/outside/);
    tutor.resolveReference=async()=>({path:'drivers/sensor.c',line:1});await handlers.get('reveal').execute();assert.equal(opens,1);assert.equal(position.lineNumber,2);
    tutor.resolveReference=async()=>{tutor.rootUri={resolve:p=>p};return {path:'drivers/sensor.c',line:1};};
    await handlers.get('reveal').execute();assert.equal(opens,1);
});

test('dynamic lesson opens the next file and focuses validated guidance without editing source', async () => {
    const Subject=methods('nodu-tutor-hints.ts','NoduTutorHintsContribution',['prepareGoal'],{MonacoEditor:{get:w=>w}});
    const text='int main(){\n\n}',state={revision:2,status:'active',steps:[{path:'next.c'}],current:0};let position,opened;
    const model={getValueLength:()=>text.length,getValue:()=>text,getVersionId:()=>7,isDisposed:()=>false,getLineMaxColumn:()=>1};
    const control={getModel:()=>model,getPosition:()=>({lineNumber:1}),setPosition:p=>position=p,revealLineInCenterIfOutsideViewport(){},focus(){}};
    const widget={getControl:()=>control},editors={currentEditor:undefined,open:async p=>{opened=p;editors.currentEditor=widget;return widget;}};
    const tutor={rootUri:{resolve:p=>p},workspaceId:'w',teaching:true,goalState:state,notify(){},resolveReference:async p=>({path:p,line:1}),updateBuffer:b=>tutor.buffer=b,
        goalAction:async(a,p,placement)=>{assert.equal(placement,'suggest');tutor.goalState={...state,revision:3,fragment:{source:{path:'next.c',text},answer:{guidance:{anchorLine:2}}}};}};
    await Object.assign(new Subject(),{tutor,editors}).prepareGoal();assert.equal(opened,'next.c');assert.equal(position.lineNumber,2);assert.equal(tutor.buffer.text,text);
    // A user switching editors during the request must retain their focus.
    position=undefined;tutor.goalState=state;tutor.goalAction=async()=>{editors.currentEditor={};tutor.goalState={...state,fragment:{source:{path:'next.c',text},answer:{guidance:{anchorLine:2}}}};};
    await Object.assign(new Subject(),{tutor,editors}).prepareGoal();assert.equal(position,undefined);
});
test('reviewed equivalent lines trigger a fresh fragment review without being marked complete locally',()=>{
 const t=model();t.goalState={status:'active',revision:4,fragment:{source:{path:'main.c',text:'\n\n',line:1,version:1},answer:{guidance:{anchorLine:1,lines:['int x = 1;','x += 1;']}}}};
 const calls=[];t.goalAction=a=>calls.push(a);t.buffer={path:'main.c',text:'int x=1;\nx=x+1;',version:3,line:2};
 t.autoCheckFragment();assert.equal(calls.length,0);t.autoCheckFragment([1]);assert.equal(calls.length,0);
 t.autoCheckFragment([1,2]);t.autoCheckFragment([1,2]);assert.deepEqual(calls,['check']);assert.equal(t.goalState.status,'active');
 t.goalState.status='paused';t.lastAutoFragment=undefined;t.autoCheckFragment([1,2]);assert.equal(calls.length,1);
});
