// SPDX-License-Identifier: MIT
// Plan and progress shared by the step panel and the in-editor hints (T1,
// docs/0.2/AI-TUTOR-DESIGN.md §13). No model is involved: the plan is a
// hand-written course file and steps are completed by the student.
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { DisposableCollection, Emitter } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
    DEFAULT_HINT_LEVEL, HintLevel, REFERENCE_LEVEL, StepState, TestReminder, TUTOR_PLAN_PATH, TutorPlan, TutorStep,
    maxHintLevel, nextStepId, parseTutorPlan, stepStates, testReminders,
} from '../common/nodu-tutor-plan';

/** Plans are small hand-written files; anything larger is rejected unread. */
const PLAN_SIZE_LIMIT = 512 * 1024;
const LOG_LIMIT = 500;
const HINTS_VISIBLE_KEY = 'nodu.tutor.hints-visible';

export type AnchorReport = { line: number } | 'missing' | 'ambiguous';
/** `closed`: no editor shows the anchor file, so its buffer has not been checked. */
export type AnchorStatus = { kind: 'ok'; line: number } | { kind: 'missing' } | { kind: 'ambiguous' } | { kind: 'closed' } | { kind: 'none' };

/** Learning record: stays in this machine's local storage (§10). */
interface TutorProgress {
    completed: string[];
    current?: string;
    levels: Record<string, HintLevel>;
    references: string[];
    decisions: Record<string, string>;
    log: { at: number; step: string; event: string }[];
}

const emptyProgress = (): TutorProgress => ({ completed: [], levels: {}, references: [], decisions: {}, log: [] });

@injectable()
export class NoduTutorModel {
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    private readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;
    protected readonly toDispose = new DisposableCollection(this.changed);
    plan: TutorPlan | undefined;
    /** Why the workspace plan could not be used; undefined when there is no plan file at all. */
    error: string | undefined;
    rootUri: URI | undefined;
    hintsVisible = localStorage.getItem(HINTS_VISIBLE_KEY) !== 'false';
    panelVisible = false;
    private progress: TutorProgress = emptyProgress();
    private states: StepState[] = [];
    /** Marker lookups per step, keyed by the editor URI that produced them. */
    private readonly anchors = new Map<string, Map<string, AnchorReport>>();
    private loadSeq = 0;
    /** Resolves after the first workspace plan lookup. */
    ready: Promise<void> = Promise.resolve();

    @postConstruct()
    protected init(): void {
        this.toDispose.push(this.workspace.onWorkspaceChanged(() => void this.load()));
        this.toDispose.push(this.files.onDidFilesChange(event => {
            const uri = this.planUri();
            if (uri && event.contains(uri)) { void this.load(); }
        }));
        this.ready = this.workspace.ready.then(() => this.load());
    }

    dispose(): void { this.toDispose.dispose(); }

    planUri(): URI | undefined { return this.rootUri?.resolve(TUTOR_PLAN_PATH); }

    async load(): Promise<void> {
        const seq = ++this.loadSeq;
        const root = (await this.workspace.roots)[0]?.resource;
        let plan: TutorPlan | undefined;
        let error: string | undefined;
        if (root) {
            const uri = root.resolve(TUTOR_PLAN_PATH);
            try {
                if (await this.files.exists(uri)) {
                    const content = await this.files.read(uri, { limits: { size: PLAN_SIZE_LIMIT } });
                    const result = parseTutorPlan(content.value);
                    plan = result.plan;
                    if (!plan) { error = result.errors.slice(0, 5).join('；'); }
                }
            } catch (cause) {
                error = `读取教学计划失败：${cause instanceof Error ? cause.message : String(cause)}`;
            }
        }
        // A newer load (workspace switch, plan edit) supersedes this one.
        if (seq !== this.loadSeq) { return; }
        this.rootUri = root;
        this.plan = plan;
        this.error = error;
        this.progress = plan ? this.readProgress(plan) : emptyProgress();
        this.recompute();
        this.changed.fire();
    }

