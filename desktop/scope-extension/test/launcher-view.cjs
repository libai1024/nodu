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
const base=overrides=>({projects:{recent:async()=>[{name:'demo',path:'/demo'}],examples:async()=>[],projectsDir:async()=>'/tmp/projects',...overrides},themes:{getCurrentTheme:()=>({type:'dark'}),onDidColorThemeChange:()=>({dispose(){}})},open:async()=>{},browse:async()=>{},model:{},dialogs:{}});
function launcher(props){const c=component('electron-browser/nodu-launcher-view.js','Launcher',props);c.render();return c;}
test('resolved project directory replaces skeleton with inline form',async()=>{
 const c=launcher(base());await c.flush();c.button('新建项目').props.onClick();c.render();await c.flush();assert.ok(c.find(n=>n.type==='form-component'));assert.equal(c.tree.props['aria-busy'],false);
});
test('empty reference result settles loading and shows empty state',async()=>{
 const c=launcher(base());await c.flush();c.button('参考项目').props.onClick();c.render();await c.flush();assert.equal(c.tree.props['aria-busy'],false);assert.ok(c.find(n=>n.props?.role==='status'&&c.text(n).includes('暂无参考项目')));
});
test('busy action ignores duplicate calls and navigation',async()=>{
 const held=defer(),props=base();let calls=0;props.open=()=>{calls++;return held.promise;};const c=launcher(props);await c.flush();const project=c.find(n=>n.props?.['data-project-path']==='/demo');project.props.onClick();project.props.onClick();c.render();assert.equal(calls,1);assert.equal(c.button('参考项目').props.disabled,true);c.button('参考项目').props.onClick();c.render();assert.ok(c.find(n=>n.props?.['aria-label']==='最近项目'));held.resolve();await c.flush();assert.equal(c.tree.props['aria-busy'],false);
});
test('refresh preserves an open failure and its dismiss action',async()=>{
 const props=base();props.open=async()=>{throw new Error('open failed');};const c=launcher(props);await c.flush();c.find(n=>n.props?.['data-project-path']==='/demo').props.onClick();await c.flush();c.listeners.get('focus')();await c.flush();assert.ok(c.text(c.tree).includes('open failed'));assert.ok(c.button('关闭'));
});
test('inline form busy signal blocks back navigation until operation ends',async()=>{
 const c=launcher(base());await c.flush();c.button('新建项目').props.onClick();c.render();await c.flush();const form=c.find(n=>n.type==='form-component');form.props.onBusyChange(true);c.render();const back=c.find(n=>n.props?.['aria-label']==='返回项目列表');assert.equal(back.props.disabled,true);back.props.onClick();c.render();assert.ok(c.find(n=>n.type==='form-component'));form.props.onBusyChange(false);form.props.close();c.render();assert.ok(c.find(n=>n.props?.['aria-label']==='最近项目'));
});
test('copy failure offers dismiss instead of retrying unrelated list fetch',async()=>{
 const c=launcher(base({examples:async()=>[{name:'course',path:'/course'}],copyExample:async()=>{throw new Error('copy failed');}}));await c.flush();c.button('参考项目').props.onClick();c.render();await c.flush();c.find(n=>n.props?.className==='nodu-launcher-example').props.onClick();await c.flush();assert.ok(c.button('关闭'));assert.equal(c.button('重试'),undefined);
});
test('directory picker failure is handled and releases form busy state',async()=>{
 const busy=[];const c=component('browser/nodu-new-project.js','NewProjectForm',{parent:'/tmp',family:'stm32f103',model:{},dialogs:{showOpenDialog:async()=>{throw new Error('picker failed');}},onCreated(){},close(){},onBusyChange:x=>busy.push(x)});c.render();c.find(n=>n.props?.['aria-label']==='浏览项目位置').props.onClick();await c.flush();assert.deepEqual(busy,[true,false]);assert.ok(c.text(c.tree).includes('picker failed'));assert.equal(c.tree.props['aria-busy'],false);
});
test('unmounted creation cannot open a project or call parent handlers',async()=>{
 const held=defer();let opened=0;const c=component('browser/nodu-new-project.js','NewProjectForm',{parent:'/tmp',family:'stm32f103',model:{call:()=>held.promise},dialogs:{},onCreated(){opened++;},close(){opened++;}});c.render();c.tree.props.onSubmit({preventDefault(){}});c.unmount();held.resolve({path:'/tmp/project'});await c.flush();assert.equal(opened,0);
});

test('operation failures use one dismissible notice while load failures stay beside retry',async()=>{
 const props=base();props.open=async()=>{throw new Error('open failed');};const c=launcher(props);await c.flush();c.find(n=>n.props?.['data-project-path']==='/demo').props.onClick();await c.flush();assert.equal(c.nodes().filter(n=>n.props?.role==='alert').length,1);assert.ok(c.find(n=>n.props?.className==='nodu-launcher-notice'));c.button('关闭').props.onClick();c.render();assert.equal(c.find(n=>n.props?.role==='alert'),undefined);
 const loaded=launcher(base({recent:async()=>{throw new Error('load failed');}}));await loaded.flush();assert.ok(loaded.find(n=>n.props?.className==='nodu-launcher-error'));assert.ok(loaded.button('重试'));assert.equal(loaded.find(n=>n.props?.className==='nodu-launcher-notice'),undefined);
});
test('reference rows do not leak README explanations into the workbench',async()=>{
 const c=launcher(base({examples:async()=>[{name:'course',path:'/course',summary:'long raw README commit SHA'}]}));await c.flush();c.button('参考项目').props.onClick();c.render();await c.flush();assert.equal(c.text(c.tree).includes('long raw README'),false);
});
