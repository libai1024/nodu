// SPDX-License-Identifier: MIT
// Exercise the production panel's event handlers with measured scroll geometry.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
function mount() {
    let cursor=0, tree; const slots=[], effects=[], calls=[], observers=[];
    const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
    const React={createElement:(type,props,...children)=>({type,props:{...props,children:type==='Context'?[children[0]({type:'button',props:{'aria-label':'添加代码上下文'}})]:children}}),Fragment:'fragment',
        useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}];},
        useReducer(fn,initial){const [v,set]=this.useState(initial);return[v,()=>set(fn)];},
        useRef(v){const i=cursor++;return slots[i]??={current:v};},
        useLayoutEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||!equal(old.deps,deps)){slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}},
        useEffect(fn,deps){this.useLayoutEffect(fn,deps);}
    };
    const no=()=>()=>undefined, exports={};
    const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/browser/nodu-tutor-widget.tsx'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,experimentalDecorators:true}}).outputText+'\nexports.TutorPanel=TutorPanel;';
    vm.runInNewContext(code,{exports,Date,WeakMap,Map,ResizeObserver:class{constructor(callback){observers.push(callback);}observe(){}disconnect(){}},require:id=>{
        if(id.endsWith('/react'))return React;
        if(id.includes('inversify'))return{inject:no,injectable:no,postConstruct:no};
        if(id.includes('view-contribution'))return{AbstractViewContribution:class{}};
        if(id==='@theia/core/lib/browser')return{ReactWidget:class{}};
        if(id.endsWith('nodu-tutor-messages'))return{TutorMessage:'Message'};
        if(id.endsWith('nodu-tutor-chat-controls'))return{ModePicker:'ModePicker',ModelPicker:'Picker',ChatHeader:'Header'};
        if(id.endsWith('nodu-tutor-context-picker'))return{ContextPicker:'Context'};
        if(id.endsWith('nodu-tutor-hints'))return{TUTOR_COMMANDS:{openReference:'open'}};
        return {};
    }});
    const log={scrollTop:0,scrollHeight:1400,clientHeight:400},input={style:{},clientWidth:360,scrollHeight:56,focus(){calls.push('focus');}};
    const tutor={workspaceId:'project',rootUri:'root',mode:'ask',activeConversationId:'chat-one',canSendChat:true,connectionState:'connected',
        goalState:{status:'none',revision:0},messages:{ask:[{id:'1',role:'assistant',text:'first',status:'pending'}],teach:[]},drafts:{ask:'',teach:''},
        canRetry:()=>false,setDraft(v){this.drafts[this.mode]=v;},send(){calls.push('send');this.drafts[this.mode]='';},cancel(){calls.push('stop');this.busy=undefined;}};
    function nodes(){const out=[];function visit(v){if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object'){out.push(v);visit(v.props?.children);}}visit(tree);return out;}
    function render(){cursor=0;tree=exports.TutorPanel({tutor,run(){}});for(const n of nodes()){if(n.props?.ref)n.props.ref.current=n.type==='textarea'?input:log;}for(const effect of effects.splice(0))effect();}
    render();
    return {tutor,log,input,calls,render,resize(width,height){input.clientWidth=width;input.scrollHeight=height;observers.forEach(f=>f());},find:fn=>nodes().find(fn),key(e){nodes().find(n=>n.type==='textarea').props.onKeyDown({preventDefault(){},nativeEvent:{isComposing:false},keyCode:0,shiftKey:false,...e});}};
}
test('streaming follows only the reading bottom and explicit latest restores following',()=>{
    const c=mount();assert.equal(c.log.scrollTop,1400);
    const reading=()=>c.find(n=>n.props?.role==='log');reading().props.onWheel();c.log.scrollTop=100;reading().props.onScroll();c.render();
    c.log.scrollHeight=1800;c.tutor.messages.ask[0].text+=' next chunk';c.render();assert.equal(c.log.scrollTop,100);
    c.find(n=>n.props?.className==='nodu-ai-latest').props.onClick();assert.equal(c.log.scrollTop,1800);
    c.log.scrollHeight=1900;c.tutor.messages.ask[0].text+=' again';c.render();assert.equal(c.log.scrollTop,1900);
});
test('scroll position survives conversation switching without sending or focusing the composer',()=>{
    const c=mount(),reading=c.find(n=>n.props?.role==='log');reading.props.onWheel();c.log.scrollTop=120;reading.props.onScroll();c.render();
    c.tutor.activeConversationId='chat-two';c.render();c.tutor.activeConversationId='chat-one';c.render();assert.equal(c.log.scrollTop,120);assert.deepEqual(c.calls,[]);
});
test('Enter never queues while generating, IME stays intact and stop preserves the draft',()=>{
    const c=mount();c.tutor.drafts.ask='下一条草稿';c.tutor.busy={kind:'chat'};c.render();c.key({key:'Enter'});assert.deepEqual(c.calls,[]);
    let prevented=false; const stop=c.find(n=>n.props?.['aria-label']==='停止');assert.equal(stop.props.type,'button');stop.props.onClick({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(c.tutor.drafts.ask,'下一条草稿');c.render();
    c.key({key:'Enter',nativeEvent:{isComposing:true}});c.key({key:'Enter',keyCode:229});c.key({key:'Enter',shiftKey:true});assert.deepEqual(c.calls,['stop']);
    assert.equal(c.find(n=>n.props?.['aria-label']==='发送').props.type,'button');c.key({key:'Enter'});assert.deepEqual(c.calls,['stop','send']);
});
test('history synchronization disables sending even while the transport is connected',()=>{
    const c=mount();c.tutor.canSendChat=false;c.tutor.drafts.ask='等待恢复';c.render();assert.equal(c.find(n=>n.props?.['aria-label']==='发送').props.disabled,true);c.key({key:'Enter'});assert.deepEqual(c.calls,[]);
});
test('resizing the sidebar reflows an existing draft without sending or moving focus',()=>{
    const c=mount();c.tutor.drafts.ask='保留未发送的多行草稿';c.render();
    c.resize(240,112);assert.equal(c.input.style.height,'112px');
    c.resize(220,320);assert.equal(c.input.style.height,'180px');
    c.resize(420,56);assert.equal(c.input.style.height,'56px');
    assert.equal(c.tutor.drafts.ask,'保留未发送的多行草稿');assert.deepEqual(c.calls,[]);
});

function descendants(tree) {
    const out=[];const visit=v=>{if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object'){out.push(v);visit(v.props?.children);}};
    visit(tree);return out;
}
function content(tree) {
    if(Array.isArray(tree))return tree.map(content).join('');
    return tree&&typeof tree==='object'?content(tree.props?.children):typeof tree==='string'?tree:'';
}
function modePicker() {
    let cursor=0,tree;const slots=[],calls=[],exports={};
    const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment',
        useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],v=>slots[i]=v];},useCallback:fn=>fn};
    const source=fs.readFileSync(path.join(__dirname,'../src/browser/nodu-tutor-chat-controls.tsx'),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
    vm.runInNewContext(code,{exports,require:id=>id.endsWith('/react')?React:{createPortal:v=>v}});
    const tutor={mode:'teach',drafts:{teach:'教学草稿',ask:'提问草稿'},setMode(value){calls.push(value);this.mode=value;}};
    const anchor={isConnected:true,focus(){calls.push('focus');}};
    const render=()=>{cursor=0;tree=exports.ModePicker({tutor});};render();
    return{tutor,anchor,calls,render,React,exports,button:()=>descendants(tree).find(n=>n.props?.['aria-label']==='对话模式'),
        items:()=>descendants(tree).filter(n=>n.props?.role==='menuitemradio'),
        popup:()=>descendants(tree).find(n=>n.type===exports.ChatPopover),
        open(){this.button().props.onClick({currentTarget:anchor});render();},
        key(key){let prevented=false,stopped=false;this.button().props.onKeyDown({key,currentTarget:anchor,preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});render();return{prevented,stopped};}};
}
test('composer uses the app mode picker and contains no native select',()=>{
    const c=mount();assert.ok(c.find(n=>n.type==='ModePicker'));assert.equal(c.find(n=>n.type==='select'),undefined);
});
test('mode trigger and choices pair icons with names; choosing restores focus and keeps mode drafts',()=>{
    const c=modePicker();
    const icon=(node,name)=>descendants(node).some(n=>n.type==='i'&&n.props.className?.includes(`codicon-${name}`));
    assert.equal(content(c.button()),'教学');assert.ok(icon(c.button(),'mortar-board'));
    assert.equal(c.button().props['aria-haspopup'],'menu');assert.equal(c.button().props['aria-expanded'],false);
    c.open();assert.equal(c.button().props['aria-expanded'],true);
    const [teach,ask]=c.items();assert.deepEqual(c.items().map(content),['教学','提问']);
    assert.equal(teach.props['aria-checked'],true);assert.equal(ask.props['aria-checked'],false);
    assert.ok(icon(teach,'mortar-board'));assert.ok(icon(ask,'comment-discussion'));
    ask.props.onClick();c.render();assert.deepEqual(c.calls,['ask','focus']);assert.equal(c.popup(),undefined);
    assert.equal(content(c.button()),'提问');assert.ok(icon(c.button(),'comment-discussion'));
    assert.deepEqual(c.tutor.drafts,{teach:'教学草稿',ask:'提问草稿'});
});
test('mode picker opens with either arrow and blocks switching during generation or history loading',()=>{
    for(const key of ['ArrowDown','ArrowUp']){
        const c=modePicker();assert.deepEqual(c.key(key),{prevented:true,stopped:true});assert.ok(c.popup());
        c.popup().props.close();c.render();assert.equal(c.button().props['aria-expanded'],false);
    }
    for(const pending of [{busy:{kind:'chat'}},{conversationLoading:true}]){
        const c=modePicker();Object.assign(c.tutor,pending);c.render();assert.equal(c.button().props.disabled,true);
        c.open();c.key('ArrowDown');assert.equal(c.popup(),undefined);assert.deepEqual(c.calls,[]);
        c.tutor.busy=undefined;c.tutor.conversationLoading=false;c.render();c.open();Object.assign(c.tutor,pending);c.render();
        assert.ok(c.items().every(n=>n.props.disabled));c.items()[1].props.onClick();assert.deepEqual(c.calls,[]);
        assert.equal(c.tutor.mode,'teach');
    }
});
test('custom mode menu preserves selected focus, arrow navigation and Escape return through the shared popover',()=>{
    const c=modePicker();c.open();const props=c.popup().props,document={body:{},activeElement:undefined,addEventListener(){},removeEventListener(){}};
    const items=c.items().map(n=>({checked:n.props['aria-checked'],focus(){document.activeElement=this;}}));
    let ref;const effects=[];
    c.React.useRef=()=>ref={current:undefined};c.React.useLayoutEffect=fn=>effects.push(fn);
    // Load this component in its own DOM boundary; no native menu or browser select participates.
    const exports={},source=fs.readFileSync(path.join(__dirname,'../src/browser/nodu-tutor-chat-controls.tsx'),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
    vm.runInNewContext(code,{exports,document,HTMLInputElement:class{},ResizeObserver:class{observe(){}disconnect(){}},
        window:{innerWidth:900,innerHeight:700,addEventListener(){},removeEventListener(){}},require:id=>id.endsWith('/react')?c.React:{createPortal:v=>v}});
    c.anchor.getBoundingClientRect=()=>({top:600,bottom:628,left:328,right:400});
    const menu=exports.ChatPopover(props);
    ref.current={style:{},getBoundingClientRect:()=>({height:70}),contains:()=>false,
        querySelector:selector=>selector==='input'?undefined:selector.includes('aria-checked')?items.find(n=>n.checked):items[0],querySelectorAll:()=>items};
    effects.forEach(effect=>effect());assert.equal(document.activeElement,items[0]);
    assert.equal(ref.current.style.width,'184px');assert.equal(ref.current.style.left,'328px');assert.equal(ref.current.style.top,'524px');
    const key=value=>menu.props.onKeyDown({key:value,target:document.activeElement,preventDefault(){},stopPropagation(){}});
    key('ArrowDown');assert.equal(document.activeElement,items[1]);key('ArrowDown');assert.equal(document.activeElement,items[0]);
    key('End');assert.equal(document.activeElement,items[1]);key('Home');assert.equal(document.activeElement,items[0]);
    key('Escape');c.render();assert.equal(c.popup(),undefined);assert.deepEqual(c.calls,['focus']);
});