    private storageKey(plan: TutorPlan): string { return `nodu.tutor:${this.rootUri?.toString() ?? ''}:${plan.id}`; }

    private readProgress(plan: TutorPlan): TutorProgress {
        const ids = new Set(plan.steps.map(step => step.id));
        try {
            const raw = JSON.parse(localStorage.getItem(this.storageKey(plan)) || 'null') as Partial<TutorProgress> | null;
            if (!raw || typeof raw !== 'object') { return emptyProgress(); }
            // Drop entries for steps a revised plan no longer has.
            const keep = <T>(record: unknown, valid: (value: unknown) => value is T): Record<string, T> => Object.fromEntries(
                Object.entries(record && typeof record === 'object' ? record : {}).filter(([id, value]) => ids.has(id) && valid(value)));
            return {
                completed: (Array.isArray(raw.completed) ? raw.completed : []).filter(id => ids.has(id)),
                current: typeof raw.current === 'string' && ids.has(raw.current) ? raw.current : undefined,
                levels: keep(raw.levels, (value): value is HintLevel => value === 0 || value === 1 || value === 2 || value === 3),
                references: (Array.isArray(raw.references) ? raw.references : []).filter(id => ids.has(id)),
                decisions: keep(raw.decisions, (value): value is string => typeof value === 'string'),
                log: Array.isArray(raw.log) ? raw.log.slice(-LOG_LIMIT) : [],
            };
        } catch {
            return emptyProgress();
        }
    }

    private save(step: string, event: string): void {
        if (!this.plan) { return; }
        this.progress.log.push({ at: Date.now(), step, event });
        this.progress.log = this.progress.log.slice(-LOG_LIMIT);
        try { localStorage.setItem(this.storageKey(this.plan), JSON.stringify(this.progress)); } catch { /* Storage full: progress stays in memory. */ }
    }

    private recompute(): void {
        if (!this.plan) { this.states = []; return; }
        this.states = stepStates(this.plan, new Set(this.progress.completed));
        const current = this.states.find(state => state.step.id === this.progress.current);
        if (!current || current.status === 'locked') { this.progress.current = nextStepId(this.states); }
    }

    private update(step: string, event: string): void {
        this.recompute();
        this.save(step, event);
        this.changed.fire();
    }

    stepStates(): readonly StepState[] { return this.states; }
    state(id: string): StepState | undefined { return this.states.find(state => state.step.id === id); }
    currentStep(): TutorStep | undefined { return this.state(this.progress.current ?? '')?.step; }
    completedCount(): number { return this.progress.completed.length; }
    level(id: string): HintLevel { return this.progress.levels[id] ?? DEFAULT_HINT_LEVEL; }
    viewedReference(id: string): boolean { return this.progress.references.includes(id); }
    decision(id: string): string | undefined { return this.progress.decisions[id]; }
    /** Nothing recorded yet for this plan: the panel opens once by itself. */
    isFresh(): boolean { return !!this.plan && !this.progress.log.length; }
    markSeen(): void { if (this.isFresh()) { this.save('', 'panel'); } }
    reminders(): TestReminder[] { return this.plan ? testReminders(this.plan, this.progress.completed) : []; }

    stepUri(step: TutorStep): URI | undefined {
        return step.anchor && this.rootUri ? this.rootUri.resolve(step.anchor.file) : undefined;
    }

    /** Untested prerequisites behind the 上游未验证 flag. */
    untestedDependencies(step: TutorStep): TutorStep[] {
        const done = new Set(this.progress.completed);
        return step.dependsOn.map(id => this.state(id)?.step).filter((dep): dep is TutorStep => !!dep && dep.kind === 'test' && !done.has(dep.id));
    }

    /** Non-test prerequisites that keep a step locked. */
    blockingDependencies(step: TutorStep): TutorStep[] {
        const done = new Set(this.progress.completed);
        return step.dependsOn.map(id => this.state(id)?.step).filter((dep): dep is TutorStep => !!dep && dep.kind !== 'test' && !done.has(dep.id));
    }

