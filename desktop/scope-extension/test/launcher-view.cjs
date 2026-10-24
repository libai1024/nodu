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
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{exports,require:n=>n==='@theia/core/shared/react'?React:n.includes('react-dialog')?{ReactDialog:class{}}:n.endsWith('/dialogs')?{}:n.includes('nodu-embedded-model')?{EmbeddedError:class extends Error{}}:n.includes('scope-theme')?{}:n.includes('nodu-launcher-pages')?{SettingsPage:'settings-component',RowMenu:'row-menu'}:n.includes('nodu-project-icon')?{ProjectIcon:'project-icon'}:n.includes('scope-brand')?{NoduBrand:'brand'}:n.includes('nodu-new-project')?{NewProjectForm:'form-component'}:actualRequire(n),window:{addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)},document:{activeElement:null},navigator:{userAgent:'Mac'},requestAnimationFrame:f=>f(),Error,Promise,String});
 const render=()=>{cursor=0;tree=exports[name](props);for(const effect of effects.splice(0))effect();return tree;};
 const nodes=()=>{const all=[];const walk=v=>{if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object'){all.push(v);walk(v.props?.children);}};walk(tree);return all;};
 const text=n=>(n?.props?.children??[]).flat(Infinity).map(x=>typeof x==='object'?text(x):x||'').join('');
 return{render,nodes,text,listeners,get tree(){return tree;},find:predicate=>nodes().find(predicate),button:label=>nodes().find(n=>n.type==='button'&&(n.props['aria-label']??text(n))===label),async flush(){for(let i=0;i<5;i++){await new Promise(r=>setImmediate(r));if(!dead)render();}},unmount(){dead=true;for(const s of slots)s?.cleanup?.();}};
}
const base=overrides=>({projects:{recent:async()=>[{name:'demo',path:'/demo'}],examples:async()=>[],projectsDir:async()=>'/tmp/projects',...overrides},themes:{getCurrentTheme:()=>({type:'dark'}),onDidColorThemeChange:()=>({dispose(){}})},open:async()=>{},browse:async()=>{},model:{},dialogs:{},preferences:{ready:Promise.resolve(),get:()=>false,set:async()=>{},onPreferencesChanged:()=>({dispose(){}})}});
function launcher(props){const c=component('electron-browser/nodu-launcher-view.js','Launcher',props);c.render();return c;}
test('resolved project directory replaces skeleton with inline form',async()=>{
 const c=launcher(base());await c.flush();c.button('新建项目').props.onClick();c.render();await c.flush();assert.ok(c.find(n=>n.type==='form-component'));assert.equal(c.tree.props['aria-busy'],false);
});
test('empty reference result settles loading and shows empty state',async()=>{
 const c=launcher(base());await c.flush();c.button('示例项目').props.onClick();c.render();await c.flush();assert.equal(c.tree.props['aria-busy'],false);assert.ok(c.find(n=>n.props?.role==='status'&&c.text(n).includes('暂无示例项目')));
});
test('busy action ignores duplicate calls and navigation',async()=>{
 const held=defer(),props=base();let calls=0;props.open=()=>{calls++;return held.promise;};const c=launcher(props);await c.flush();const project=c.find(n=>n.props?.['data-project-path']==='/demo');project.props.onClick();project.props.onClick();c.render();assert.equal(calls,1);assert.equal(c.button('示例项目').props.disabled,true);c.button('示例项目').props.onClick();c.render();assert.ok(c.find(n=>n.props?.['aria-label']==='最近项目'));held.resolve();await c.flush();assert.equal(c.tree.props['aria-busy'],false);
});
test('refresh preserves an open failure and its dismiss action',async()=>{
 const props=base();props.open=async()=>{throw new Error('open failed');};const c=launcher(props);await c.flush();c.find(n=>n.props?.['data-project-path']==='/demo').props.onClick();await c.flush();c.listeners.get('focus')();await c.flush();assert.ok(c.text(c.tree).includes('open failed'));assert.ok(c.button('关闭'));
});
test('inline form busy signal blocks back navigation until operation ends',async()=>{
 const c=launcher(base());await c.flush();c.button('新建项目').props.onClick();c.render();await c.flush();const form=c.find(n=>n.type==='form-component');form.props.onBusyChange(true);c.render();const back=c.find(n=>n.props?.['aria-label']==='返回项目列表');assert.equal(back.props.disabled,true);back.props.onClick();c.render();assert.ok(c.find(n=>n.type==='form-component'));form.props.onBusyChange(false);form.props.close();c.render();assert.ok(c.find(n=>n.props?.['aria-label']==='最近项目'));
});
test('copy failure offers dismiss instead of retrying unrelated list fetch',async()=>{
 const c=launcher(base({examples:async()=>[{name:'course',path:'/course'}],copyExample:async()=>{throw new Error('copy failed');}}));await c.flush();c.button('示例项目').props.onClick();c.render();await c.flush();c.find(n=>n.props?.className==='nodu-launcher-example').props.onClick();await c.flush();assert.ok(c.button('关闭'));assert.equal(c.button('重试'),undefined);
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
 const c=launcher(base({examples:async()=>[{name:'course',path:'/course',summary:'long raw README commit SHA'}]}));await c.flush();c.button('示例项目').props.onClick();c.render();await c.flush();assert.equal(c.text(c.tree).includes('long raw README'),false);
});

test('four navigation entries and settings remain available without marketing copy',async()=>{
 const c=launcher(base({recent:async()=>[]}));await c.flush();
 for(const name of ['最近项目','新建项目','打开项目','示例项目','设置'])assert.ok(c.button(name));
 assert.equal(c.text(c.tree).includes('从第一行代码'),false);
 c.button('设置').props.onClick();c.render();assert.ok(c.find(n=>n.type==='settings-component'));
});
test('inline creation opens the new project after its busy signal without allowing duplicate opens',async()=>{
 const props=base(),held=defer();let opened=0;props.open=()=>{opened++;return held.promise;};
 const c=launcher(props);await c.flush();c.button('新建项目').props.onClick();c.render();await c.flush();
 const form=c.find(n=>n.type==='form-component');form.props.onBusyChange(true);form.props.onCreated({path:'/new'});form.props.onCreated({path:'/new'});c.render();
 assert.equal(opened,1);assert.equal(c.button('设置').props.disabled,true);held.resolve();await c.flush();
});
test('copied example does not open after the launcher unmounts',async()=>{
 const held=defer();let opened=0;const props=base({examples:async()=>[{name:'course',path:'/course'}],copyExample:()=>held.promise});props.open=async()=>{opened++;};
 const c=launcher(props);await c.flush();c.button('示例项目').props.onClick();c.render();await c.flush();c.find(n=>n.props?.className==='nodu-launcher-example').props.onClick();
 c.unmount();held.resolve('/copy');await c.flush();assert.equal(opened,0);
});
test('directory load failure retries the actual directory call',async()=>{
 let calls=0;const c=launcher(base({projectsDir:async()=>{if(++calls===1)throw new Error('directory failed');return '/projects';}}));await c.flush();
 c.button('新建项目').props.onClick();c.render();await c.flush();assert.ok(c.text(c.tree).includes('directory failed'));
 c.button('重试').props.onClick();c.render();await c.flush();assert.equal(calls,2);assert.ok(c.find(n=>n.type==='form-component'));
});
test('project menu preserves keep-launcher option and missing project remove action',async()=>{
 const calls=[];const props=base();props.open=async(...args)=>calls.push(args);const c=launcher(props);await c.flush();
 const anchor={getBoundingClientRect:()=>({right:200,bottom:100})};c.button('demo：更多操作').props.onClick({currentTarget:anchor});c.render();
 const menu=c.find(n=>n.type==='row-menu');menu.props.state.items[0].run();await c.flush();assert.deepEqual(calls,[['/demo',true]]);
 const missing=launcher(base({recent:async()=>[{name:'moved',path:'/old',missing:true}]}));await missing.flush();
 missing.button('moved：更多操作').props.onClick({currentTarget:anchor});missing.render();const items=missing.find(n=>n.type==='row-menu').props.state.items;
 assert.equal(items[0].disabled,true);assert.equal(items.at(-1).label,'从列表移除');
});
test('settings serializes preference writes and reports failure without claiming the toggle changed',async()=>{
 const failures=[];let writes=0,reject;const held=new Promise((_,r)=>{reject=r;});const props={themes:base().themes,preferences:{ready:Promise.resolve(),get:()=>false,set:()=>{writes++;return held;},onPreferencesChanged:()=>({dispose(){}})},onError:x=>failures.push(x)};
 const c=component('electron-browser/nodu-launcher-pages.js','SettingsPage',props);c.render();await c.flush();
 const input=c.find(n=>n.type==='input');input.props.onChange({currentTarget:{checked:true}});input.props.onChange({currentTarget:{checked:true}});c.render();
 assert.equal(writes,1);assert.equal(c.find(n=>n.type==='input').props.disabled,true);reject(new Error('save failed'));await c.flush();
 assert.deepEqual(failures,['save failed']);assert.equal(c.find(n=>n.type==='input').props.checked,false);assert.equal(c.find(n=>n.type==='input').props.disabled,false);
});
test('leaving settings drops late preference failures',async()=>{
 let reject;const held=new Promise((_,r)=>{reject=r;});const failures=[];const props={themes:base().themes,preferences:{ready:Promise.resolve(),get:()=>false,set:()=>held},onError:x=>failures.push(x)};
 const c=component('electron-browser/nodu-launcher-pages.js','SettingsPage',props);c.render();await c.flush();c.find(n=>n.type==='input').props.onChange({currentTarget:{checked:true}});c.unmount();reject(new Error('late failed'));await c.flush();assert.deepEqual(failures,[]);
});
test('new project open failure stays an operation notice rather than retrying directory lookup',async()=>{
 let directories=0;const props=base({projectsDir:async()=>{directories++;return '/projects';}});props.open=async()=>{throw new Error('open new failed');};
 const c=launcher(props);await c.flush();c.button('新建项目').props.onClick();c.render();await c.flush();c.find(n=>n.type==='form-component').props.onCreated({path:'/new'});await c.flush();
 assert.ok(c.find(n=>n.props?.className==='nodu-launcher-notice'));assert.ok(c.text(c.tree).includes('open new failed'));assert.equal(c.button('重试'),undefined);assert.equal(directories,1);
});
test('first-run welcome has one heading and three accessible project actions',async()=>{
 const c=launcher(base({recent:async()=>[]}));await c.flush();
 assert.deepEqual(c.nodes().filter(n=>n.type==='h1'||n.type==='h2').map(c.text),['欢迎使用 Nodu']);
 const welcome=c.find(n=>n.props?.className==='nodu-launcher-welcome');assert.ok(welcome);
 const actions=c.find(n=>n.props?.className==='nodu-launcher-start').props.children.flat();
 assert.deepEqual(actions.map(c.text),['新建项目','打开项目','示例项目']);
 for(const action of actions){assert.equal(action.type,'button');assert.equal(action.props.type,'button');assert.equal(action.props.disabled,false);}
 assert.equal(actions[0].props.className,'nodu-launcher-start-action primary');
 actions[0].props.onClick();c.render();await c.flush();assert.ok(c.find(n=>n.type==='form-component'));
});
test('empty-state open remains exclusive and restores its trigger focus after cancellation',async()=>{
 const held=defer();let opened=0,focused=0;const props=base({recent:async()=>[]});props.browse=()=>{opened++;return held.promise;};
 const c=launcher(props);await c.flush();const welcomeOpen=()=>c.find(n=>n.props?.className==='nodu-launcher-start-action'&&c.text(n)==='打开项目');
 const open=welcomeOpen(),trigger={isConnected:true,focus:()=>focused++};
 open.props.onClick({currentTarget:trigger});open.props.onClick({currentTarget:trigger});c.render();assert.equal(opened,1);assert.equal(welcomeOpen().props.disabled,true);
 held.resolve();await c.flush();assert.equal(focused,1);assert.equal(welcomeOpen().props.disabled,false);
});
test('loading, read failures and search misses never show the first-run empty title',async()=>{
 const held=defer(),c=launcher(base({recent:()=>held.promise}));assert.equal(c.text(c.tree).includes('欢迎使用 Nodu'),false);held.resolve([]);await c.flush();assert.equal(c.text(c.tree).includes('欢迎使用 Nodu'),true);
 const failed=launcher(base({recent:async()=>{throw new Error('read failed');}}));await failed.flush();assert.equal(failed.text(failed.tree).includes('欢迎使用 Nodu'),false);assert.ok(failed.button('重试'));
 const filtered=launcher(base());await filtered.flush();filtered.find(n=>n.type==='input').props.onChange({currentTarget:{value:'unmatched'}});filtered.render();assert.equal(filtered.text(filtered.tree).includes('欢迎使用 Nodu'),false);assert.ok(filtered.text(filtered.tree).includes('没有匹配的项目'));assert.ok(filtered.button('清除搜索'));
});

test('welcome example action opens the real example list without copying a project',async()=>{
 let calls=0,copies=0;const c=launcher(base({recent:async()=>[],examples:async()=>{calls++;return [{name:'course',path:'/course'}];},copyExample:async()=>{copies++;}}));await c.flush();
 const actions=c.find(n=>n.props?.className==='nodu-launcher-start').props.children.flat();actions[2].props.onClick();c.render();await c.flush();
 assert.equal(calls,1);assert.equal(copies,0);assert.ok(c.find(n=>n.props?.className==='nodu-launcher-example'));assert.equal(c.text(c.tree).includes('欢迎使用 Nodu'),false);
});
test('brand shows the actual application version and does not invent one when metadata fails',async()=>{
 const props=base({recent:async()=>[]});props.application={getApplicationInfo:async()=>({version:'0.2.2-test'})};const c=launcher(props);await c.flush();
 assert.equal(c.text(c.find(n=>n.props?.className==='nodu-launcher-version')),'0.2.2-test');
 props.application={getApplicationInfo:async()=>{throw new Error('unavailable');}};c.render();await c.flush();
 assert.equal(c.find(n=>n.props?.className==='nodu-launcher-version'),undefined);assert.ok(c.button('打开项目'));assert.equal(c.find(n=>n.props?.role==='alert'),undefined);
});
test('late version metadata from an old application provider cannot replace the current version',async()=>{
 const old=defer(),props=base();props.application={getApplicationInfo:()=>old.promise};const c=launcher(props);await c.flush();
 props.application={getApplicationInfo:async()=>({version:'0.2.2-current'})};c.render();await c.flush();old.resolve({version:'0.1.0-old'});await c.flush();
 assert.equal(c.text(c.find(n=>n.props?.className==='nodu-launcher-version')),'0.2.2-current');
});
