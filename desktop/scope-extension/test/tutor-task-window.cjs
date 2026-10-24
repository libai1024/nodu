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
 const tutor={workspaceId:'test',goalState:state,progress:{steps:{},decisions:{}},buffer:{path:'Core/Inc/board.h'},configured:true,currentStep:()=>undefined,goalAction:async(...args)=>calls.push(['goal',...args]),setDisplay:(...args)=>calls.push(['display',...args]),send:(...args)=>calls.push(['send',...args]),...overrides};
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

function setupCourse() {
 const {c,tutor,calls,props}=setup();
 const step=(id,title,extra={})=>({id,title,kind:'code',goal:`完成 ${title}`,why:`理解 ${title}`,anchors:[{id:'code',path:`Core/Src/${id}.c`,marker:`TUTOR(${id})`}],requirements:[{id:'check',text:`核对 ${title}`}],dependsOn:[],guidance:[{id:'sample',lines:['Board_Init();']}],...extra});
 tutor.goalState={status:'none',revision:0,steps:[],current:0};
 tutor.plan={id:'uart',contentHash:'course-one',title:'UART 课程',steps:[
  step('init','初始化'),
  step('choose','选择输出方式',{kind:'decide',anchors:[],options:[{id:'uart',label:'串口',available:true},{id:'usb',label:'USB',available:false}]}),
  step('send','发送消息',{dependsOn:[{stepId:'init',mode:'required'}]})
 ]};
 tutor.progress={steps:{},decisions:{},current:'init'};
 tutor.currentStep=()=>tutor.plan.steps.find(s=>s.id===tutor.progress.current);
 tutor.available=id=>tutor.plan.steps.find(s=>s.id===id)?.dependsOn.every(d=>d.mode==='advisory'||tutor.progress.steps[d.stepId]);
 tutor.action=async action=>{calls.push(['course',JSON.parse(JSON.stringify(action))]);if(action.type==='select')tutor.progress.current=action.stepId;if(action.type==='decide')tutor.progress.decisions[action.stepId]=action.optionId;};
 props.revealStep=()=>calls.push(['reveal']);
 c.render();c.render();return{c,tutor,calls,props};
}
test('course rows select by stable ID, protect dependencies and allow a decision without a file',async()=>{
 const {c,tutor,calls}=setupCourse();
 assert.equal(c.button('发送消息').props.disabled,true);c.button('发送消息').props.onClick();await c.flush();assert.deepEqual(calls,[]);
 assert.equal(c.button('选择输出方式').props.disabled,false);c.button('选择输出方式').props.onClick();await c.flush();
 assert.deepEqual(calls,[['course',{type:'select',stepId:'choose'}]]);assert.equal(tutor.currentStep().id,'choose');
 assert.equal(c.button('打开 Core/Src/init.c：初始化').props.disabled,undefined);
 c.button('打开 Core/Src/init.c：初始化').props.onClick();assert.deepEqual(calls[1],['open','Core/Src/init.c',1]);
});
test('course details keep explanations, requirements, choices and code out of the default task view',async()=>{
 const {c,tutor,calls}=setupCourse();assert.equal(c.find(n=>n.props?.['aria-label']==='步骤详情'),undefined);
 c.button('步骤详情').props.onClick();c.render();assert.ok(c.text(c.tree).includes('理解 初始化'));assert.ok(c.text(c.tree).includes('核对 初始化'));
 assert.ok(c.text(c.tree).includes('Board_Init();'));
 c.button('选择输出方式').props.onClick();await c.flush();assert.equal(c.button('USB').props.disabled,true);
 c.button('串口').props.onClick();await c.flush();assert.deepEqual(calls[1],['course',{type:'decide',stepId:'choose',optionId:'uart'}]);
 assert.equal(c.button('串口').props['aria-pressed'],true);assert.equal(tutor.progress.decisions.choose,'uart');
 c.tree.props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){}});c.render();assert.equal(c.find(n=>n.props?.['aria-label']==='步骤详情'),undefined);assert.ok(c.button('初始化'));
});
test('course self-check and reopening preserve their original distinction and exact marker navigation',async()=>{
 const {c,tutor,calls}=setupCourse();
 c.button('打开 Core/Src/init.c：初始化').props.onClick();assert.deepEqual(calls,[['reveal']]);
 c.button('任务操作').props.onClick();c.render();c.button('定位代码').props.onClick();assert.deepEqual(calls[1],['reveal']);
 c.render();c.button('任务操作').props.onClick();c.render();c.button('自查完成').props.onClick();await c.flush();
 assert.deepEqual(calls[2],['course',{type:'manualCheck',stepId:'init'}]);
 tutor.progress.steps.init={status:'self-checked'};c.render();assert.equal(c.button('发送消息').props.disabled,false);
 c.button('任务操作').props.onClick();c.render();c.button('重新练习').props.onClick();await c.flush();
 assert.deepEqual(calls[3],['course',{type:'reopen',stepId:'init'}]);assert.equal(calls.some(call=>call[0]==='goal'),false);
});
test('completed courses can select a passed step or reset, and resetting needs explicit confirmation',async()=>{
 const {c,tutor,calls}=setupCourse();
 tutor.progress.steps={init:{status:'self-checked'},choose:{status:'self-checked'},send:{status:'self-checked'}};tutor.progress.current=undefined;c.render();
 assert.ok(c.text(c.tree).includes('课程已自查'));assert.equal(c.button('检查当前步骤'),undefined);
 c.button('任务操作').props.onClick();c.render();c.button('重置进度').props.onClick();c.render();assert.deepEqual(calls,[]);
 c.button('取消').props.onClick();c.render();assert.deepEqual(calls,[]);
 c.button('初始化').props.onClick();await c.flush();assert.equal(tutor.progress.current,'init');
 c.button('任务操作').props.onClick();c.render();assert.ok(c.button('重新练习'));c.button('重置进度').props.onClick();c.render();c.button('重置').props.onClick();await c.flush();
 assert.deepEqual(calls,[['course',{type:'select',stepId:'init'}],['course',{type:'reset'}]]);
});
test('course controls gate code checks and concurrent persistence; errors remain visible',async()=>{
 const {c,tutor,calls}=setupCourse();tutor.buffer=undefined;c.render();assert.equal(c.button('检查当前步骤').props.disabled,true);
 tutor.buffer={path:'Core/Src/init.c'};const pending=defer();tutor.action=async action=>{calls.push(['course',action]);await pending.promise;tutor.error='学习记录保存失败';};c.render();
 const select=c.button('选择输出方式');select.props.onClick();select.props.onClick();c.render();assert.equal(c.button('初始化').props.disabled,true);assert.equal(c.button('检查当前步骤').props.disabled,true);
 assert.equal(calls.length,1);pending.resolve();await c.flush();assert.equal(c.button('初始化').props.disabled,false);assert.ok(c.text(c.find(n=>n.props?.role==='alert')).includes('学习记录保存失败'));
});
test('switching course or workspace closes reset confirmation and ignores old pending local state',async()=>{
 const {c,tutor}=setupCourse();c.button('任务操作').props.onClick();c.render();c.button('重置进度').props.onClick();c.render();
 tutor.plan={...tutor.plan,contentHash:'course-two'};c.render();c.render();assert.equal(c.button('重置'),undefined);
 const pending=defer();tutor.action=()=>pending.promise;c.button('选择输出方式').props.onClick();c.render();assert.equal(c.button('初始化').props.disabled,true);
 tutor.workspaceId='other';c.render();c.render();assert.equal(c.button('初始化').props.disabled,false);pending.resolve();await c.flush();assert.equal(c.button('初始化').props.disabled,false);assert.equal(c.button('重置'),undefined);
});
