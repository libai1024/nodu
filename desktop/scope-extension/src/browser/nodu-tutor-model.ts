// SPDX-License-Identifier: MIT
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { DisposableCollection, Emitter } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import type { TerminalWidgetImpl } from '@theia/terminal/lib/browser/terminal-widget-impl';
import { TutorAIClient, TutorAIResult, TutorAnswer, TutorBuffer, TutorChatRequest, TutorMode, TutorModelTest, TutorRemoteModel, TutorService, TUTOR_SERVICE_PATH } from '../common/tutor/tutor-ai-protocol';
import { TutorAISettingsView, TutorModelSelection, TutorProviderConfig, TutorProviderView, allowsNoKey } from '../common/tutor/tutor-ai-config';
import { TutorCourseTarget, TutorCourseV2 } from '../common/tutor/tutor-course';
import { TutorLearningAction, emptyLearningProgress } from '../common/tutor/tutor-learning-state';
import { CourseMigrationPreview, TutorSessionSnapshot, TutorStorageOutcome } from '../common/tutor/tutor-storage-protocol';
import { guidanceEditMatches } from '../common/tutor/tutor-guidance';
import { emptyGoal, TutorGoalRequest, TutorGoalState } from '../common/tutor/tutor-goal';
import { TutorLocalRule } from '../common/tutor/tutor-local-check';
import { TutorLineHistoryCache } from '../common/tutor/tutor-line-history';
import { TutorContext, validateTutorContexts, requestBuffer } from '../common/tutor/tutor-context';
import { TutorChatItem, TutorChatSnapshot, TutorConversation, TutorConversationStore, TutorHistoryEntry, conversationDisplayTitle, conversationPrompt, chatContextRefs, redactChatSecrets } from '../common/tutor/tutor-conversation';
export type { TutorChatItem, TutorChatStatus } from '../common/tutor/tutor-conversation';
import { ScopeLayoutState } from './scope-layout-state';

export interface TutorPresentation { buffer: TutorBuffer; answer: TutorAnswer; }
/** file: URIs from the host and from Theia may differ in encoding and trailing slashes. */
const sameUri = (a: string, b: URI | undefined): boolean => !!b && new URI(a).path.toString().replace(/\/+$/, '') === b.path.toString().replace(/\/+$/, '');
const stored = (key: string, fallback: boolean): boolean => { try { const v = localStorage.getItem(`nodu.tutor.${key}`); return v === null ? fallback : v === 'true'; } catch { return fallback; } };
const storedMode = (): TutorMode => { try { return sessionStorage.getItem('nodu.tutor.mode') === 'ask' ? 'ask' : 'teach'; } catch { return 'teach'; } };
/** Reloads keep this window's writer identity; other windows still fork foreign records. */
const conversationOwner = (): ReturnType<typeof crypto.randomUUID> => {
    const key = 'nodu.tutor.conversation.owner';
    try {
        const previous = sessionStorage.getItem(key);
        if (previous && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previous)) { return previous as ReturnType<typeof crypto.randomUUID>; }
        const owner = crypto.randomUUID(); sessionStorage.setItem(key, owner); return owner;
    } catch { return crypto.randomUUID(); }
};

