// SPDX-License-Identifier: MIT
// Component contracts with deterministic hooks; native screenshots cover DOM/layout.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const defer=()=>{let resolve;const promise=new Promise(a=>{resolve=a;});return{promise,resolve};};
function component(file,name,props){
 const slots=[],effects=[],listeners=new Map();let cursor=0,tree,dead=false;
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment',
 useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},
 useRef(value){const i=cursor++;return slots[i]??={current:value};},
 useCallback(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn;},
 useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const previous=slots[i];slots[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{previous?.cleanup?.();slots[i].cleanup=fn();});}}
 };
 const filename=path.join(__dirname,'../lib',file), actualRequire=createRequire(filename), exports={};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,require:n=>n==='@theia/core/shared/react'?React:n.includes('react-dialog')?{ReactDialog:class{}}:n.endsWith('/dialogs')?{}:n.includes('nodu-embedded-model')?{EmbeddedError:class extends Error{}}:n.includes('scope-theme')?{}:n.includes('scope-brand')?{NoduBrand:'brand'}:n.includes('nodu-new-project')?{NewProjectForm:'form-component'}:actualRequire(n),window:{addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)},document:{activeElement:null},navigator:{userAgent:'Mac'},requestAnimationFrame:f=>f(),Error,Promise,String});
 const render=()=>{cursor=0;tree=exports[name](props);for(const effect of effects.splice(0))effect();return tree;};
 const nodes=()=>{const all=[];const walk=v=>{if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object'){all.push(v);walk(v.props?.children);}};walk(tree);return all;};
 const text=n=>(n?.props?.children??[]).flat(Infinity).map(x=>typeof x==='object'?text(x):x||'').join('');
 return{render,nodes,text,listeners,get tree(){return tree;},find:predicate=>nodes().find(predicate),button:label=>nodes().find(n=>n.type==='button'&&(n.props['aria-label']??text(n))===label),async flush(){for(let i=0;i<5;i++){await new Promise(r=>setImmediate(r));if(!dead)render();}},unmount(){dead=true;for(const s of slots)s?.cleanup?.();}};
}
function setup(overrides={}) {
 const calls=[], state={revision:2,status:'active',goal:'串口输出',title:'USART1 串口输出',steps:Array.from({length:5},(_,i)=>({id:`step-${i+1}`,title:`步骤 ${i+1}`,goal:'写代码',path:i===2?'Core/Inc/board.h':'Core/Src/main.c'})),current:2,fragment:{answer:{guidance:{anchorLine:17}}}};
 const tutor={workspaceId:'test',goalState:state,progress:{steps:{}},buffer:{path:'Core/Inc/board.h'},configured:true,currentStep:()=>undefined,goalAction:async(...args)=>calls.push(['goal',...args]),setDisplay:(...args)=>calls.push(['display',...args]),send:(...args)=>calls.push(['send',...args]),...overrides};
 const props={tutor,narrow:false,prepare:()=>calls.push(['prepare']),open:(...a)=>calls.push(['open',...a]),openPanel:()=>calls.push(['panel'])};const c=component('browser/nodu-tutor-task-window.js','TutorTaskWindow',props);c.render();return{c,tutor,calls,props};
}
test('task click opens the mapped file and active anchor without changing progress',()=>{
 const {c,calls,tutor}=setup();c.button('步骤 3').props.onClick();assert.deepEqual(calls,[['open','Core/Inc/board.h',17]]);assert.equal(tutor.goalState.current,2);
 c.button('打开 Core/Inc/board.h：步骤 3').props.onClick();assert.deepEqual(calls[1],calls[0]);
});
test('collapse and Escape preserve task and code, count expands all steps',()=>{
 const {c,calls}=setup();c.button('已检查 2 / 5 步').props.onClick();c.render();assert.equal(c.nodes().filter(n=>n.type==='li').length,5);
 c.tree.props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});c.render();assert.equal(c.nodes().filter(n=>n.type==='li').length,0);assert.deepEqual(calls,[]);
});
test('AI menu display switch hides the window without pausing or cancelling task',()=>{
 const {c,calls}=setup();c.button('任务操作').props.onClick();c.render();c.button('隐藏任务窗').props.onClick();assert.deepEqual(calls,[['display','floatVisible',false]]);
});
test('remove requires explicit row decision and sends stable ID only',async()=>{
 const {c,calls}=setup();c.button('任务操作').props.onClick();c.render();c.button('编辑步骤').props.onClick();c.render();assert.equal(c.button('删除 步骤 1'),undefined);
 c.button('删除 步骤 3').props.onClick();c.render();assert.deepEqual(calls,[]);await c.button('移除').props.onClick();assert.deepEqual(calls,[['goal','remove',undefined,undefined,'step-3']]);
});
test('task checks reuse backend review and paused mode offers continue',()=>{
 const {c,tutor,calls}=setup();c.button('检查当前步骤').props.onClick({});assert.deepEqual(calls,[['goal','check']]);
 tutor.goalState.status='paused';c.render();assert.equal(c.button('检查当前步骤').props.disabled,true);c.button('继续').props.onClick({});assert.deepEqual(calls[1],['goal','resume']);
});
test('adding sends user instruction, disables when busy and retains errors',async()=>{
 const {c,tutor,calls}=setup();c.button('任务操作').props.onClick();c.render();c.button('添加步骤').props.onClick();c.render();
 const input=()=>c.find(n=>n.type==='textarea');input().props.onChange({target:{value:'增加 CRC 校验'}});c.render();c.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await c.flush();assert.deepEqual(calls,[['goal','add','增加 CRC 校验']]);
 tutor.busy={goal:'add'};tutor.error='连接断开';c.render();assert.equal(c.button('生成中').props.disabled,true);assert.ok(c.find(n=>n.props?.role==='alert'));assert.equal(input().props.value,'增加 CRC 校验');
});
test('narrow editor starts collapsed and workspace change clears editing draft',()=>{
 const {c,props,tutor}=setup();props.narrow=true;c.render();c.render();assert.equal(c.nodes().filter(n=>n.type==='li').length,0);
 tutor.workspaceId='other';c.render();c.render();assert.equal(c.find(n=>n.type==='textarea'),undefined);
});
test('completed view cannot award build or hardware success',()=>{
 const {c,tutor,calls}=setup();tutor.goalState.status='complete';tutor.goalState.current=5;tutor.goalState.fragment=undefined;c.render();assert.ok(c.text(c.tree).includes('代码跟写完成'));assert.equal(c.button('检查当前步骤'),undefined);assert.deepEqual(calls,[]);
});
