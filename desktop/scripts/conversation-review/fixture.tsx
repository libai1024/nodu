// SPDX-License-Identifier: MIT
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { TutorPanel } from '../../scope-extension/src/browser/nodu-tutor-widget';
import { ChatHeader } from '../../scope-extension/src/browser/nodu-tutor-chat-controls';
import { TutorConversationStore, conversationDisplayTitle } from '../../scope-extension/src/common/tutor/tutor-conversation';
import { workbenchColors, scopeColorDefaults } from '../../scope-extension/src/browser/nodu-theme-colors';
import '../../scope-extension/style/scope.css';
import '../../scope-extension/style/tutor.css';
import '../../scope-extension/style/tutor-messages.css';
import '@vscode/codicons/dist/codicon.css';
import './review.css';

const memory = new Map<string, string>();
const store = new TutorConversationStore({ get length() { return memory.size; }, key: i => [...memory.keys()][i] ?? null, getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: k => { memory.delete(k); } });
const project = 'isolated-ui-review';
function sample(question: string, answer: string, mode: 'teach' | 'ask', minutes: number, draft = '', status: 'done' | 'failed' | 'stopped' = 'done') {
    const c = store.create(project, mode);
    c.messages = [{ id: crypto.randomUUID(), role: 'user', text: question, status: 'done' }, { id: crypto.randomUUID(), role: 'assistant', text: answer, status }];
    c.draft = draft;
    const saved = store.save(c);
    const raw = JSON.parse(memory.get(`nodu.tutor.conversation.v1.${saved.id}`)!); raw.updatedAt = Date.now() - minutes * 60000;
    memory.set(`nodu.tutor.conversation.v1.${saved.id}`, JSON.stringify(raw));
    return store.read(saved.id, project, mode)!;
}
const first = sample('让 USART1 输出 READY。先说明初始化顺序，不修改工程。', '先确认 **系统时钟与 GPIO** 已配置，再初始化 USART1。\n\n1. 在系统时钟配置之后调用串口初始化。\n2. 检查返回值，再发送消息。\n\n```c\nconst char message[] = "READY\\r\\n";\nBoard_DebugWrite(message);\n```\n\n这只是代码说明，尚未验证编译或硬件输出。', 'teach', 3, '继续解释发送缓冲区的生命周期');
sample('定位 DMA 接收中断中的缓冲区越界', '已定位到读写索引的边界条件。', 'ask', 35);
sample('检查 STM32F407 时钟配置', '', 'ask', 120, '', 'failed');
sample('了解 GPIO 输入与上拉电阻', '请先确认按键的连接方式。', 'teach', 180, '', 'stopped');
sample('为温湿度采集与串口输出建立一个可复用的模块并保持代码结构简洁', '先明确采集周期，再拆分驱动与应用。', 'teach', 1440);
const archived = sample('分析 PWM 占空比与电机速度', '频率保持不变时，调整占空比。', 'ask', 2880); store.setArchived(archived.id, project, 'ask', true);
const context = store.create(project, 'ask'); context.contexts = [{ kind: 'file', path: 'Core/Inc/main.h', text: '#pragma once', version: 1, startLine: 1, endLine: 1 }]; store.save(context);
let current = first, redraw = () => {};
const persist = () => { current = store.save({ ...current, messages: tutor.messages[tutor.mode], draft: tutor.drafts[tutor.mode] }); };
const tutor: any = {
    workspaceId: project, rootUri: project, mode: 'teach', conversationSidebarOpen: true, historyOpen: false,
    goalState: { status: 'active', revision: 1 }, messages: { teach: first.messages, ask: [] }, drafts: { teach: first.draft, ask: '' }, pins: [],
    currentContextIncluded: false, includeCode: false, connectionState: 'connected', configured: true, canSendChat: false,
    settings: { providers: [{ id: 'local', name: '验收模型（不发送）', enabled: true, models: [{ id: 'glm-5.3', enabled: true }] }], selection: { providerId: 'local', modelId: 'glm-5.3' } },
    get activeConversationId() { return current.id; },
    get activeConversationTitle() { return conversationDisplayTitle({ ...current, messages: this.messages[this.mode], draft: this.drafts[this.mode] }); },
    get activeConversationArchived() { return !!current.archived; },
    get historyEntries() { return store.history(project).map(e => e.id === current.id && this.busy ? { ...e, status: 'pending' } : e); },
    notify() { redraw(); },
    setDraft(text: string) { this.drafts[this.mode] = text; persist(); redraw(); },
    showHistory(value: boolean) { this.historyOpen = value; redraw(); },
    setConversationSidebarOpen(value: boolean) { this.conversationSidebarOpen = value; this.historyOpen = false; redraw(); },
    conversationName(id: string, mode: 'teach' | 'ask') { const c = store.read(id, project, mode)!; return c.customTitle ?? conversationDisplayTitle(c); },
    renameConversation(id: string, mode: 'teach' | 'ask', title: string) { const c = store.rename(id, project, mode, title); if (current.id === id) current = c; redraw(); },
    setConversationArchived(id: string, mode: 'teach' | 'ask', archived: boolean) { const c = store.setArchived(id, project, mode, archived); if (current.id === id) current = c; redraw(); },
    async selectConversation(id: string, mode: 'teach' | 'ask') { persist(); current = store.read(id, project, mode)!; this.mode = mode; this.messages[mode] = current.messages; this.drafts[mode] = current.draft; this.historyOpen = false; redraw(); },
    async newConversation() { persist(); current = store.create(project, this.mode); this.messages[this.mode] = []; this.drafts[this.mode] = ''; redraw(); },
    setMode(mode: 'teach' | 'ask') { persist(); this.mode = mode; current = store.create(project, mode); this.messages[mode] = []; this.drafts[mode] = ''; redraw(); },
    async clearChat() { this.messages[this.mode] = []; persist(); redraw(); },
    canRetry: () => false, editMessage: () => false, removeContext() {}, cancel() { this.busy = undefined; redraw(); },
    send() { throw Error('This review never sends model requests'); },
};
function Review() {
    const params = new URLSearchParams(location.search);
    const [, refresh] = React.useState(0), [theme, setTheme] = React.useState<'light' | 'dark'>(params.get('theme') === 'dark' ? 'dark' : 'light'), [width, setWidth] = React.useState(params.get('width') === '460' ? 460 : 620);
    redraw = () => refresh(n => n + 1);
    React.useLayoutEffect(() => {
        document.body.className = `theia-${theme}`;
        for (const { id, defaults } of scopeColorDefaults()) document.documentElement.style.setProperty('--theia-' + id.replaceAll('.', '-'), defaults[theme]);
        for (const [key, value] of Object.entries(workbenchColors(theme))) document.documentElement.style.setProperty('--theia-' + key.replaceAll('.', '-'), value);
    }, [theme]);
    return <><nav aria-label="视觉验收场景"><strong>Nodu · 会话界面验收样例</strong><span>真实组件 / 隔离数据 / 不发送请求</span>
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '切换深色' : '切换浅色'}</button>
        <button onClick={() => setWidth(width === 620 ? 460 : 620)}>{width === 620 ? '窄面板 460' : '宽面板 620'}</button>
        <button onClick={() => { tutor.busy = tutor.busy ? undefined : { mode: tutor.mode, kind: 'chat' }; redraw(); }}>{tutor.busy ? '结束忙态样例' : '查看忙态样例'}</button>
    </nav><main className="review-stage"><div className="nodu-tutor-widget review-frame" style={{ width: tutor.conversationSidebarOpen ? width : width - 200 }}>
        <header className="review-titlebar"><span title={tutor.activeConversationTitle}>{tutor.activeConversationTitle}</span><ChatHeader tutor={tutor} clear={() => tutor.clearChat()}/></header>
        <TutorPanel tutor={tutor} run={() => {}}/>
    </div></main></>;
}
createRoot(document.getElementById('review')!).render(<Review/>);
