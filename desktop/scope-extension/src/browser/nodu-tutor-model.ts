// SPDX-License-Identifier: MIT
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { DisposableCollection, Emitter } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { TutorAIClient, TutorAIResult, TutorAnswer, TutorBuffer, TutorChatRequest, TutorMode, TutorModelTest, TutorRemoteModel, TutorService, TUTOR_SERVICE_PATH } from '../common/tutor/tutor-ai-protocol';
import { TutorAISettingsView, TutorModelSelection, TutorProviderConfig, TutorProviderView, allowsNoKey } from '../common/tutor/tutor-ai-config';
import { TutorCourseTarget, TutorCourseV2 } from '../common/tutor/tutor-course';
import { TutorLearningAction, emptyLearningProgress } from '../common/tutor/tutor-learning-state';
import { CourseMigrationPreview, TutorSessionSnapshot, TutorStorageOutcome } from '../common/tutor/tutor-storage-protocol';
import { guidanceEditMatches } from '../common/tutor/tutor-guidance';
import { emptyGoal, TutorGoalRequest, TutorGoalState } from '../common/tutor/tutor-goal';
import { TutorLineHistoryCache } from '../common/tutor/tutor-line-history';
import { ScopeLayoutState } from './scope-layout-state';

/** Every assistant item leaves `pending`; a stopped or superseded request must never stay "thinking". */
export type TutorChatStatus = 'pending' | 'done' | 'stopped' | 'failed';
export interface TutorChatItem { id: string; role: 'user' | 'assistant'; text: string; status: TutorChatStatus; note?: string; }
export interface TutorPresentation { buffer: TutorBuffer; answer: TutorAnswer; }
/** file: URIs from the host and from Theia may differ in encoding and trailing slashes. */
const sameUri = (a: string, b: URI | undefined): boolean => !!b && new URI(a).path.toString().replace(/\/+$/, '') === b.path.toString().replace(/\/+$/, '');
const stored = (key: string, fallback: boolean): boolean => { try { const v = localStorage.getItem(`nodu.tutor.${key}`); return v === null ? fallback : v === 'true'; } catch { return fallback; } };

