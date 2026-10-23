// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandService, MenuModelRegistry } from '@theia/core/lib/common';
import { CommonMenus, ReactWidget } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { NoduTutorModel } from './nodu-tutor-model';
import { TUTOR_COMMANDS } from './nodu-tutor-hints';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';

function MessageText({ text }: { text: string }): React.ReactElement {
    return <>{text.split(/(```[\s\S]*?```)/g).map((part, i) => part.startsWith('```')
        ? <pre key={i} tabIndex={0}><code>{part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code></pre>
        : <span key={i}>{part}</span>)}</>;
}
export function ProviderSettings({ tutor, close }: { tutor: NoduTutorModel; close(): void }): React.ReactElement {
    const [key, setKey] = React.useState('');
    const [model, setModel] = React.useState(tutor.provider?.model ?? 'glm-5.3');
    const [error, setError] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const save = async (): Promise<void> => {
        setSaving(true); setError('');
        try { await tutor.configure(key, model); setKey(''); close(); }
        catch { setError('GLM 配置未保存'); } finally { setSaving(false); }
    };
    return <form className="nodu-ai-settings" aria-label="AI 设置" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label>服务商<input value="GLM Coding Plan" readOnly /></label>
        <label>模型<select value={model} onChange={e => setModel(e.target.value)}>{['glm-5.3','glm-5.3-flash','glm-4.7','glm-4.6'].map(m => <option key={m}>{m}</option>)}</select></label>
        <label>API Key<input autoComplete="off" type="password" value={key} placeholder={tutor.provider?.configured ? '已配置' : ''} onChange={e => setKey(e.target.value)} /></label>
        {tutor.provider?.storage === 'session' && <div role="status">系统钥匙串不可用，仅本次会话有效</div>}
        <label className="nodu-ai-checkbox"><input type="checkbox" checked={tutor.autoReview} onChange={e => tutor.setDisplay('autoReview', e.target.checked)} />逐行 AI 检查（发送当前文件）</label>
        {error && <div className="scope-error" role="alert">{error}</div>}
        <div className="nodu-ai-actions"><button type="button" className="theia-button secondary" onClick={close}>取消</button><button className="theia-button" disabled={saving}>保存</button>
            {tutor.provider?.configured && <button type="button" className="scope-text-button" onClick={() => void tutor.forgetCredential().catch(() => setError('系统凭证未删除'))}>删除密钥</button>}</div>
    </form>;
}
function Migration({ tutor }: { tutor: NoduTutorModel }): React.ReactElement {
    const [mcu, setMcu] = React.useState(''); const [sdkId, setSdk] = React.useState(''); const [sdkDigest, setDigest] = React.useState(''); const [error, setError] = React.useState('');
    const run = async (accept: boolean): Promise<void> => { try { setError(''); if (accept) { await tutor.acceptMigration(); } else { await tutor.previewMigration({ mcu, sdkId, sdkDigest }); } } catch (e) { setError(e instanceof Error ? e.message : '迁移失败'); } };
    return <details className="nodu-ai-details"><summary>迁移旧课程</summary><div className="nodu-ai-settings">
        {!tutor.migration ? <><label>芯片<input value={mcu} onChange={e => setMcu(e.target.value)} /></label><label>SDK<input value={sdkId} onChange={e => setSdk(e.target.value)} /></label><label>SDK SHA-256<input value={sdkDigest} onChange={e => setDigest(e.target.value)} /></label><button className="theia-button secondary" onClick={() => void run(false)}>预览迁移</button></>
            : <><strong>{tutor.migration.course.title}</strong><p>{tutor.migration.course.target.mcu}</p><p>{tutor.migration.course.steps.length} 个步骤，旧完成记录转为自查。原计划会备份。</p><button className="theia-button" onClick={() => void run(true)}>确认迁移</button></>}
        {error && <div role="alert" className="scope-error">{error}</div>}
    </div></details>;
}
function TutorPanel({ tutor, run }: { tutor: NoduTutorModel; run(command: string, ...args: unknown[]): void }): React.ReactElement {
    const [, redraw] = React.useReducer(n => n + 1, 0);
    const log = React.useRef<HTMLDivElement>(null);
    const input = React.useRef<HTMLTextAreaElement>(null);
    const following = React.useRef(true);
    React.useEffect(() => { if (following.current) { log.current?.scrollTo(0, log.current.scrollHeight); } });
    React.useLayoutEffect(() => { const t = input.current; if (t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; } });
    const step = tutor.currentStep();
    const isBusy = !!tutor.busy;
    const canSend = !!tutor.workspaceId;
    const messages = tutor.messages[tutor.mode];
    const draft = tutor.drafts[tutor.mode];
    const ask = (text: string): void => { tutor.drafts[tutor.mode] = text; following.current = true; void tutor.send(); };
    const submit = (): void => { if (!isBusy && canSend && draft.trim()) { following.current = true; void tutor.send(); } };
    const suggestions = tutor.mode === 'teach' ? ['这一步要做什么？', '解释当前文件的结构'] : ['解释这段代码', '这个报错是什么意思？'];
    const done = tutor.plan?.steps.filter(s => tutor.progress.steps[s.id]).length ?? 0;
    const file = tutor.buffer?.path.split('/').pop();
    const reset = async (): Promise<void> => {
        if (await new ConfirmDialog({ title: '重置进度', msg: '清除本课程的学习记录？', ok: '重置', cancel: '取消' }).open()) { await tutor.action({ type: 'reset' }); }
    };
    return <div className="nodu-ai-panel">
        {tutor.error && <div className="nodu-ai-error" role="alert">{tutor.error}<button className="scope-text-button" onClick={() => void tutor.load()}>重连</button></div>}
        {tutor.mode === 'teach' && tutor.session?.plan.kind === 'legacy' && <Migration tutor={tutor} />}
        {tutor.mode === 'teach' && tutor.plan && <section className="nodu-ai-course" aria-label="课程步骤">
            <div className="nodu-ai-stepbar">
                <select aria-label="当前步骤" value={step?.id ?? ''} onChange={e => void tutor.action({ type: 'select', stepId: e.target.value })}>
                    {!step && <option value="">已自查全部步骤</option>}{tutor.plan.steps.map(s => <option key={s.id} value={s.id} disabled={!tutor.available(s.id)}>{s.title}{tutor.progress.steps[s.id] ? ' ✓' : ''}</option>)}
                </select>
                <span className="nodu-ai-progress" aria-label={`已完成 ${done} / ${tutor.plan.steps.length} 步`}>{done}/{tutor.plan.steps.length}</span>
                <button className="nodu-ai-chip" disabled={!step || isBusy || !tutor.buffer} onClick={() => void tutor.send('step')} title="检查本步 · ⌘/Ctrl+Alt+Enter"><i className="codicon codicon-check" aria-hidden="true"/>检查本步</button>
            </div>
            {step && <details className="nodu-ai-details"><summary>{step.goal}</summary><div className="nodu-ai-step-body">
                <p>{step.why}</p><ul>{step.requirements.map(r => <li key={r.id}>{r.text}</li>)}</ul>
                {step.options?.map(o => <button key={o.id} className="theia-button secondary" disabled={!o.available} onClick={() => void tutor.action({ type: 'decide', stepId: step.id, optionId: o.id })}>{o.label}</button>)}
                {step.guidance?.map(g => <pre key={g.id} tabIndex={0}>{g.lines.join('\n')}</pre>)}
                <div className="nodu-ai-actions">
                    <button className="scope-text-button" onClick={() => run(TUTOR_COMMANDS.revealStep)}>定位代码</button>
                    {step.kind !== 'decide' && <button className="scope-text-button" onClick={() => void tutor.action({ type: tutor.progress.steps[step.id] ? 'reopen' : 'manualCheck', stepId: step.id })}>{tutor.progress.steps[step.id] ? '重新练习' : '自查完成'}</button>}
                    <button className="scope-text-button" onClick={() => void reset()}>重置进度</button>
                </div>
            </div></details>}
            {tutor.paused && <div className="nodu-ai-note" role="status">编辑指导已关闭<button className="scope-text-button" onClick={() => tutor.setPaused(false)}>开启</button></div>}
        </section>}
        <div className="nodu-ai-log" ref={log} role="log" aria-label="AI 对话" onScroll={() => { const n = log.current; following.current = !n || n.scrollHeight - n.scrollTop - n.clientHeight < 32; }}>
            {!messages.length && <div className="nodu-ai-empty">
                <i className="codicon codicon-sparkle" aria-hidden="true"/>
                <span>{tutor.mode === 'teach' ? '从当前代码开始' : '提问代码问题'}</span>
                <div className="nodu-ai-suggestions">{suggestions.map(s => <button key={s} className="nodu-ai-suggestion" disabled={!canSend || isBusy} onClick={() => ask(s)}>{s}</button>)}</div>
            </div>}
            {messages.map(m => <article key={m.id} className={`nodu-ai-message nodu-ai-${m.role}`} aria-label={m.role === 'user' ? '你' : 'AI'} aria-busy={m.status === 'pending'}>
                {m.role === 'assistant' && <div className="nodu-ai-author"><i className="codicon codicon-sparkle" aria-hidden="true"/>AI</div>}
                <div className="nodu-ai-body">
                    {m.text ? <MessageText text={m.text} /> : m.status === 'pending' && <span className="nodu-ai-status">正在思考…</span>}
                    {m.status === 'stopped' && <div className="nodu-ai-status">已停止</div>}
                    {m.status === 'failed' && <div className="nodu-ai-failed" role="alert">{m.note ?? 'AI 请求失败'}</div>}
                </div>
                {m.role === 'assistant' && m.status === 'done' && !!m.text && <div className="nodu-ai-message-actions">
                    <button className="nodu-ai-icon" aria-label="复制回答" title="复制" onClick={() => void navigator.clipboard?.writeText(m.text).catch(() => undefined)}><i className="codicon codicon-copy" aria-hidden="true"/></button>
                </div>}
            </article>)}
        </div>
        <form className="nodu-ai-composer" onSubmit={e => { e.preventDefault(); submit(); }}>
            {tutor.buffer && <div className="nodu-ai-context-row">
                <button type="button" className={`nodu-ai-pill${tutor.includeCode ? '' : ' nodu-ai-pill-off'}`} aria-pressed={tutor.includeCode}
                    title={tutor.includeCode ? `发送时附带 ${tutor.buffer.path}，点击移除` : `点击附带 ${tutor.buffer.path}`}
                    onClick={() => { tutor.includeCode = !tutor.includeCode; redraw(); }}>
                    <i className="codicon codicon-file-code" aria-hidden="true"/><span>{file}</span><i className={`codicon codicon-${tutor.includeCode ? 'close' : 'add'}`} aria-hidden="true"/>
                </button>
            </div>}
            <textarea ref={input} rows={1} aria-label={tutor.mode === 'teach' ? '教学消息' : '提问消息'} placeholder={tutor.mode === 'teach' ? '问问这一步怎么写…' : '想了解什么？'} value={draft}
                onChange={e => { tutor.drafts[tutor.mode] = e.target.value; redraw(); }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
            <div className="nodu-ai-composer-bar">
                <button type="button" className="nodu-ai-model" title="模型与密钥" onClick={e => run(TUTOR_COMMANDS.settings, e.currentTarget)}>{tutor.provider?.model ?? 'GLM'}<i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
                {tutor.provider && !tutor.provider.configured && <button type="button" className="nodu-ai-warn" onClick={e => run(TUTOR_COMMANDS.settings, e.currentTarget)}>配置密钥</button>}
                {isBusy
                    ? <button type="button" className="nodu-ai-send nodu-ai-stop" aria-label="停止" title="停止" onClick={() => tutor.cancel()}><i className="codicon codicon-debug-stop" aria-hidden="true"/></button>
                    : <button className="nodu-ai-send" aria-label="发送" title="发送 · Enter" disabled={!canSend || !draft.trim()}><i className="codicon codicon-arrow-up" aria-hidden="true"/></button>}
            </div>
        </form>
    </div>;
}
@injectable()
export class NoduTutorWidget extends ReactWidget {
    static readonly ID = 'nodu:tutor'; static readonly LABEL = 'AI';
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @postConstruct() protected init(): void {
        this.id = NoduTutorWidget.ID; this.title.label = 'AI'; this.title.caption = 'AI'; this.title.iconClass = 'codicon codicon-sparkle'; this.title.closable = true;
        this.addClass('scope-widget'); this.addClass('nodu-tutor-widget'); this.node.tabIndex = -1;
        this.toDispose.push(this.tutor.onDidChange(() => this.update()));
        this.toDispose.push(this.onDidChangeVisibility(visible => this.tutor.setPanelVisible(visible))); this.update();
    }
    /** Closing the sidebar is remembered; professional mode reopens it only while preferred. */
    protected override onCloseRequest(msg: Message): void { this.tutor.setPanelPreferred(false); super.onCloseRequest(msg); }
    protected onActivateRequest(): void { this.node.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }
    protected render(): React.ReactNode { return <TutorPanel tutor={this.tutor} run={(id, ...args) => void this.commands.executeCommand(id, ...args)} />; }
}
@injectable()
export class NoduTutorViewContribution extends AbstractViewContribution<NoduTutorWidget> {
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    constructor() { super({ widgetId: NoduTutorWidget.ID, widgetName: 'AI', defaultWidgetOptions: { area: 'right', rank: 50 } }); }
    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        const available = { isEnabled: () => this.tutor.enabled, isVisible: () => this.tutor.enabled };
        commands.registerCommand({ id: TUTOR_COMMANDS.openPanel, label: 'AI', category: 'Nodu' }, { execute: async () => { await this.openView({ reveal: true, activate: true }); this.tutor.setPanelPreferred(true); }, ...available });
        commands.registerCommand({ id: TUTOR_COMMANDS.togglePanel, label: 'AI 对话', category: 'Nodu' }, { execute: async () => { await this.openView({ toggle: true, activate: true }); this.tutor.setPanelPreferred(!!this.tryGetWidget()?.isVisible); }, ...available });
    }
    override registerMenus(menus: MenuModelRegistry): void { menus.registerMenuAction(CommonMenus.VIEW_LAYOUT, { commandId: TUTOR_COMMANDS.togglePanel, order: '0_nodu_5' }); }
}

/** Mode switch and new chat sit in the side panel title row, so the AI view has one header line. */
@injectable()
export class NoduTutorToolbarContribution implements TabBarToolbarContribution {
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        registry.registerItem({
            id: 'nodu.tutor.header', isVisible: widget => widget instanceof NoduTutorWidget, onDidChange: this.tutor.onDidChange,
            render: widget => widget instanceof NoduTutorWidget ? <div key="nodu-tutor-header" className="nodu-ai-titlebar">
                <div className="nodu-ai-modes" role="group" aria-label="对话模式">
                    {(['teach', 'ask'] as const).map(m => <button key={m} type="button" aria-pressed={this.tutor.mode === m} onClick={() => this.tutor.setMode(m)}>{m === 'teach' ? '教学' : '提问'}</button>)}
                </div>
                <button type="button" className="nodu-ai-icon" aria-label="新对话" title="新对话" disabled={!this.tutor.messages[this.tutor.mode].length} onClick={() => void this.tutor.clearChat()}><i className="codicon codicon-add" aria-hidden="true"/></button>
            </div> : null,
        });
    }
}
