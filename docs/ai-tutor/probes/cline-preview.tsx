import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Conversation, ConversationViewport, ConversationContent, ConversationScrollButton, Message, MessageContent } from './packages/cline-ui/dist/components/agent-chat/index.js';
import './packages/cline-ui/components/agent-chat/agent-chat.css';
function App() {
 const [mode,setMode]=React.useState<'教学'|'提问'>('教学');
 const [draft,setDraft]=React.useState('');
 const [messages,setMessages]=React.useState<Array<{id:number;from:'user'|'assistant';text:string}>>([{id:1,from:'assistant',text:'读取数据后，检查返回值。'}]);
 const [light,setLight]=React.useState(false);
 const [running,setRunning]=React.useState(false);
 const generation=React.useRef(0);
 const send=()=>{if(!draft.trim())return;const text=draft;setDraft('');setMessages(m=>[...m,{id:Date.now(),from:'user',text}]);};
 const stream=()=>{const id=Date.now(),revision=++generation.current;let count=0;setRunning(true);setMessages(m=>[...m,{id,from:'assistant',text:''}]);const timer=setInterval(()=>{if(revision!==generation.current){clearInterval(timer);return;}count++;setMessages(m=>m.map(x=>x.id===id?{...x,text:'示例检查结果。'.repeat(count)}:x));if(count>=20){clearInterval(timer);setRunning(false);}},50);};
 return <div className={light?'preview light':'preview'}><header><button onClick={()=>setMode('教学')}>教学</button><button onClick={()=>setMode('提问')}>提问</button><button onClick={()=>setLight(!light)}>主题</button></header>{mode==='教学'&&<div className="step">7/13 读取数据 <button>检查本步</button></div>}<Conversation style={{height:400}}><ConversationViewport aria-label="消息"><ConversationContent>{messages.map(m=><Message key={m.id} from={m.from}><MessageContent>{m.text}</MessageContent></Message>)}</ConversationContent></ConversationViewport><ConversationScrollButton aria-label="回到最新">↓</ConversationScrollButton></Conversation><footer><textarea aria-label="问题" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send();}}}/><button onClick={send}>发送</button><button onClick={stream} disabled={running}>模拟流</button><button onClick={()=>{generation.current++;setRunning(false);}}>停止</button></footer><div role="status">{running?'接收中':'就绪'}</div></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