@injectable()
export class NoduTutorModel {
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(WebSocketConnectionProvider) protected readonly connections!: WebSocketConnectionProvider;
    @inject(ScopeLayoutState) protected readonly layout!: ScopeLayoutState;
    private service!: TutorService;
    private readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly invalidated = new Emitter<void>();
    readonly onDidInvalidate = this.invalidated.event;
    private readonly toDispose = new DisposableCollection(this.changed, this.invalidated);
    ready: Promise<void> = Promise.resolve();
    rootUri?: URI;
    workspaceId?: string;
    session?: TutorSessionSnapshot;
    error?: string;
    mode: TutorMode = 'teach';
    /** Editor guidance (ghost text, highlights, line review) is off; chat stays available. */
    paused = stored('guidance-off', false);
    panelVisible = false;
    /** Professional mode opens the AI sidebar on the right unless the user closed it. */
    panelPreferred = stored('panel', true);
    epoch = 0;
    hintsVisible = stored('ghost', true);
    highlightsVisible = stored('highlight', true);
    annotationsVisible = stored('annotations', true);
    floatVisible = stored('float', false);
    autoReview = stored('auto-review', true);
    includeCode = true;
    buffer?: TutorBuffer;
    presentation?: TutorPresentation;
    guidance?: { source: TutorBuffer; anchorLine: number; lines: string[] };
    goalState: TutorGoalState = emptyGoal();
    readonly lineHistory = new TutorLineHistoryCache();
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
    private loading = 0;
    private sync: Promise<void> = Promise.resolve();
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
        this.toDispose.push(proxy.onDidOpenConnection(() => { void this.workspace.ready.then(() => this.load()); }));
        this.toDispose.push(this.workspace.onWorkspaceChanged(() => void this.load()));
        this.toDispose.push(this.files.onDidFilesChange(event => {
            if (this.rootUri && event.contains(this.rootUri.resolve('.nodu-tutor/plan.json'))) { void this.refresh(); }
        }));
        let enabled = this.enabled;
        // Leaving professional mode cancels both lanes and moves to a new epoch, so no late result is applied.
        this.toDispose.push(this.layout.onDidChange(() => { if (this.enabled !== enabled) { enabled = this.enabled; this.transition(); } }));
        this.ready = this.workspace.ready.then(() => this.load());
    }
    dispose(): void { this.cancelAll(); this.toDispose.dispose(); }
    notify(): void { this.changed.fire(); }
    private unwrap<T>(value: TutorStorageOutcome<T>): T { if (!value.ok) { throw new Error(value.error.message); } return value.value; }
    async load(): Promise<void> {
        const generation = ++this.loading;
        this.cancelAll(); this.invalidate();
        const old = this.session?.sessionId;
        this.session = undefined; this.workspaceId = undefined; this.buffer = undefined; this.error = undefined; this.migration = undefined;
        this.goalState = emptyGoal();
        this.messages.teach.length = 0; this.messages.ask.length = 0;
        try {
            if (old) { await this.service.closeSession(old); }
            const root = (await this.workspace.roots)[0]?.resource;
            const grants = await this.service.workspaces();
            if (generation !== this.loading) { return; }
            this.rootUri = root;
            this.workspaceId = grants.find(g => sameUri(g.uri, root))?.id;
            this.settings = await this.service.aiSettings();
            if (this.workspaceId) {
                const session = this.unwrap(await this.service.openSession(this.workspaceId));
                if (generation !== this.loading) { return; }
                this.session = session;
                await this.refreshGoal();
                await this.importLegacy();
                await this.syncPresentation();
            } else if (root) { this.error = '教学工作区尚未连接，请重新打开工程'; }
        } catch (error) { if (generation === this.loading) { this.error = error instanceof Error ? error.message : '教学连接失败'; } }
        if (generation === this.loading) { this.notify(); }
    }
    private async importLegacy(): Promise<void> {
        const state = this.session?.learning?.snapshot;
        if (!state || state.legacyImported || !this.plan || state.progress.log.length) { return; }
        let raw: string | null = null;
        try { raw = localStorage.getItem(`nodu.tutor:${this.rootUri?.toString()}:${this.plan.id}`); } catch { return; }
        if (!raw) { return; }
        const next = this.unwrap(await this.service.importLegacyProgress(this.session!.sessionId, state.sequence, state.planHash, crypto.randomUUID(), JSON.parse(raw)));
        this.session!.learning = { snapshot: next };
        // Keep the original until the user chooses to clear old browser data.
    }
    async refresh(): Promise<void> {
        const sessionId = this.session?.sessionId;
        if (!sessionId) { return; }
        try {
            const next = this.unwrap(await this.service.getSnapshot(sessionId));
            if (sessionId !== this.session?.sessionId) { return; }
            if (next.learning?.snapshot.planHash !== this.session.learning?.snapshot.planHash) { this.invalidate(); }
            this.session = next; this.notify();
        } catch (error) { this.error = error instanceof Error ? error.message : '学习记录读取失败'; this.notify(); }
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
            if (session.sessionId === this.session?.sessionId) { this.session.learning = { snapshot: next }; this.invalidate(); }
        } catch (error) { this.error = error instanceof Error ? error.message : '学习记录保存失败'; await this.refresh(); }
        this.notify();
    }
    async previewMigration(target: TutorCourseTarget): Promise<void> {
        if (!this.session) { return; }
        this.migration = this.unwrap(await this.service.previewMigration(this.session.sessionId, target)); this.notify();
    }
    async acceptMigration(): Promise<void> {
        if (!this.session || !this.migration) { return; }
        this.session = this.unwrap(await this.service.acceptMigration(this.session.sessionId, this.migration.id, this.migration.sourceDigest));
        this.migration = undefined; await this.importLegacy(); this.invalidate(); this.notify();
    }
    private invalidate(): void { this.presentation = undefined; this.guidance = undefined; this.invalidated.fire(); }
    updateBuffer(buffer?: TutorBuffer): void {
        const before = this.buffer;
        this.buffer = buffer;
        if (before?.path !== buffer?.path || before?.version !== buffer?.version || before?.text !== buffer?.text) {
            if (this.busy?.goal === 'fragment' || this.busy?.goal === 'check') { this.cancel(); }
            const guidance = this.guidance;
            this.invalidate();
            if (guidance && buffer && guidanceEditMatches(guidance.source, buffer, guidance.anchorLine, guidance.lines.length)) { this.guidance = guidance; }
            this.restoreGoalGuidance();
        }
        // The panel only shows the file and gates step checks on its presence; redraw on that, not on every keystroke.
        if (before?.path !== buffer?.path) { this.notify(); }
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
        const workspace = this.workspaceId;
        if (!workspace) { return; }
        try {
            const next = await this.service.goalSnapshot(workspace);
            if (workspace === this.workspaceId && next.revision >= this.goalState.revision) {
                if (next.revision !== this.goalState.revision) { this.invalidate(); }
                this.goalState = next; this.restoreGoalGuidance(); this.notify();
            }
        } catch (error) { this.error = error instanceof Error ? error.message : '教学进度读取失败'; this.notify(); }
    }
    async resolveReference(path: string, line = 1): Promise<{ path: string; line: number }> {
        if (!this.workspaceId) { throw new Error('请先打开工程'); }
        return this.service.resolveReference(this.workspaceId, path, line);
    }
    async goalAction(action: TutorGoalRequest['action'], prompt?: string): Promise<void> {
        if (!this.enabled || this.busy || !this.workspaceId || this.mode !== 'teach') { return; }
        await this.sync;
        if (this.busy || !this.workspaceId || this.mode !== 'teach') { return; }
        const workspace = this.workspaceId, epoch = this.epoch, id = crypto.randomUUID(), previousStep = this.goalState.current;
        this.busy = { id, mode: 'teach', kind: 'chat', goal: action }; this.error = undefined; this.notify();
        let advance = false;
        try {
            const result = await this.service.goal({ id, workspaceId: workspace, revision: this.goalState.revision, action,
                ...(prompt ? { prompt } : {}), ...((action === 'fragment' || action === 'check' || (action === 'propose' && this.includeCode)) && this.buffer ? { buffer: { ...this.buffer } } : {}) });
            if (this.busy?.id !== id || workspace !== this.workspaceId || epoch !== this.epoch) { return; }
            if (!result.ok) { if (!result.cancelled) { this.error = result.error; } await this.refreshGoal(); return; }
            advance = action === 'confirm' || (action === 'check' && result.state.current > previousStep);
            this.invalidate(); this.goalState = result.state; this.restoreGoalGuidance();
            if (action === 'propose') {
                this.messages.teach.push({ id: crypto.randomUUID(), role: 'user', text: prompt ?? '', status: 'done' });
                this.drafts.teach = '';
            }
            const text = result.state.feedback;
            if (text && ['fragment','check'].includes(action)) { this.messages.teach.push({ id, role: 'assistant', text, status: 'done' }); }
            const step = result.state.steps[result.state.current];
            if (advance && step) { this.messages.teach.push({ id: crypto.randomUUID(), role: 'assistant', text: `${step.goal}\n[${step.path}](${step.path}#L1)`, status: 'done' }); }
            if (result.presentation && this.buffer?.path === result.presentation.source.path && this.buffer.text === result.presentation.source.text) {
                this.presentation = { buffer: { ...this.buffer }, answer: result.presentation.answer };
            }
            if (this.messages.teach.length > 100) { this.messages.teach.splice(0, this.messages.teach.length - 100); }
        } catch (error) { this.error = error instanceof Error ? error.message : '教学连接已断开'; }
        finally {
            if (this.busy?.id === id) { this.busy = undefined; }
            this.notify();
            if (advance && this.goalState.status === 'active' && this.goalState.steps[this.goalState.current]?.path === this.buffer?.path
                && !this.buffer.text.split('\n')[this.buffer.line - 1]?.trim()) { void this.goalAction('fragment'); }
        }
    }
    private autoCheckFragment(): void {
        const fragment = this.goalState.fragment, buffer = this.buffer, g = fragment?.answer.guidance;
        if (!this.teaching || this.goalState.status !== 'active' || this.busy || !fragment || !buffer || !g || fragment.source.path !== buffer.path) { return; }
        const lines = buffer.text.split('\n').slice(g.anchorLine - 1, g.anchorLine - 1 + g.lines.length);
        if (!g.lines.every((line, i) => line.trim() === lines[i]?.trim())) { return; }
        const key = `${this.goalState.revision}:${buffer.path}:${buffer.text}`;
        if (key === this.lastAutoFragment) { return; }
        this.lastAutoFragment = key;
        void this.goalAction('check');
    }
    setMode(mode: TutorMode): void {
        if (mode === this.mode) { return; }
        this.mode = mode; this.transition();
    }
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
        this.sync = this.sync.catch(() => undefined).then(async () => {
            if (workspace) { await this.service.setPresentation(workspace, epoch, mode, paused); }
        });
        return this.sync.catch(error => { this.error = error instanceof Error ? error.message : '教学会话更新失败'; this.notify(); });
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
    private settle(mode: TutorMode, id: string, status: Exclude<TutorChatStatus, 'pending'>, note?: string): void {
        const item = this.messages[mode].find(m => m.id === id);
        if (item?.status === 'pending') { item.status = status; if (note) { item.note = note; } }
    }
    async clearChat(): Promise<void> { this.cancel(); if (this.workspaceId) { await this.service.clearChat(this.workspaceId, this.mode); } this.messages[this.mode].length = 0; this.notify(); }
    async send(kind: TutorChatRequest['kind'] = 'chat', buffer?: TutorBuffer): Promise<TutorAIResult | undefined> {
        if (this.mode === 'teach' && !this.plan && kind === 'chat' && ['none','draft','cancelled','complete'].includes(this.goalState.status)) {
            await this.goalAction('propose', this.drafts.teach.trim()); return;
        }
        if (this.mode === 'teach' && kind === 'step' && this.goalState.status === 'active') { await this.goalAction('check'); return; }
        const review = kind === 'line';
        const laneBusy = (): boolean => review ? !!this.reviewing : !!this.busy;
        if (!this.enabled || laneBusy() || !this.workspaceId || (review && this.paused)) { return; }
        const mode = this.mode;
        const prompt = kind === 'chat' ? this.drafts[mode].trim() : review ? `检查第 ${buffer?.line} 行的 C 代码语义。` : this.currentStep()?.goal ?? '检查当前代码。';
        if (!prompt) { return; }
        await this.sync;
        if (!this.enabled || laneBusy() || mode !== this.mode || !this.workspaceId || (review && this.paused)) { return; }
        const context = buffer ?? (this.includeCode ? this.buffer : undefined);
        const request: TutorChatRequest = { id: crypto.randomUUID(), workspaceId: this.workspaceId, epoch: this.epoch, mode, kind, prompt, ...(context ? { buffer: { ...context } } : {}) };
        const current = (): boolean => review ? this.reviewing?.id === request.id : this.busy?.id === request.id;
        if (review) { this.reviewing = { id: request.id }; } else { this.busy = { id: request.id, mode, kind }; }
        const assistant: TutorChatItem = { id: request.id, role: 'assistant', text: '', status: 'pending' };
        if (!review) {
            this.messages[mode].push({ id: crypto.randomUUID(), role: 'user', text: prompt, status: 'done' }, assistant);
            if (this.messages[mode].length > 100) { this.messages[mode].splice(0, 2); }
            if (kind === 'chat') { this.drafts[mode] = ''; }
        }
        this.notify();
        try {
            const result = await this.service.chat(request);
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
            this.notify();
            if (review) { this.autoCheckFragment(); }
        }
    }
}