    select(id: string): void {
        const state = this.state(id);
        if (!state || state.status === 'locked' || this.progress.current === id) { return; }
        this.progress.current = id;
        this.update(id, 'select');
    }

    /** L0–L2 only; the reference level goes through {@link showReference}. */
    setLevel(id: string, level: HintLevel): void {
        const step = this.state(id)?.step;
        if (!step || level >= REFERENCE_LEVEL) { return; }
        const next = Math.min(level, maxHintLevel(step)) as HintLevel;
        if (next === this.level(id)) { return; }
        this.progress.levels[id] = next;
        this.update(id, `level:${next}`);
    }

    /** Called after the student confirmed; recorded so teachers can see it. */
    showReference(id: string): void {
        const step = this.state(id)?.step;
        if (!step || maxHintLevel(step) < REFERENCE_LEVEL) { return; }
        this.progress.levels[id] = REFERENCE_LEVEL;
        if (!this.progress.references.includes(id)) { this.progress.references.push(id); }
        this.update(id, 'reference');
    }

    complete(id: string): void {
        const state = this.state(id);
        if (!state || state.status !== 'available') { return; }
        this.progress.completed.push(id);
        this.progress.current = undefined;
        this.update(id, 'complete');
    }

    decide(id: string, optionId: string): void {
        const step = this.state(id)?.step;
        if (!step?.options?.some(option => option.id === optionId && option.available)) { return; }
        this.progress.decisions[id] = optionId;
        this.update(id, `decide:${optionId}`);
        this.complete(id);
    }

    /**
     * Completed steps that reopening `id` also reopens: everything that builds
     * on it through non-test dependencies. Dependencies point backwards, so
     * one pass in plan order is transitive.
     */
    reopenImpact(id: string): string[] {
        const reopened = new Set([id]);
        for (const step of this.plan?.steps ?? []) {
            if (step.dependsOn.some(dep => reopened.has(dep) && this.state(dep)?.step.kind !== 'test')) { reopened.add(step.id); }
        }
        reopened.delete(id);
        return [...reopened].filter(other => this.progress.completed.includes(other));
    }

    reopen(id: string): void {
        if (!this.progress.completed.includes(id)) { return; }
        const reopened = new Set([id, ...this.reopenImpact(id)]);
        this.progress.completed = this.progress.completed.filter(done => !reopened.has(done));
        this.progress.current = id;
        this.update(id, 'reopen');
    }

    resetProgress(): void {
        if (!this.plan) { return; }
        this.progress = emptyProgress();
        this.update('', 'reset');
    }

    setHintsVisible(visible: boolean): void {
        if (this.hintsVisible === visible) { return; }
        this.hintsVisible = visible;
        localStorage.setItem(HINTS_VISIBLE_KEY, String(visible));
        this.changed.fire();
    }

    setPanelVisible(visible: boolean): void {
        if (this.panelVisible !== visible) { this.panelVisible = visible; this.changed.fire(); }
    }

    reportAnchor(editorUri: string, stepId: string, report: AnchorReport | undefined): void {
        const reports = this.anchors.get(editorUri) ?? new Map<string, AnchorReport>();
        const before = JSON.stringify(reports.get(stepId));
        if (report) { reports.set(stepId, report); } else { reports.delete(stepId); }
        if (reports.size) { this.anchors.set(editorUri, reports); } else { this.anchors.delete(editorUri); }
        if (before !== JSON.stringify(report)) { this.changed.fire(); }
    }

    forgetEditor(editorUri: string): void {
        if (this.anchors.delete(editorUri)) { this.changed.fire(); }
    }

    anchorStatus(step: TutorStep): AnchorStatus {
        const uri = this.stepUri(step)?.toString();
        if (!uri) { return { kind: 'none' }; }
        const report = this.anchors.get(uri)?.get(step.id);
        if (!report) { return { kind: 'closed' }; }
        return report === 'missing' ? { kind: 'missing' } : report === 'ambiguous' ? { kind: 'ambiguous' } : { kind: 'ok', line: report.line };
    }
}
