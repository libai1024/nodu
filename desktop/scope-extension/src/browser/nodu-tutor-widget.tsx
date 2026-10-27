// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandService, MenuModelRegistry } from '@theia/core/lib/common';
import { ApplicationShell, CommonMenus, ReactWidget } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { NoduTutorModel } from './nodu-tutor-model';
import { TUTOR_COMMANDS } from './nodu-tutor-hints';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { TutorMessage } from './nodu-tutor-messages';
import { ModePicker, ModelPicker, ChatHeader } from './nodu-tutor-chat-controls';
import { ContextPicker } from './nodu-tutor-context-picker';
import { ConversationSidebar } from './nodu-tutor-history';
import { NoduTutorContextTransfer } from './nodu-tutor-context-transfer';

/** Plans are confirmed here; an accepted task is managed only by the shared task window. */
function GoalPlan({ tutor, revise }: { tutor: NoduTutorModel; revise(): void }): React.ReactElement | null {
    const state = tutor.goalState, busy = !!tutor.busy;
    if (state.status !== 'draft') { return null; }
    return <section className="nodu-ai-course nodu-ai-draft-plan" aria-label="确认教学计划">
        <div className="nodu-ai-stepbar"><span className="nodu-ai-goal-title">{state.title}</span></div>
        <ol className="nodu-ai-goal-steps">{state.steps.map(s => <li key={s.id}>{s.title}</li>)}</ol>
        <div className="nodu-ai-actions"><button className="theia-button" disabled={busy} onClick={() => void tutor.goalAction('confirm')}>开始跟写</button>
            <button className="scope-text-button" disabled={busy} onClick={revise}>修改目标</button>
            <button className="scope-text-button" disabled={busy} onClick={() => void tutor.goalAction('cancel')}>取消</button></div>
    </section>;
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
interface ChatViewState { top: number; following: boolean }
const chatViews = new WeakMap<NoduTutorModel, Map<string, ChatViewState>>();
export function TutorPanel({ tutor, run, transfer }: { tutor: NoduTutorModel; run(command: string, ...args: unknown[]): Promise<unknown> | void; transfer?: NoduTutorContextTransfer }): React.ReactElement {
    const [, redraw] = React.useReducer(n => n + 1, 0);
    const [dragging, setDragging] = React.useState(false);
    const log = React.useRef<HTMLDivElement>(null), input = React.useRef<HTMLTextAreaElement>(null);
    const following = React.useRef(true), scrollIntent = React.useRef(0);
    const [latest, setLatest] = React.useState(false), [errorDetail, setErrorDetail] = React.useState(false);
    const key = `${tutor.rootUri ?? tutor.workspaceId ?? ''}:${tutor.mode}:${tutor.activeConversationId ?? ''}`;
    const views = chatViews.get(tutor) ?? new Map<string, ChatViewState>(); chatViews.set(tutor, views);
    const messages = tutor.messages[tutor.mode], last = messages.at(-1), draft = tutor.drafts[tutor.mode];
    React.useLayoutEffect(() => {
        const node = log.current, saved = views.get(key);
        following.current = saved?.following ?? true; scrollIntent.current = 0; setLatest(!following.current); setErrorDetail(false);
        if (node) { node.scrollTop = following.current ? node.scrollHeight : saved?.top ?? 0; }
        return () => { if (node) { views.set(key, { top: node.scrollTop, following: following.current }); if (views.size > 64) { views.delete(views.keys().next().value!); } } };
    }, [key]);
    React.useLayoutEffect(() => {
        if (following.current && log.current) { log.current.scrollTop = log.current.scrollHeight; }
        else if (messages.length) { setLatest(true); }
    }, [key, messages.length, last?.text, last?.status, tutor.goalState.revision]);
    React.useLayoutEffect(() => { const node = input.current; if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 180)}px`; } }, [draft]);
    React.useLayoutEffect(() => {
        const node = input.current;
        if (!node || typeof ResizeObserver === 'undefined') { return; }
        let width = node.clientWidth;
        const observer = new ResizeObserver(() => {
            if (node.clientWidth === width) { return; }
            width = node.clientWidth; node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
        });
        observer.observe(node); return () => observer.disconnect();
    }, []);
    const isBusy = !!tutor.busy, canSend = tutor.canSendChat ?? !!tutor.workspaceId;
    const bottom = (): void => { following.current = true; setLatest(false); if (log.current) { log.current.scrollTop = log.current.scrollHeight; } };
    const submit = (): void => { if (!isBusy && canSend && draft.trim()) { bottom(); void tutor.send(); } };
    const lastReply = [...messages].reverse().find(m => m.role === 'assistant');
    const duplicateError = lastReply?.status === 'failed' && tutor.error === lastReply.note;
    return <div className={`nodu-ai-workspace${tutor.conversationSidebarOpen ? ' nodu-ai-workspace-with-sidebar' : ''}`}><div className="nodu-ai-panel">
        <div className="nodu-ai-reading">
            <div className="nodu-ai-log" ref={log} role="log" aria-label="AI 对话" aria-live="off" tabIndex={0}
                onWheel={() => { scrollIntent.current = Date.now() + 250; }} onTouchStart={() => { scrollIntent.current = Date.now() + 250; }} onPointerDown={e => { if (e.target === e.currentTarget) { scrollIntent.current = Date.now() + 250; } }}
                onKeyDown={e => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) { scrollIntent.current = Date.now() + 250; } }}
                onScroll={() => { const n = log.current; if (n) { if (Date.now() < scrollIntent.current) { following.current = n.scrollHeight - n.scrollTop - n.clientHeight < 32; setLatest(!following.current); } views.set(key, { top: n.scrollTop, following: following.current }); } }}>
                {messages.map(m => <TutorMessage key={m.id} item={m} busy={isBusy}
                    snapshot={m.role === 'user' ? m.request ?? messages.find(reply => reply.replyTo === m.id)?.request : undefined}
                    open={async (path, line) => { if (await run(TUTOR_COMMANDS.openReference, path, line) === false) { throw new Error('无法打开此文件'); } }}
                    retry={tutor.canRetry?.(m) ? () => tutor.retryChat(m.id) : undefined}
                    onReask={m.role === 'user' ? () => { if (tutor.editMessage(m.id)) { input.current?.focus(); } } : undefined} />)}
                {tutor.mode === 'teach' && <GoalPlan tutor={tutor} revise={() => { tutor.setDraft(tutor.goalState.goal ?? ''); input.current?.focus(); }} />}
                {tutor.mode === 'teach' && tutor.session?.plan.kind === 'legacy' && <Migration tutor={tutor} />}
                {tutor.busy?.goal && <div className="nodu-ai-status nodu-ai-request-status" role="status"><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"/>{tutor.busy.goal === 'propose' ? '正在制定计划…' : tutor.busy.goal === 'fragment' ? '准备代码片段…' : tutor.busy.goal === 'check' ? '正在检查片段…' : '正在更新…'}</div>}
            </div>
            {latest && messages.length > 0 && <button type="button" className="nodu-ai-latest" onClick={bottom}><i className="codicon codicon-arrow-down" aria-hidden="true"/>最新回复</button>}
        </div>
        {tutor.connectionState === 'connecting' ? <div className="nodu-ai-connection" role="status"><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"/>正在重新连接…</div>
            : tutor.connectionState === 'disconnected' ? <div className="nodu-ai-connection" role="status">连接已断开<button type="button" className="scope-text-button" onClick={() => void tutor.load()}>重连</button></div>
            : tutor.error && !duplicateError && <div className="nodu-ai-connection" role="status"><span>{tutor.error.length <= 120 ? tutor.error : '请求未完成，请查看详情'}</span><button type="button" className="nodu-ai-icon" aria-label="查看请求详情" hidden={tutor.error.length <= 120} aria-expanded={errorDetail} onClick={() => setErrorDetail(!errorDetail)}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>{errorDetail && <span className="nodu-ai-error-detail">{tutor.error}</span>}</div>}
        {tutor.historyStorageError && <div className="nodu-ai-connection" role="status"><span>{tutor.historyStorageError}</span><button type="button" className="scope-text-button" onClick={() => tutor.retryHistorySave()}>重试保存</button></div>}
        {tutor.activeConversationArchived && <div className="nodu-ai-connection" role="status"><i className="codicon codicon-archive" aria-hidden="true"/><span>此对话已归档</span><button type="button" className="scope-text-button" disabled={isBusy || tutor.conversationLoading} onClick={() => {
            try { tutor.setConversationArchived(tutor.activeConversationId!, tutor.mode, false); } catch (error) { tutor.error = error instanceof Error ? error.message : '恢复对话失败'; tutor.notify(); }
        }}>恢复对话</button></div>}
        <form className={`nodu-ai-composer${dragging ? ' nodu-ai-composer-dragging' : ''}`} aria-busy={tutor.contextLoading || undefined} onSubmit={e => { e.preventDefault(); submit(); }}
            onDragOver={e => { if (transfer?.acceptsDrop(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDragging(false); } }}
            onDrop={e => { setDragging(false); if (transfer?.drop(e.nativeEvent, tutor)) { input.current?.focus(); } }}>
            <ContextPicker tutor={tutor} open={async (path, line) => { if (await run(TUTOR_COMMANDS.openReference, path, line) === false) { throw new Error('无法打开此文件'); } }}>{addButton => <>
            <textarea ref={input} rows={1} aria-label={tutor.mode === 'teach' ? '教学消息' : '提问消息'} value={draft}
                onPaste={e => transfer?.paste(e.nativeEvent, tutor)}
                onChange={e => { tutor.setDraft(e.target.value); redraw(); }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } }} />
            <div className="nodu-ai-composer-bar">
                <ModePicker tutor={tutor} />
                <ModelPicker tutor={tutor} openSettings={anchor => run(TUTOR_COMMANDS.settings, anchor)} />
                {addButton}
                {isBusy
                    ? <button key="stop" type="button" className="nodu-ai-send nodu-ai-stop" aria-label="停止" title="停止" onClick={e => { e.preventDefault(); tutor.cancel(); }}><i className="codicon codicon-debug-stop" aria-hidden="true"/></button>
                    : <button key="send" type="button" onClick={submit} className="nodu-ai-send" aria-label="发送" title="发送 Enter" disabled={!canSend || !draft.trim()}><i className="codicon codicon-arrow-up" aria-hidden="true"/></button>}
            </div>
            </>}</ContextPicker>
        </form>
    </div>{tutor.conversationSidebarOpen && <ConversationSidebar tutor={tutor} selected={() => input.current?.focus()}/>}</div>;
}
@injectable()
export class NoduTutorWidget extends ReactWidget {
    static readonly ID = 'nodu:tutor'; static readonly LABEL = 'AI 对话';
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(NoduTutorContextTransfer) protected readonly contextTransfer!: NoduTutorContextTransfer;
    private renderedSidebarOpen?: boolean;
    private collapsedConversationPanelSize?: number;
    private conversationPanelResize?: Promise<void>;
    @postConstruct() protected init(): void {
        this.id = NoduTutorWidget.ID; this.title.label = NoduTutorWidget.LABEL; this.title.caption = NoduTutorWidget.LABEL; this.title.iconClass = 'codicon codicon-sparkle'; this.title.closable = true;
        this.addClass('scope-widget'); this.addClass('nodu-tutor-widget'); this.node.tabIndex = -1;
        this.toDispose.push(this.tutor.onDidChange(() => { this.title.label = this.tutor.activeConversationTitle; this.title.caption = this.title.label; this.syncConversationSidebarLayout(); this.update(); }));
        this.toDispose.push(this.onDidChangeVisibility(visible => this.tutor.setPanelVisible(visible))); this.syncConversationSidebarLayout(); this.update();
    }
    /** Add space for the list instead of taking it from the existing composer. */
    protected syncConversationSidebarLayout(): void {
        const open = this.tutor.conversationSidebarOpen, previousOpen = this.renderedSidebarOpen, initial = previousOpen === undefined, changed = !initial && previousOpen !== open;
        const width = this.node.getBoundingClientRect().width;
        this.renderedSidebarOpen = open;
        if (initial || changed) { this.toggleClass('nodu-tutor-with-conversations', open); this.fit(); }
        if (!this.isVisible || this.shell.getAreaFor(this) !== 'right' || width <= 0) { return; }
        const right = this.shell.rightPanelHandler, minimum = open ? 460 : 260;
        if (!changed && (this.conversationPanelResize || width >= minimum)) { return; }
        const size = right.getLayoutData().size ?? width;
        // Animated intermediate widths must not replace the last stable chat width.
        // Once the animation ends, measuring again also respects a manual resize.
        const collapsed = this.conversationPanelResize && this.collapsedConversationPanelSize !== undefined
            ? this.collapsedConversationPanelSize : size - ((previousOpen ?? open) ? 200 : 0);
        this.collapsedConversationPanelSize = Math.max(collapsed, size + 260 - width);
        right.resize(this.collapsedConversationPanelSize + (open ? 200 : 0));
        const pending = this.conversationPanelResize = right.state.pendingUpdate;
        void pending.then(() => { if (this.conversationPanelResize === pending) { this.conversationPanelResize = undefined; } });
    }
    /** Closing the sidebar is remembered; professional mode reopens it only while preferred. */
    protected override onCloseRequest(msg: Message): void { this.tutor.setPanelPreferred(false); super.onCloseRequest(msg); }
    protected onActivateRequest(): void { this.node.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }
    protected render(): React.ReactNode { return <TutorPanel tutor={this.tutor} transfer={this.contextTransfer} run={(id, ...args) => this.commands.executeCommand(id, ...args)} />; }
}
@injectable()
export class NoduTutorViewContribution extends AbstractViewContribution<NoduTutorWidget> {
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    constructor() { super({ widgetId: NoduTutorWidget.ID, widgetName: NoduTutorWidget.LABEL, defaultWidgetOptions: { area: 'right', rank: 50 } }); }
    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        const available = { isEnabled: () => this.tutor.enabled, isVisible: () => this.tutor.enabled };
        commands.registerCommand({ id: TUTOR_COMMANDS.openPanel, label: 'AI', category: 'Nodu' }, { execute: async () => { await this.openView({ reveal: true, activate: true }); this.tutor.setPanelPreferred(true); }, ...available });
        commands.registerCommand({ id: TUTOR_COMMANDS.togglePanel, label: 'AI 对话', category: 'Nodu' }, { execute: async () => { await this.openView({ toggle: true, activate: true }); this.tutor.setPanelPreferred(!!this.tryGetWidget()?.isVisible); }, ...available });
    }
    override registerMenus(menus: MenuModelRegistry): void { menus.registerMenuAction(CommonMenus.VIEW_LAYOUT, { commandId: TUTOR_COMMANDS.togglePanel, order: '0_nodu_5' }); }
}

/** New chat sits in the side panel title row, so the AI view has one header line; the mode switch lives in the composer. */
@injectable()
export class NoduTutorToolbarContribution implements TabBarToolbarContribution {
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        registry.registerItem({
            id: 'nodu.tutor.header', isVisible: widget => widget instanceof NoduTutorWidget, onDidChange: this.tutor.onDidChange,
            render: widget => widget instanceof NoduTutorWidget ? <ChatHeader key="nodu-tutor-header" tutor={this.tutor} focusComposer={() => widget.activate()} clear={async () => {
                if (await new ConfirmDialog({ title: '清空当前对话', msg: '清除此对话的消息？教学任务和工程代码会保留。', ok: '清空', cancel: '取消' }).open()) { await this.tutor.clearChat(); }
            }} /> : null,
        });
    }
}