@injectable()
export class NoduTutorModel {
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(TerminalService) protected readonly terminals!: TerminalService;
    @inject(WebSocketConnectionProvider) protected readonly connections!: WebSocketConnectionProvider;
    @inject(ScopeLayoutState) protected readonly layout!: ScopeLayoutState;
    private service!: TutorService;
    private readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly fragmentRequested = new Emitter<void>();
    readonly onDidRequestGoalFragment = this.fragmentRequested.event;
    private readonly invalidated = new Emitter<void>();
    readonly onDidInvalidate = this.invalidated.event;
    private readonly toDispose = new DisposableCollection(this.changed, this.invalidated, this.fragmentRequested);
    ready: Promise<void> = Promise.resolve();
    rootUri?: URI;
    workspaceId?: string;
    session?: TutorSessionSnapshot;
    error?: string;
    mode: TutorMode = storedMode();
    historyOpen = false;
    /** Global layout preference, independent of the selected project or conversation. */
    conversationSidebarOpen = stored('conversation-sidebar', false);
    /** Editor guidance (ghost text, highlights, line review) is off; chat stays available. */
    paused = stored('guidance-off', false);
    panelVisible = false;
    /** Professional mode opens the AI sidebar on the right unless the user closed it. */
    panelPreferred = stored('panel', true);
    epoch = 0;
    hintsVisible = stored('ghost', true);
    highlightsVisible = stored('highlight', true);
    annotationsVisible = stored('annotations', true);
    floatVisible = stored('float', true);
    autoReview = stored('auto-review', true);
    private readonly includedCode: Record<TutorMode, boolean> = { teach: true, ask: true };
    get includeCode(): boolean { return this.includedCode[this.mode]; }
    set includeCode(value: boolean) { this.includedCode[this.mode] = value; }
    buffer?: TutorBuffer;
    presentation?: TutorPresentation;
    guidance?: { source: TutorBuffer; anchorLine: number; lines: string[] };
    goalState: TutorGoalState = emptyGoal();
    readonly lineHistory = new TutorLineHistoryCache((() => { try { return localStorage; } catch { return undefined; } })());
    /** Providers, key presence and this window's model; never the keys themselves. */
    settings?: TutorAISettingsView;
    /** Conversation lane: chat and step checks, owned by the composer. */
    busy?: { id: string; mode: TutorMode; kind: TutorChatRequest['kind']; goal?: TutorGoalRequest['action'] };
    private lastAutoFragment = '';
    /** Line-review lane, independent of the composer so asking never waits for the editor. */
    reviewing?: { id: string };
    readonly drafts: Record<TutorMode, string> = { teach: '', ask: '' };
    readonly messages: Record<TutorMode, TutorChatItem[]> = { teach: [], ask: [] };
    migration?: CourseMigrationPreview;
    connectionState: 'connecting' | 'connected' | 'disconnected' = 'connecting';
    private conversationProject?: string;
    private settledRootUri?: URI;
    private reconnectBuffer?: TutorBuffer;
    private persistenceError?: string;
    private readonly conversationStore = new TutorConversationStore((() => { try { return localStorage; } catch { return undefined; } })(), conversationOwner());
    private conversationRecords: Partial<Record<TutorMode, TutorConversation>> = {};
    private draftSave?: ReturnType<typeof setTimeout>;
    private historySyncing = false;
    private readonly contextDrafts: Record<TutorMode, TutorContext[]> = { teach: [], ask: [] };
    contextError?: string;
    get pins(): readonly TutorContext[] { return this.contextDrafts[this.mode]; }
    get currentContextIncluded(): boolean { return this.includeCode && !!this.buffer && !this.pins.some(p => p.path === this.buffer!.path); }
    get historyStorageError(): string | undefined { return this.persistenceError ?? this.conversationStore.storageError; }
    retryHistorySave(): void { this.conversationStore.flush(); this.persistConversation('teach'); this.persistConversation('ask'); this.notify(); }
    get conversationLoading(): boolean { return this.historySyncing; }
    get conversations() { return this.conversationProject ? this.conversationStore.list(this.conversationProject, this.mode) : []; }
    get activeConversationId(): string | undefined { return this.conversationRecords[this.mode]?.id; }
    get activeConversationTitle(): string {
        const record = this.conversationRecords[this.mode];
        return record ? conversationDisplayTitle({ ...record, messages: this.messages[this.mode], draft: this.drafts[this.mode], contexts: [...this.pins] }) : '新对话';
    }
    get activeConversationArchived(): boolean { return !!this.conversationRecords[this.mode]?.archived; }
    get canManageActiveConversation(): boolean {
        return !!this.activeConversationId && (!!this.messages[this.mode].length || !!this.drafts[this.mode].trim() || !!this.pins.length
            || !!this.historyEntries.find(entry => entry.id === this.activeConversationId && entry.mode === this.mode));
    }
    conversationName(id: string, mode: TutorMode): string {
        const record = this.conversationProject && this.conversationStore.read(id, this.conversationProject, mode);
        return record ? record.customTitle ?? conversationDisplayTitle(record) : this.activeConversationTitle;
    }
    get historyEntries(): TutorHistoryEntry[] {
        const entries = this.conversationProject ? this.conversationStore.history(this.conversationProject) : [];
        return entries.map(entry => entry.id === this.activeConversationId && entry.mode === this.mode
            ? { ...entry, title: this.activeConversationTitle, status: this.busy ? 'pending' : [...this.messages[this.mode]].reverse().find(m => m.role === 'assistant')?.status } : entry);
    }
    renameConversation(id: string, mode: TutorMode, title: string): void {
        this.updateConversationMetadata(id, mode, () => this.conversationStore.rename(id, this.conversationProject!, mode, title));
    }
    setConversationArchived(id: string, mode: TutorMode, archived: boolean): void {
        this.updateConversationMetadata(id, mode, () => this.conversationStore.setArchived(id, this.conversationProject!, mode, archived));
    }
    private updateConversationMetadata(id: string, mode: TutorMode, update: () => TutorConversation): void {
        if (!this.conversationProject || this.busy || this.historySyncing) { throw new Error('请等待当前对话完成后再操作'); }
        const record = this.conversationRecords[mode];
        if (record?.id === id) {
            this.persistConversation(mode);
            if (this.historyStorageError) { this.notify(); throw new Error(this.historyStorageError); }
        }
        const current = this.conversationRecords[mode];
        if (record?.id === id && current?.id !== id) { throw new Error('对话已另存，请重新选择后操作'); }
        const saved = update();
        if (current?.id === id) { this.conversationRecords[mode] = { ...current, customTitle: saved.customTitle, title: saved.title, archived: saved.archived }; }
        this.persistenceError = undefined; this.notify();
        if (this.historyStorageError) { throw new Error(this.historyStorageError); }
    }
    showHistory(show: boolean): void { this.historyOpen = show; this.notify(); }
    setConversationSidebarOpen(show: boolean): void {
        this.conversationSidebarOpen = show; this.historyOpen = false;
        try { localStorage.setItem('nodu.tutor.conversation-sidebar', String(show)); } catch { /* Layout remains usable without storage. */ }
        this.notify();
    }
    private readonly pendingContexts = new Map<string, number>();
    private contextIdentity(): string { return JSON.stringify([this.workspaceId, this.mode, this.epoch, this.activeConversationId]); }
    get contextLoading(): boolean { return !!this.pendingContexts.get(this.contextIdentity()); }
    beginContextTransfer(): () => void {
        const identity = this.contextIdentity();
        this.pendingContexts.set(identity, (this.pendingContexts.get(identity) ?? 0) + 1); this.notify();
        let finished = false;
        return () => {
            if (finished) { return; }
            finished = true;
            const pending = (this.pendingContexts.get(identity) ?? 1) - 1;
            if (pending) { this.pendingContexts.set(identity, pending); } else { this.pendingContexts.delete(identity); }
            this.notify();
        };
    }
    get canSendChat(): boolean { return this.enabled && !!this.workspaceId && this.connectionState === 'connected' && !this.historySyncing && !this.contextLoading && !this.busy; }
    private loading = 0;
    private refreshing = 0;
    private sync: Promise<void> = Promise.resolve();
    private sessionQueue: Promise<void> = Promise.resolve();
    get plan(): TutorCourseV2 | undefined { return this.session?.plan.kind === 'course' ? this.session.plan.course : undefined; }
    get progress() { return this.session?.learning?.snapshot.progress ?? emptyLearningProgress(); }
    /** 简洁模式不提供 AI：侧栏、虚影、逐行检查和模型请求只在专业模式可用。 */
    get enabled(): boolean { return this.layout.mode === 'pro'; }
    get teaching(): boolean { return this.enabled && this.mode === 'teach' && !this.paused; }
    currentStep() {
        return this.plan?.steps.find(s => s.id === this.progress.current) ?? this.plan?.steps.find(s => !this.progress.steps[s.id] && this.available(s.id));
    }
    available(id: string): boolean { return !!this.plan?.steps.find(s => s.id === id)?.dependsOn.every(d => d.mode === 'advisory' || !!this.progress.steps[d.stepId]); }
    @postConstruct()
    protected init(): void {
        const proxy = this.connections.createProxy<TutorService>(TUTOR_SERVICE_PATH, { onDidChange: event => this.onStorageChange(event), onChatDelta: event => this.onChatDelta(event),
            onWorkspacesChanged: () => { void this.onWorkspacesChanged(); }, onAISettingsChanged: () => { void this.refreshSettings(); },
            onGoalsChanged: () => { void this.refreshGoal(); } } satisfies TutorAIClient);
        this.service = proxy;
        if (typeof window !== 'undefined') {
            const flush = (): void => { this.persistConversation('teach'); this.persistConversation('ask'); };
            window.addEventListener('pagehide', flush);
            this.toDispose.push({ dispose: () => window.removeEventListener('pagehide', flush) });
        }
        this.toDispose.push(proxy.onDidOpenConnection(() => { void this.workspace.ready.then(() => this.load()); }));
        this.toDispose.push(proxy.onDidCloseConnection(() => {
            ++this.loading; ++this.epoch; this.cancelAll(); this.connectionState = 'disconnected'; this.historySyncing = false; this.notify();
        }));
        this.toDispose.push(this.workspace.onWorkspaceChanged(() => void this.load()));
        this.toDispose.push(this.files.onDidFilesChange(event => {
            if (this.rootUri && event.contains(this.rootUri.resolve('.nodu-tutor/plan.json'))) { void this.refresh(); }
        }));
        let enabled = this.enabled;
        // Leaving professional mode cancels both lanes and moves to a new epoch, so no late result is applied.
        this.toDispose.push(this.layout.onDidChange(() => { if (this.enabled !== enabled) { enabled = this.enabled; this.transition(); } }));
        this.ready = this.workspace.ready.then(() => this.load());
    }
    dispose(): void {
        ++this.loading; ++this.epoch; this.cancelAll();
        if (this.draftSave) { clearTimeout(this.draftSave); }
        this.persistConversation('teach'); this.persistConversation('ask');
        const session = this.session; this.session = undefined; this.workspaceId = undefined;
        if (session) { void this.sessionOperation(() => this.service.closeSession(session.sessionId)).catch(() => undefined); }
        this.toDispose.dispose();
    }
    notify(): void { this.changed.fire(); }
    private unwrap<T>(value: TutorStorageOutcome<T>): T { if (!value.ok) { throw new Error(value.error.message); } return value.value; }
    private sessionOperation<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.sessionQueue.then(operation);
        this.sessionQueue = next.then(() => undefined, () => undefined);
        return next;
    }
    async load(): Promise<void> {
        const generation = ++this.loading;
        if (this.conversationProject) { this.persistConversation('teach'); this.persistConversation('ask'); }
        this.connectionState = 'connecting';
        ++this.epoch; this.cancelAll(); this.invalidate();
        // load() clears live handles while reconnecting. Keep the last known root and
        // buffer separately so an overlapping reconnect cannot mistake that gap for a new project.
        if (this.rootUri) { this.settledRootUri = this.rootUri; }
        if (this.buffer) { this.reconnectBuffer = this.buffer; }
        const old = this.session?.sessionId, oldRoot = this.rootUri ?? this.settledRootUri, oldBuffer = this.buffer ?? this.reconnectBuffer;
        this.session = undefined; this.workspaceId = undefined; this.rootUri = undefined; this.buffer = undefined; this.error = undefined; this.migration = undefined;
        this.goalState = emptyGoal(); this.lastAutoFragment = '';
        this.notify();
        try {
            // A disconnected host may no longer know the old handle. Still reconnect; never reuse it.
            if (old) { await this.sessionOperation(() => this.service.closeSession(old)).catch(() => undefined); }
            if (generation !== this.loading) { return; }
            const root = (await this.workspace.roots)[0]?.resource;
            if (generation !== this.loading) { return; }
            const grants = await this.service.workspaces();
            if (generation !== this.loading) { return; }
            this.rootUri = root;
            const grant = grants.find(g => sameUri(g.uri, root));
            const workspaceId = grant?.id;
            const sameProject = grant?.projectKey ? grant.projectKey === this.conversationProject : !!oldRoot && sameUri(oldRoot.toString(), root);
            if (sameProject) { this.buffer = oldBuffer; }
            else { this.messages.teach.length = 0; this.messages.ask.length = 0; this.drafts.teach = ''; this.drafts.ask = ''; }
            this.settledRootUri = workspaceId ? root : undefined; this.reconnectBuffer = this.buffer;
            if (grant?.projectKey && this.conversationProject !== grant.projectKey) { this.restoreConversations(grant.projectKey); }
            else if (!workspaceId) { this.conversationProject = undefined; this.conversationRecords = {}; }
            this.workspaceId = workspaceId;
            const settings = await this.service.aiSettings();
            if (generation !== this.loading) { return; }
            this.settings = settings;
            if (workspaceId) {
                // The host deduplicates handles per workspace. Serialize ownership so an obsolete
                // open cannot close the same handle that a newer reconnect is about to adopt.
                await this.sessionOperation(async () => {
                    if (generation !== this.loading) { return; }
                    const session = this.unwrap(await this.service.openSession(workspaceId));
                    if (generation !== this.loading) { await this.service.closeSession(session.sessionId).catch(() => undefined); }
                    else { this.session = session; }
                });
                if (generation !== this.loading) { return; }
                await this.refreshGoal();
                if (generation !== this.loading) { return; }
                await this.importLegacy();
                if (generation !== this.loading) { return; }
                await this.syncPresentation(); await this.sync;
            } else if (root) { this.error = '教学工作区尚未连接，请重新打开工程'; }
            if (generation === this.loading) { this.connectionState = 'connected'; }
        } catch (error) { if (generation === this.loading) { this.connectionState = 'disconnected'; this.error = error instanceof Error ? error.message : '教学连接失败'; } }
        if (generation === this.loading) { this.notify(); }
    }
    private async importLegacy(): Promise<void> {
        const session = this.session, state = session?.learning?.snapshot;
        if (!session || !state || state.legacyImported || !this.plan || state.progress.log.length) { return; }
        let raw: string | null = null;
        try { raw = localStorage.getItem(`nodu.tutor:${this.rootUri?.toString()}:${this.plan.id}`); } catch { return; }
        if (!raw) { return; }
        const next = this.unwrap(await this.service.importLegacyProgress(session.sessionId, state.sequence, state.planHash, crypto.randomUUID(), JSON.parse(raw)));
        if (session.sessionId === this.session?.sessionId && next.sequence >= (this.session.learning?.snapshot.sequence ?? 0)) { this.session.learning = { snapshot: next }; }
        // Keep the original until the user chooses to clear old browser data.
    }
    async refresh(): Promise<void> {
        const sessionId = this.session?.sessionId, generation = ++this.refreshing;
        if (!sessionId) { return; }
        try {
            const next = this.unwrap(await this.service.getSnapshot(sessionId));
            if (sessionId !== this.session?.sessionId || generation !== this.refreshing) { return; }
            if (next.learning && this.session.learning && next.learning.snapshot.sequence < this.session.learning.snapshot.sequence) { return; }
            if (next.learning?.snapshot.planHash !== this.session.learning?.snapshot.planHash) { this.invalidate(); }
            this.session = next; this.notify();
        } catch (error) { if (sessionId === this.session?.sessionId && generation === this.refreshing) { this.error = error instanceof Error ? error.message : '学习记录读取失败'; this.notify(); } }
    }
    onStorageChange(event: { sessionId: string; sequence: number }): void {
        if (event.sessionId === this.session?.sessionId && event.sequence > (this.session.learning?.snapshot.sequence ?? 0)) { void this.refresh(); }
    }
    onChatDelta(event: { id: string; epoch: number; text: string }): void {
        if (this.busy?.id !== event.id || this.epoch !== event.epoch || this.mode !== 'ask') { return; }
        const item = this.messages.ask.find(m => m.id === event.id);
        if (item) { item.text += event.text; this.notify(); }
    }
    async action(action: TutorLearningAction): Promise<void> {
        const session = this.session, state = session?.learning?.snapshot;
        if (!session || !state) { return; }
        try {
            const next = this.unwrap(await this.service.recordAction(session.sessionId, state.sequence, state.planHash, crypto.randomUUID(), action));
            if (session.sessionId === this.session?.sessionId && next.sequence >= (this.session.learning?.snapshot.sequence ?? 0)) { this.session.learning = { snapshot: next }; this.invalidate(); }
        } catch (error) { if (session.sessionId === this.session?.sessionId) { this.error = error instanceof Error ? error.message : '学习记录保存失败'; await this.refresh(); } }
        this.notify();
    }
    async previewMigration(target: TutorCourseTarget): Promise<void> {
        const session = this.session;
        if (!session) { return; }
        const preview = this.unwrap(await this.service.previewMigration(session.sessionId, target));
        if (session.sessionId === this.session?.sessionId) { this.migration = preview; this.notify(); }
    }
    async acceptMigration(): Promise<void> {
        const session = this.session, migration = this.migration;
        if (!session || !migration) { return; }
        const next = this.unwrap(await this.service.acceptMigration(session.sessionId, migration.id, migration.sourceDigest));
        if (session.sessionId !== this.session?.sessionId || migration !== this.migration) { return; }
        this.session = next; this.migration = undefined; await this.importLegacy();
        if (next.sessionId === this.session?.sessionId) { this.invalidate(); this.notify(); }
    }
    private invalidate(): void { this.presentation = undefined; this.guidance = undefined; this.invalidated.fire(); }
    updateBuffer(buffer?: TutorBuffer): void {
        const before = this.buffer;
        this.buffer = buffer;
        if (before?.path !== buffer?.path || before?.version !== buffer?.version || before?.text !== buffer?.text) {
            if (this.busy?.goal === 'fragment' || this.busy?.goal === 'check' || this.busy?.kind === 'step') { this.cancel(); }
            const guidance = this.guidance;
            this.invalidate();
            if (guidance && buffer && guidanceEditMatches(guidance.source, buffer, guidance.anchorLine, guidance.lines.length)) { this.guidance = guidance; }
            this.restoreGoalGuidance();
        }
        // The panel only shows the file and gates step checks on its presence; redraw on that, not on every keystroke.
        if (before?.path !== buffer?.path || JSON.stringify(before?.selection) !== JSON.stringify(buffer?.selection)) { this.notify(); }
    }
    private restoreGoalGuidance(): void {
        const fragment = this.goalState?.fragment, buffer = this.buffer;
        if (this.goalState?.status !== 'active' || !fragment?.answer.guidance || !buffer || this.paused) { return; }
        const g = fragment.answer.guidance;
        if (guidanceEditMatches(fragment.source, buffer, g.anchorLine, g.lines.length)) {
            this.guidance = { source: fragment.source, anchorLine: g.anchorLine, lines: [...g.lines] };
        }
    }
    async refreshGoal(): Promise<void> {
        const workspace = this.workspaceId, generation = this.loading;
        if (!workspace) { return; }
        try {
            const next = await this.service.goalSnapshot(workspace);
            if (workspace === this.workspaceId && generation === this.loading && next.revision >= this.goalState.revision) {
                if (next.revision !== this.goalState.revision || JSON.stringify(next.fragment) !== JSON.stringify(this.goalState.fragment)) { this.invalidate(); }
                this.goalState = next; this.restoreGoalGuidance(); this.notify();
            }
        } catch (error) {
            if (workspace !== this.workspaceId || generation !== this.loading) { return; }
            this.invalidate(); this.goalState = { ...this.goalState, fragment: undefined };
            this.error = error instanceof Error ? error.message : '教学进度读取失败'; this.notify();
        }
    }
    async resolveReference(path: string, line = 1): Promise<{ path: string; line: number }> {
        if (!this.workspaceId) { throw new Error('请先打开工程'); }
        return this.service.resolveReference(this.workspaceId, path, line);
    }
    async goalAction(action: TutorGoalRequest['action'], prompt?: string, placement?: 'suggest', stepId?: string): Promise<void> {
        if (!this.enabled || this.busy || !this.workspaceId || this.mode !== 'teach' || this.historySyncing || this.connectionState === 'disconnected' || this.connectionState === 'connecting') { return; }
        const workspace = this.workspaceId, epoch = this.epoch;
        try { await this.sync; } catch { return; }
        if (!this.enabled || this.busy || workspace !== this.workspaceId || epoch !== this.epoch || this.mode !== 'teach') { return; }
        if (['add', 'remove', 'undo-remove', 'pause', 'cancel'].includes(action)) { this.cancelReview(); }
        const id = crypto.randomUUID(), previousStep = this.goalState.current;
        this.busy = { id, mode: 'teach', kind: 'chat', goal: action }; this.error = undefined; this.notify();
        let advance = false;
        try {
            const context = this.goalRequestContexts(action), revision = this.goalState.revision;
            const result = await this.service.goal({ id, workspaceId: workspace, revision, action, ...(stepId ? { stepId } : {}), ...(placement ? { placement } : {}),
                ...(prompt ? { prompt } : {}), ...context });
            if (this.busy?.id !== id || workspace !== this.workspaceId || epoch !== this.epoch) { return; }
            if (!result.ok) { if (!result.cancelled) { this.error = result.error; } await this.refreshGoal(); return; }
            advance = action === 'confirm' || (action === 'check' && result.state.current > previousStep);
            this.invalidate(); this.goalState = result.state; this.restoreGoalGuidance();
            if (action === 'propose') {
                this.messages.teach.push({ id: crypto.randomUUID(), role: 'user', text: prompt ?? '', status: 'done', contextRefs: chatContextRefs(context.buffer, context.contexts),
                    request: { prompt: prompt ?? '', mode: 'teach', kind: 'goal', goalRevision: revision, ...context } });
                if (this.drafts.teach.trim() === prompt?.trim()) { this.drafts.teach = ''; }
            }
            const text = result.state.feedback;
            if (text && ['fragment','check'].includes(action)) { this.messages.teach.push({ id, role: 'assistant', text, status: 'done' }); }
            const step = result.state.steps[result.state.current];
            if (advance && step) { this.messages.teach.push({ id: crypto.randomUUID(), role: 'assistant', text: `${step.goal}\n[${step.path}](${step.path}#L1)`, status: 'done' }); }
            if (result.presentation && this.buffer?.path === result.presentation.source.path && this.buffer.text === result.presentation.source.text) {
                this.presentation = { buffer: { ...this.buffer }, answer: result.presentation.answer };
            }
            if (this.messages.teach.length > 100) { this.messages.teach.splice(0, this.messages.teach.length - 100); }
            if (this.conversationProject) { this.persistConversation('teach'); }
        } catch (error) { if (this.busy?.id === id && workspace === this.workspaceId && epoch === this.epoch) { this.error = error instanceof Error ? error.message : '教学连接已断开'; } }
        finally {
            if (this.busy?.id === id) { this.busy = undefined; }
            this.notify();
            if (advance && workspace === this.workspaceId && epoch === this.epoch && this.goalState.status === 'active'
                && (action === 'confirm' || this.buffer?.path === this.goalState.steps[this.goalState.current]?.path)) { this.fragmentRequested.fire(); }
        }
    }
    autoCheckFragment(reviewedLines: readonly number[] = []): void {
        const fragment = this.goalState.fragment, buffer = this.buffer, g = fragment?.answer.guidance;
        if (!this.teaching || this.goalState.status !== 'active' || this.busy || !fragment || !buffer || !g || fragment.source.path !== buffer.path) { return; }
        const lines = buffer.text.split('\n').slice(g.anchorLine - 1, g.anchorLine - 1 + g.lines.length);
        if (!g.lines.every((line, i) => line.trim() === lines[i]?.trim() || reviewedLines.includes(g.anchorLine + i))) { return; }
        const key = `${this.goalState.revision}:${buffer.path}:${buffer.text}`;
        if (key === this.lastAutoFragment) { return; }
        this.lastAutoFragment = key;
        void this.goalAction('check');
    }
    setMode(mode: TutorMode): void {
        if (mode === this.mode) { return; }
        if (this.conversationProject) { this.persistConversation(this.mode); }
        this.mode = mode; this.contextError = undefined; this.transition();
        this.rememberMode();
    }
    private rememberMode(): void { try { sessionStorage.setItem('nodu.tutor.mode', this.mode); } catch { /* optional per-window preference */ } }
    /** The toolbar AI switch: stops editor guidance and line review, never the conversation. */
    setPaused(paused: boolean): void {
        if (paused === this.paused) { return; }
        this.paused = paused;
        try { localStorage.setItem('nodu.tutor.guidance-off', String(paused)); } catch { /* In-memory only. */ }
        if (this.busy?.goal) { this.cancel(); }
        this.cancelReview(); this.invalidate(); this.restoreGoalGuidance(); this.notify();
    }
    private transition(): void { this.cancelAll(); this.invalidate(); this.restoreGoalGuidance(); void this.syncPresentation(); this.notify(); }
    private syncPresentation(): Promise<void> {
        const workspace = this.workspaceId, epoch = ++this.epoch, mode = this.mode, paused = !this.enabled;
        this.historySyncing = true;
        this.sync = this.sync.catch(() => undefined).then(async () => {
            if (workspace) {
                await this.service.setPresentation(workspace, epoch, mode, paused);
                if (workspace === this.workspaceId && epoch === this.epoch && this.conversationProject) {
                    await this.service.restoreChatHistory(workspace, epoch, mode, conversationPrompt(this.messages[mode]));
                }
            }
        });
        return this.sync.then(() => {
            if (workspace === this.workspaceId && epoch === this.epoch) { this.historySyncing = false; if (workspace) { this.connectionState = 'connected'; } this.notify(); }
        }, error => {
            if (workspace === this.workspaceId && epoch === this.epoch) { this.historySyncing = false; this.connectionState = 'disconnected'; this.error = error instanceof Error ? error.message : '教学会话更新失败'; this.notify(); }
        });
    }
    setPanelPreferred(open: boolean): void {
        this.panelPreferred = open;
        try { localStorage.setItem('nodu.tutor.panel', String(open)); } catch { /* In-memory only. */ }
    }
    setPanelVisible(visible: boolean): void { this.panelVisible = visible; this.notify(); }
    setDisplay(key: 'hintsVisible' | 'highlightsVisible' | 'annotationsVisible' | 'floatVisible' | 'autoReview', value: boolean): void {
        this[key] = value;
        const storage = { hintsVisible: 'ghost', highlightsVisible: 'highlight', annotationsVisible: 'annotations', floatVisible: 'float', autoReview: 'auto-review' };
        try { localStorage.setItem(`nodu.tutor.${storage[key]}`, String(value)); } catch { /* Display settings can remain in memory. */ }
        this.notify();
    }
    get selectedProvider(): TutorProviderView | undefined {
        const selection = this.settings?.selection;
        return selection && this.settings!.providers.find(p => p.id === selection.providerId);
    }
    get modelLabel(): string { return this.settings?.selection?.modelId ?? '选择模型'; }
    /** The selected provider can be called: it has a key, or it is a local server that needs none. */
    get configured(): boolean { const p = this.selectedProvider; return !!p && (p.hasKey || allowsNoKey(p.baseUrl)); }
    async refreshSettings(): Promise<void> {
        try { this.settings = await this.service.aiSettings(); this.notify(); } catch { /* The next load retries. */ }
    }
    private async apply(change: Promise<TutorAISettingsView>): Promise<void> { this.settings = await change; this.notify(); }
    saveProvider(provider: TutorProviderConfig): Promise<void> { return this.apply(this.service.saveProvider(provider)); }
    removeProvider(id: string): Promise<void> { return this.apply(this.service.removeProvider(id)); }
    setProviderKey(id: string, key: string): Promise<void> { return this.apply(this.service.setProviderKey(id, key)); }
    async deleteProviderKey(id: string): Promise<void> { if (this.selectedProvider?.id === id) { this.cancelAll(); } await this.apply(this.service.deleteProviderKey(id)); }
    selectModel(selection: TutorModelSelection): Promise<void> { return this.apply(this.service.selectModel(selection)); }
    testModel(providerId: string, modelId: string): Promise<TutorModelTest> { return this.service.testModel(providerId, modelId); }
    listRemoteModels(providerId: string): Promise<TutorRemoteModel[]> { return this.service.listRemoteModels(providerId); }
    /** The host pushes grant changes, so a window that loaded before the grant still connects. */
    private async onWorkspacesChanged(): Promise<void> {
        try {
            const root = (await this.workspace.roots)[0]?.resource;
            const id = (await this.service.workspaces()).find(g => sameUri(g.uri, root))?.id;
            if (id !== this.workspaceId) { await this.load(); }
        } catch { /* Reconnect reloads. */ }
    }
    cancel(): void {
        const busy = this.busy; if (!busy) { return; }
        this.busy = undefined;
        void this.service.cancelChat(busy.id).catch(() => undefined);
        this.settle(busy.mode, busy.id, 'stopped'); this.notify();
    }
    cancelReview(): void {
        const review = this.reviewing; if (!review) { return; }
        this.reviewing = undefined;
        void this.service.cancelChat(review.id).catch(() => undefined); this.notify();
    }
    cancelAll(): void { this.cancel(); this.cancelReview(); }
    private settle(mode: TutorMode, id: string, status: Exclude<TutorChatItem['status'], 'pending'>, note?: string): void {
        const item = this.messages[mode].find(m => m.id === id);
        if (item?.status === 'pending') { item.status = status; if (note) { item.note = note; } if (this.conversationProject) { this.persistConversation(mode); } }
    }
    setIncludeCode(value: boolean): void { this.includeCode = value; this.contextError = undefined; this.persistConversation(this.mode); this.notify(); }
    private goalRequestContexts(action: TutorGoalRequest['action']): Pick<TutorGoalRequest, 'buffer' | 'contexts'> {
        const buffer = this.buffer && (action === 'fragment' || action === 'check' || (action === 'propose' && this.currentContextIncluded)) ? requestBuffer(this.buffer) : undefined;
        const contexts = ['propose','add','fragment','check'].includes(action) ? validateTutorContexts(this.pins.filter(p => p.path !== buffer?.path), 'teach', buffer) : [];
        return { ...(buffer ? { buffer } : {}), ...(contexts.length ? { contexts } : {}) };
    }
    async listContextFiles(): Promise<string[]> {
        const workspace = this.workspaceId, mode = this.mode, epoch = this.epoch;
        if (!workspace) { return []; }
        const files = await this.service.listChatContextFiles(workspace);
        return workspace === this.workspaceId && mode === this.mode && epoch === this.epoch ? files.filter(path => mode === 'ask' || !/\.(py|ino)$/i.test(path)) : [];
    }
    async addCurrentContext(kind: 'file' | 'selection'): Promise<boolean> {
        const buffer = this.buffer;
        if (!buffer || (kind === 'selection' && !buffer.selection?.text)) { this.contextError = '请先打开文件并选择代码'; this.notify(); return false; }
        const selection = kind === 'selection' ? buffer.selection : undefined;
        return this.addContext({ kind, path: buffer.path, text: selection?.text ?? buffer.text, version: buffer.version,
            startLine: selection?.startLine ?? 1, endLine: selection?.endLine ?? buffer.text.split('\n').length });
    }
    listContextTerminals(): { id: string; title: string }[] {
        return (this.terminals?.all ?? []).filter(t => !t.isDisposed).map(t => ({ id: t.id, title: t.title.label || '终端' }));
    }
    async openTerminalContext(path: string): Promise<boolean> {
        if (!path.startsWith('terminal:') || path.length === 'terminal:'.length) { return false; }
        const terminal = this.terminals?.getById(path.slice('terminal:'.length));
        if (!terminal || terminal.isDisposed) { return false; }
        try { await this.terminals.open(terminal, { mode: 'activate' }); return true; }
        catch { return false; }
    }
    async addTerminalContext(id: string, selectionOnly = false): Promise<boolean> {
        try {
            const terminal = this.terminals.getById(id);
            if (!terminal || terminal.isDisposed) { throw new Error('此终端已关闭，请重新选择'); }
            const selected = selectionOnly ? terminal.getSelection() : '';
            if (selectionOnly && !selected) { throw new Error('请先选择终端输出'); }
            const position = selected ? (terminal as Partial<Pick<TerminalWidgetImpl, 'getTerminal'>>).getTerminal?.().getSelectionPosition() : undefined;
            if (selected && !position) { throw new Error('无法读取终端选区'); }
            const startLine = position ? position.start.y + 1 : Math.max(0, terminal.buffer.length - 200) + 1;
            const text = redactChatSecrets((selected || terminal.buffer.getLines(startLine - 1, 200, true).join('\n'))
                .replace(/\r\n?/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd());
            if (!text.trim()) { throw new Error('此终端还没有输出'); }
            const endLine = position ? Math.max(startLine, position.end.y + (position.end.x === 0 ? 0 : 1)) : startLine + text.split('\n').length - 1;
            const terminalName = redactChatSecrets(terminal.title.label || '终端').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) || '终端';
            return this.addContext({ kind: 'terminal', path: `terminal:${terminal.id}`, terminalName, terminalSelection: selectionOnly, text, version: 1, startLine, endLine });
        } catch (error) { this.contextError = error instanceof Error ? error.message : '无法读取终端输出'; this.notify(); return false; }
    }
    async addContextFile(path: string): Promise<boolean> {
        const workspace = this.workspaceId;
        return this.addContext(() => this.service.readChatContext(workspace!, path));
    }
    async addContextSnapshot(context: TutorContext): Promise<boolean> { return this.addContext(context); }
    private async addContext(source: TutorContext | (() => Promise<TutorContext>)): Promise<boolean> {
        const workspace = this.workspaceId, mode = this.mode, epoch = this.epoch, conversation = this.activeConversationId;
        const current = (): boolean => workspace === this.workspaceId && mode === this.mode && epoch === this.epoch && conversation === this.activeConversationId && !this.historySyncing;
        if (!workspace || this.historySyncing) { return false; }
        const finish = this.beginContextTransfer();
        try {
            const context = typeof source === 'function' ? await source() : source;
            if (!current()) { return false; }
            const [authorized] = await this.service.authorizeChatContexts(workspace, mode, [context]);
            if (!current()) { return false; }
            const next = this.pins.filter(p => !((p.kind === 'terminal') === (authorized.kind === 'terminal') && p.path === authorized.path
                && (authorized.kind !== 'terminal' || !!p.terminalSelection === !!authorized.terminalSelection)
                && (authorized.kind === 'terminal' && !authorized.terminalSelection || p.startLine === authorized.startLine && p.endLine === authorized.endLine)));
            next.push(authorized);
            validateTutorContexts(next, mode);
            this.contextDrafts[mode] = next; this.contextError = undefined; this.persistConversation(mode); this.notify(); return true;
        } catch (error) { if (current()) { this.contextError = error instanceof Error ? error.message : '附件不可用'; this.notify(); } return false; }
        finally { finish(); }
    }
    removeContext(index: number): void {
        if (!Number.isInteger(index) || index < 0 || index >= this.pins.length) { return; }
        this.contextDrafts[this.mode].splice(index, 1); this.contextError = undefined; this.persistConversation(this.mode); this.notify();
    }
    private selectedKey(project: string, mode: TutorMode): string { return `nodu.tutor.active.${project}.${mode}`; }
    private rememberSelection(c: TutorConversation): void {
        try { sessionStorage.setItem(this.selectedKey(c.project, c.mode), c.id); } catch { /* Window-local pointer is optional. */ }
    }
    private restoreConversations(project: string): void {
        this.conversationProject = project; this.conversationRecords = {};
        for (const mode of ['teach','ask'] as const) {
            let selected: string | null = null;
            try { selected = sessionStorage.getItem(this.selectedKey(project, mode)); } catch { /* use recent history */ }
            const recent = this.conversationStore.list(project, mode)[0]?.id;
            const c = (selected ? this.conversationStore.read(selected, project, mode) : recent && this.conversationStore.read(recent, project, mode)) || this.conversationStore.create(project, mode);
            this.conversationRecords[mode] = c;
            this.messages[mode].splice(0, this.messages[mode].length, ...c.messages); this.drafts[mode] = c.draft;
            this.contextDrafts[mode] = c.contexts ?? []; this.includedCode[mode] = c.includeCode ?? true;
            this.rememberSelection(c);
        }
    }
    private persistConversation(mode: TutorMode): void {
        if (this.draftSave) { clearTimeout(this.draftSave); this.draftSave = undefined; }
        const project = this.conversationProject;
        if (!project) { return; }
        const c = this.conversationRecords[mode] ?? this.conversationStore.create(project, mode);
        try {
            const saved = this.conversationStore.save({ ...c, messages: [...this.messages[mode]], draft: this.drafts[mode], contexts: [...this.contextDrafts[mode]], includeCode: this.includedCode[mode] });
            this.conversationRecords[mode] = saved; this.rememberSelection(saved); this.persistenceError = undefined;
        } catch (error) { this.persistenceError = error instanceof Error ? error.message : '对话暂未保存，内容保留在当前窗口'; }
    }
    setDraft(text: string): void {
        this.drafts[this.mode] = text;
        if (this.draftSave) { clearTimeout(this.draftSave); }
        const mode = this.mode;
        this.draftSave = setTimeout(() => { this.persistConversation(mode); this.notify(); }, 300);
        this.notify();
    }
    async newConversation(): Promise<void> {
        if (!this.conversationProject || this.historySyncing) { return; }
        this.historyOpen = false;
        const mode = this.mode;
        if (!this.messages[mode].length && !this.drafts[mode] && !this.pins.length) { this.notify(); return; }
        this.cancelAll(); this.persistConversation(mode);
        this.conversationRecords[mode] = this.conversationStore.create(this.conversationProject, mode);
        this.messages[mode].length = 0; this.drafts[mode] = ''; this.contextDrafts[mode] = []; this.contextError = undefined; this.persistConversation(mode);
        await this.activateConversation();
    }
    async selectConversation(id: string, mode: TutorMode = this.mode): Promise<void> {
        if (!this.conversationProject || this.historySyncing) { return; }
        if (id === this.activeConversationId && mode === this.mode) { this.showHistory(false); return; }
        const c = this.conversationStore.read(id, this.conversationProject, mode);
        if (!c) { this.error = '对话已不可用'; this.notify(); return; }
        this.cancelAll(); this.persistConversation(this.mode);
        this.mode = mode; this.rememberMode(); this.historyOpen = false;
        this.conversationRecords[this.mode] = c; this.rememberSelection(c);
        this.messages[this.mode].splice(0, this.messages[this.mode].length, ...c.messages); this.drafts[this.mode] = c.draft;
        this.contextDrafts[this.mode] = c.contexts ?? []; this.includeCode = c.includeCode ?? true; this.contextError = undefined;
        this.invalidate(); this.restoreGoalGuidance();
        await this.activateConversation();
    }
    private async activateConversation(): Promise<void> {
        this.historySyncing = true; this.error = undefined; this.notify();
        const workspace = this.workspaceId, generation = this.loading;
        try {
            await this.syncPresentation(); await this.sync;
        } catch { if (workspace === this.workspaceId && generation === this.loading) { this.connectionState = 'disconnected'; } }
        finally { if (workspace === this.workspaceId && generation === this.loading) { this.historySyncing = false; this.notify(); } }
    }
    private retrySnapshotCurrent(snapshot: TutorChatSnapshot): boolean {
        return snapshot.kind === 'chat' && snapshot.mode === this.mode && snapshot.goalRevision === this.goalState.revision
            && (!snapshot.buffer || !!this.buffer && snapshot.buffer.path === this.buffer.path && snapshot.buffer.text === this.buffer.text);
    }
    canRetry(item: TutorChatItem): boolean {
        return !!item.request && item.role === 'assistant' && ['stopped','failed'].includes(item.status) && item.request.kind === 'chat'
            && this.messages[this.mode].includes(item) && this.canSendChat;
    }
    async retryChat(id: string): Promise<void> {
        const item = this.messages[this.mode].find(m => m.id === id);
        if (!item || !this.canRetry(item) || !item.request) { return; }
        if (!this.retrySnapshotCurrent(item.request)) { this.error = '代码或教学步骤已变更，请重新检查'; this.notify(); return; }
        await this.send('chat', undefined, item.request);
    }
    editMessage(id: string): boolean {
        const item = this.messages[this.mode].find(m => m.id === id && m.role === 'user');
        if (!item) { return false; }
        const draft = this.drafts[this.mode];
        if (draft.trim() && draft !== item.text) { this.error = '输入框已有草稿，请先保留或清空后再编辑'; this.notify(); return false; }
        this.error = undefined; this.setDraft(item.text); return true;
    }
    async clearChat(): Promise<void> {
        const workspace = this.workspaceId, mode = this.mode, generation = this.loading;
        this.cancel(); this.messages[mode].length = 0; if (this.conversationProject) { this.persistConversation(mode); } this.notify();
        const cleared = this.sync.catch(() => undefined).then(async () => { if (workspace) { await this.service.clearChat(workspace, mode); } });
        this.sync = cleared;
        try { await cleared; }
        catch (error) {
            if (workspace === this.workspaceId && mode === this.mode && generation === this.loading) {
                this.error = error instanceof Error ? error.message : '对话清理失败'; this.notify();
            }
        }
    }
    async send(kind: TutorChatRequest['kind'] = 'chat', buffer?: TutorBuffer, retry?: TutorChatSnapshot): Promise<TutorAIResult | undefined> {
        if (this.historySyncing || this.connectionState === 'connecting' || this.connectionState === 'disconnected' || (kind === 'chat' && !retry && this.contextLoading)) { return; }
        if (!retry && this.mode === 'teach' && !this.plan && kind === 'chat' && ['none','draft','cancelled','complete'].includes(this.goalState.status)) {
            await this.goalAction('propose', this.drafts.teach.trim()); return;
        }
        if (this.mode === 'teach' && kind === 'step' && this.goalState.status === 'active' && this.configured) { await this.goalAction('check'); return; }
        const review = kind === 'line';
        const laneBusy = (): boolean => review ? !!this.reviewing : !!this.busy;
        if (!this.enabled || laneBusy() || !this.workspaceId || this.historySyncing || (review && this.paused)) { return; }
        const mode = this.mode, workspace = this.workspaceId, epoch = this.epoch;
        const prompt = retry ? retry.prompt : kind === 'chat' ? this.drafts[mode].trim() : review ? `检查第 ${buffer?.line} 行的 C 代码语义。` : this.currentStep()?.goal ?? '检查当前代码。';
        if (!prompt) { return; }
        try { await this.sync; } catch { return; }
        if (!this.enabled || laneBusy() || mode !== this.mode || workspace !== this.workspaceId || epoch !== this.epoch || (review && this.paused) || (kind === 'chat' && !retry && this.contextLoading)) { return; }
        if (retry && !this.retrySnapshotCurrent(retry)) { this.error = '代码或教学步骤已变更，请重新检查'; this.notify(); return; }
        const rawContext = retry ? retry.buffer : buffer ?? (kind !== 'chat' || this.currentContextIncluded ? this.buffer : undefined);
        const context = rawContext ? requestBuffer(rawContext) : undefined;
        let contexts: TutorContext[];
        try { contexts = validateTutorContexts(retry?.contexts ?? (kind === 'chat' ? this.pins.filter(p => p.path !== context?.path) : []), mode, context); }
        catch (error) { this.contextError = error instanceof Error ? error.message : '附件无效'; this.notify(); return; }
        const request: TutorChatRequest = { id: crypto.randomUUID(), workspaceId: workspace, epoch, mode, kind, prompt, ...(context ? { buffer: { ...context } } : {}), ...(contexts.length ? { contexts } : {}) };
        const current = (): boolean => review ? this.reviewing?.id === request.id : this.busy?.id === request.id;
        if (review) { this.reviewing = { id: request.id }; } else { this.busy = { id: request.id, mode, kind }; }
        const userId = crypto.randomUUID();
        const assistant: TutorChatItem = { id: request.id, role: 'assistant', text: '', status: 'pending', replyTo: userId,
            request: { prompt, mode, kind, goalRevision: this.goalState.revision, ...(context ? { buffer: { ...context } } : {}), ...(contexts.length ? { contexts } : {}) } };
        if (!review) {
            this.messages[mode].push({ id: userId, role: 'user', text: prompt, status: 'done', contextRefs: chatContextRefs(request.buffer, request.contexts) }, assistant);
            if (this.messages[mode].length > 100) { this.messages[mode].splice(0, 2); }
            if (kind === 'chat' && !retry && this.drafts[mode].trim() === prompt) { this.drafts[mode] = ''; }
            if (this.conversationProject) { this.persistConversation(mode); }
        }
        this.notify();
        try {
            let localResult: TutorAIResult | undefined;
            if (kind === 'step' && context) {
                const step = this.currentStep(), rules: TutorLocalRule[] = [];
                for (const r of step?.requirements ?? []) {
                    if (!['calls','noCallIn','checksReturn'].includes(r.type) || !('anchorId' in r)) { continue; }
                    const anchor = step?.anchors.find(a => a.id === r.anchorId && a.path === context.path);
                    if (!anchor?.symbol) { continue; }
                    const callees = 'callees' in r ? r.callees : 'callee' in r ? [r.callee] : [];
                    for (const callee of callees) { rules.push({ id: `${r.id}_${rules.length}`.slice(0, 80), kind: r.type as TutorLocalRule['kind'], function: anchor.symbol, callee }); }
                }
                const local = await this.service.inspectBuffer(request.workspaceId, context, rules.slice(0, 32), request.id);
                if (!current() || request.epoch !== this.epoch) { return { ok: false, error: '已停止', cancelled: true }; }
                if (!this.configured || local.execution || local.syntax === 'incomplete' || local.findings.some(f => f.verdict === 'needs-work')) {
                    const text = local.execution ? local.execution.note : local.syntax === 'unavailable' ? local.note ?? '本地检查不可用' : local.syntax === 'incomplete' ? '本地检查发现语法结构尚未完整。' :
                        local.findings.length ? local.findings.map(f => `${f.id}：${f.note}`).join('\n') : '本地语法结构检查通过，尚未验证编译和运行。';
                    localResult = { ok: true, answer: { text, annotations: local.errorLines.slice(0, 8).map(line => ({ startLine: line, endLine: line, note: '语法结构待补齐' })), review: { verdict: local.execution?.status === 'failed' || local.findings.some(f => f.verdict === 'needs-work') ? 'needs-work' : 'context', note: text } } };
                }
            }
            const result = localResult ?? await this.service.chat(request);
            if (!current() || request.epoch !== this.epoch || request.workspaceId !== this.workspaceId) {
                this.settle(mode, request.id, 'stopped');
                return { ok: false, error: '已停止', cancelled: true };
            }
            if (result.ok) {
                assistant.text = result.answer.text; assistant.status = 'done';
                if (mode === 'teach' && context && this.buffer?.path === context.path && this.buffer.version === context.version && this.buffer.text === context.text) {
                    this.presentation = { buffer: { ...context }, answer: result.answer };
                    if (result.answer.guidance) { this.guidance = { source: { ...context }, anchorLine: result.answer.guidance.anchorLine, lines: [...result.answer.guidance.lines] }; }
                }
            } else if (result.cancelled) { this.settle(mode, request.id, 'stopped'); }
            else { this.settle(mode, request.id, 'failed', result.error); }
            return result;
        } catch {
            this.settle(mode, request.id, 'failed', 'AI 连接已断开');
            return { ok: false, error: 'AI 连接已断开' };
        } finally {
            if (current()) { if (review) { this.reviewing = undefined; } else { this.busy = undefined; } }
            if (!review && request.workspaceId === this.workspaceId && this.conversationProject) { this.persistConversation(mode); }
            this.notify();
            if (review) { this.autoCheckFragment(); }
        }
    }
}
