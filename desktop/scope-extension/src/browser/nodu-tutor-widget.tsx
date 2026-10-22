// SPDX-License-Identifier: MIT
// 教学步骤 panel (docs/0.2/AI-TUTOR-DESIGN.md §3, §7, §8). It carries the same
// hint text as the in-editor ghost zone, reachable by keyboard and screen
// readers, plus the step list, test reminders and completion conditions.
// T1 has no checker: the student reviews the conditions and confirms.
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandService, MenuModelRegistry } from '@theia/core/lib/common';
import { CommonMenus, FrontendApplicationContribution, ReactWidget } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { NoduTutorModel } from './nodu-tutor-model';
import { TUTOR_COMMANDS } from './nodu-tutor-hints';
import { HINT_LEVEL_LABELS, HintLevel, LAYER_LABELS, REFERENCE_LEVEL, STEP_KIND_LABELS, StepState, TutorCheckType, TutorStep, hintSections, markerFor, maxHintLevel } from '../common/nodu-tutor-plan';

const PANEL_HINT_MAX: HintLevel = 2;
const CHECK_LABELS: Record<TutorCheckType, string> = {
    compiles: '编译', calls: '调用', checksReturn: '返回值', noCallIn: '分层', hostTest: '主机测试', serialMatch: '串口', review: '审阅', manual: '自查',
};

@injectable()
export class NoduTutorWidget extends ReactWidget {
    static readonly ID = 'nodu:tutor';
    static readonly LABEL = '教学步骤';
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    /** Decision drafts: an option is only recorded when the student confirms it. */
    private readonly drafts = new Map<string, string>();

    @postConstruct()
    protected init(): void {
        this.id = NoduTutorWidget.ID;
        this.title.label = NoduTutorWidget.LABEL;
        this.title.caption = 'Nodu · 教学步骤与代码提示';
        this.title.iconClass = 'codicon codicon-mortar-board';
        this.title.closable = true;
        this.addClass('scope-widget');
        this.addClass('nodu-tutor-widget');
        this.node.tabIndex = 0;
        this.toDispose.push(this.tutor.onDidChange(() => this.update()));
        this.toDispose.push(this.onDidChangeVisibility(visible => this.tutor.setPanelVisible(visible)));
        this.update();
    }

    protected onActivateRequest(): void { this.node.focus(); }

    private run(command: string, ...args: unknown[]): void { void this.commands.executeCommand(command, ...args); }

    private async askReference(step: TutorStep): Promise<void> {
        const confirmed = await new ConfirmDialog({
            title: '查看参考实现',
            msg: `${step.id}「${step.title}」的参考实现会记入学习记录。先试着按骨架自己写，写不出来再看。`,
            ok: '查看参考实现', cancel: '再试试',
        }).open();
        if (confirmed) { this.tutor.showReference(step.id); }
    }

    protected render(): React.ReactNode {
        const { plan, error } = this.tutor;
        if (!plan) {
            return <div className="nodu-tutor-content">
                <div className="nodu-preview-empty"><i className="codicon codicon-mortar-board" aria-hidden="true" />
                    <strong>当前项目没有教学计划</strong>
                    {error && <p className="scope-error" role="alert">{error}</p>}
                </div>
            </div>;
        }
        const states = this.tutor.stepStates();
        const current = this.tutor.currentStep();
        const done = this.tutor.completedCount();
        const reminders = this.tutor.reminders();
        return <div className="nodu-tutor-content">
            <header className="nodu-tutor-head">
                <h2>{plan.title}</h2>
                <p className="scope-helper">{plan.goal}</p>
                <div className="nodu-tutor-progress" role="progressbar" aria-label="完成进度" aria-valuemin={0} aria-valuemax={states.length} aria-valuenow={done}>
                    <span style={{ width: `${Math.round(done / states.length * 100)}%` }} />
                </div>
                <p className="scope-caption">已完成 {done} / {states.length}{plan.source === 'generated' ? ' · 生成计划' : ''}</p>
            </header>
            {reminders.length > 0 && <section className="nodu-tutor-reminders" aria-label="测试提醒">
                {reminders.map(reminder => <div key={reminder.stepId} className="nodu-tutor-reminder" role="status">
                    <i className="codicon codicon-beaker" aria-hidden="true" /><span>{reminder.text}</span>
                    {current?.id !== reminder.stepId && <button className="scope-text-button" onClick={() => this.tutor.select(reminder.stepId)}>去做 {reminder.stepId}</button>}
                </div>)}
            </section>}
            {current ? this.renderStep(this.tutor.state(current.id)!) : <section className="nodu-tutor-step"><p><strong>全部步骤已完成。</strong></p></section>}
            <section className="nodu-tutor-list" aria-label="全部步骤">
                <h3>全部步骤</h3>
                <ol>{states.map(state => this.renderListItem(state, state.step.id === current?.id))}</ol>
                <button className="scope-text-button" onClick={() => void this.resetProgress()}>重置进度</button>
            </section>
        </div>;
    }

    /** Reopening only changes completion records; code is never touched. Cascades are confirmed. */
    private async reopen(step: TutorStep): Promise<void> {
        const impact = this.tutor.reopenImpact(step.id);
        if (impact.length) {
            const confirmed = await new ConfirmDialog({
                title: '重新打开步骤',
                msg: `后面的 ${impact.join('、')} 都建立在 ${step.id} 之上，会一起改回未完成。代码文件不会改动。`,
                ok: '重新打开', cancel: '取消',
            }).open();
            if (!confirmed) { return; }
        }
        this.tutor.reopen(step.id);
    }

    private async resetProgress(): Promise<void> {
        const confirmed = await new ConfirmDialog({
            title: '重置进度', msg: '清除本机记录的完成状态、提示级别和学习记录？代码文件不会改动。', ok: '重置', cancel: '取消',
        }).open();
        if (confirmed) { this.tutor.resetProgress(); }
    }

    private renderStep(state: StepState): React.ReactNode {
        const { step, status } = state;
        const untested = this.tutor.untestedDependencies(step);
        const rules = step.rules.map(id => this.tutor.plan!.rules.find(rule => rule.id === id)).filter(rule => !!rule);
        return <section className="nodu-tutor-step" aria-labelledby="nodu-tutor-step-title">
            <div className="nodu-tutor-step-meta">
                <span className="scope-mono">{step.id}</span>
                <span className="nodu-tutor-tag">{STEP_KIND_LABELS[step.kind]}</span>
                {step.layer && <span className="nodu-tutor-tag">{LAYER_LABELS[step.layer]}</span>}
                {status === 'passed' && <span className="nodu-tutor-tag nodu-tutor-tag-done">已完成</span>}
            </div>
            <h3 id="nodu-tutor-step-title">{step.title}</h3>
            <p className="nodu-tutor-goal">{step.goal}</p>
            <p className="scope-helper"><strong>为什么现在做</strong> {step.why}</p>
            {untested.length > 0 && status !== 'passed' && <p className="nodu-tutor-warn" role="note">
                <i className="codicon codicon-warning" aria-hidden="true" />上游未验证：{untested.map(dep => `${dep.id}「${dep.title}」`).join('、')}还没有测试</p>}
            {step.kind === 'decide' ? this.renderDecision(step, status === 'passed') : <>
                {this.renderAnchor(step)}
                {step.hints && this.renderHints(step)}
            </>}
            {step.contract.length > 0 && <div className="nodu-tutor-block">
                <h4>完成条件 · 自查</h4>
                <ul className="nodu-tutor-contract">{step.contract.map((check, index) => <li key={index}>
                    <span className="nodu-tutor-tag">{CHECK_LABELS[check.type]}</span><span>{check.text}</span></li>)}</ul>
            </div>}
            {rules.length > 0 && <details className="nodu-tutor-rules">
                <summary>工程实践 · {rules.length}</summary>
                {rules.map(rule => <div key={rule!.id}><strong>{rule!.title}</strong><p>{rule!.why}</p></div>)}
            </details>}
            {step.kind !== 'decide' && <div className="nodu-tutor-actions">{status === 'passed'
                ? <button className="theia-button secondary" onClick={() => void this.reopen(step)}>重新打开</button>
                : <button className="theia-button" onClick={() => this.tutor.complete(step.id)}><i className="codicon codicon-check" aria-hidden="true" />完成这一步</button>}
            </div>}
        </section>;
    }

    private renderAnchor(step: TutorStep): React.ReactNode {
        const anchor = this.tutor.anchorStatus(step);
        if (anchor.kind === 'none' || !step.anchor) { return null; }
        const file = step.anchor.file;
        const open = (label: string): React.ReactNode => <button className="scope-text-button" onClick={() => this.run(TUTOR_COMMANDS.revealStep, step.id)}>
            <i className="codicon codicon-file-code" aria-hidden="true" /> {label}</button>;
        switch (anchor.kind) {
            case 'ok': return <div className="nodu-tutor-anchor">{open(`${file}:${anchor.line}`)}</div>;
            case 'closed': return <div className="nodu-tutor-anchor">{open(`打开 ${file}`)}</div>;
            case 'ambiguous': return <div className="nodu-tutor-anchor nodu-tutor-warn" role="note">
                <span>{file} 中有多处 {markerFor(step.id)}，请只保留一处</span>{open('打开文件')}</div>;
            case 'missing': return <div className="nodu-tutor-anchor nodu-tutor-warn" role="note">
                <span>{file} 中找不到 {markerFor(step.id)}，提示不会显示在编辑器里</span>
                <button className="scope-text-button" onClick={() => this.run(TUTOR_COMMANDS.insertMarker, step.id)}>在光标处放置标记</button></div>;
        }
    }

    private renderHints(step: TutorStep): React.ReactNode {
        const level = this.tutor.level(step.id);
        const max = maxHintLevel(step);
        const tabs = Array.from({ length: Math.min(PANEL_HINT_MAX, max) + 1 }, (_, index) => index as HintLevel);
        return <div className="nodu-tutor-block">
            <div className="nodu-tutor-levels" role="group" aria-label="提示级别">
                {tabs.map(index => <button key={index} aria-pressed={level === index} onClick={() => this.tutor.setLevel(step.id, index)}>
                    {`L${index} ${HINT_LEVEL_LABELS[index]}`}</button>)}
                {max >= REFERENCE_LEVEL && <button aria-pressed={level === REFERENCE_LEVEL}
                    onClick={() => { if (level !== REFERENCE_LEVEL) { void this.askReference(step); } }}>L3 参考实现</button>}
            </div>
            <div className="nodu-tutor-hints" aria-live="polite">{hintSections(step, level).map(section => <div key={section.level} className="nodu-tutor-hint">
                <div className="nodu-tutor-hint-label">{section.level === REFERENCE_LEVEL ? '参考实现 · 已记入学习记录' : section.label}</div>
                {section.level >= 2 ? <pre className="nodu-tutor-code" tabIndex={0}>{section.text}</pre> : <p>{section.text}</p>}
            </div>)}</div>
        </div>;
    }

    private renderDecision(step: TutorStep, decided: boolean): React.ReactNode {
        const chosen = this.tutor.decision(step.id);
        const draft = this.drafts.get(step.id) ?? chosen ?? step.options?.find(option => option.available)?.id;
        return <div className="nodu-tutor-block">
            <fieldset className="nodu-tutor-options" disabled={decided}>
                <legend className="scope-visually-hidden">{step.title}</legend>
                {step.options?.map(option => <label key={option.id} className={`scope-target${draft === option.id ? ' scope-target-selected' : ''}`}>
                    <input type="radio" name={`nodu-tutor-${step.id}`} value={option.id} checked={draft === option.id} disabled={!option.available}
                        onChange={() => { this.drafts.set(step.id, option.id); this.update(); }} />
                    <span><strong>{option.label}{!option.available && ' · 暂无步骤'}</strong>{option.note && <span>{option.note}</span>}</span>
                </label>)}
            </fieldset>
            <div className="nodu-tutor-actions">{decided
                ? <button className="theia-button secondary" onClick={() => void this.reopen(step)}>重新选择</button>
                : <button className="theia-button" disabled={!draft} onClick={() => draft && this.tutor.decide(step.id, draft)}>确定方案</button>}
            </div>
        </div>;
    }

    private renderListItem(state: StepState, isCurrent: boolean): React.ReactNode {
        const { step, status } = state;
        const blocking = status === 'locked' ? this.tutor.blockingDependencies(step).map(dep => dep.id).join('、') : '';
        const icon = status === 'passed' ? 'codicon-pass-filled' : status === 'locked' ? 'codicon-lock' : isCurrent ? 'codicon-circle-filled' : 'codicon-circle-large-outline';
        return <li key={step.id}>
            <button className={`nodu-tutor-item nodu-tutor-${status}`} aria-current={isCurrent ? 'step' : undefined} disabled={status === 'locked'}
                title={blocking ? `先完成 ${blocking}` : undefined} onClick={() => this.tutor.select(step.id)}>
                <i className={`codicon ${icon}`} aria-hidden="true" />
                <span className="nodu-tutor-item-id scope-mono">{step.id}</span>
                <span className="nodu-tutor-item-title">{step.title}</span>
                <span className="nodu-tutor-tag">{STEP_KIND_LABELS[step.kind]}</span>
                {state.unverified && status !== 'passed' && <span className="nodu-tutor-tag nodu-tutor-tag-warn">上游未验证</span>}
                {this.tutor.viewedReference(step.id) && <span className="nodu-tutor-tag">看过参考</span>}
                <span className="scope-visually-hidden">{status === 'passed' ? '已完成' : status === 'locked' ? `未解锁，先完成 ${blocking}` : ''}</span>
            </button>
        </li>;
    }
}

@injectable()
export class NoduTutorViewContribution extends AbstractViewContribution<NoduTutorWidget> implements FrontendApplicationContribution, TabBarToolbarContribution {
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    constructor() {
        // Right area, before 帧缓冲: the vision toggle stays the rightmost control.
        super({ widgetId: NoduTutorWidget.ID, widgetName: NoduTutorWidget.LABEL, defaultWidgetOptions: { area: 'right', rank: 50 } });
    }

    /** Runs after the workbench applied its layout, so the startup collapse does not hide the panel again. */
    async onDidInitializeLayout(): Promise<void> {
        await this.tutor.ready;
        if (this.tutor.isFresh()) {
            await this.openView({ reveal: true, activate: false });
            this.tutor.markSeen();
        }
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        const hasPlan = (): boolean => !!this.tutor.plan;
        commands.registerCommand({ id: TUTOR_COMMANDS.openPanel, label: NoduTutorWidget.LABEL, category: '见微 Nodu' }, {
            execute: () => this.openView({ reveal: true, activate: true }),
            isEnabled: hasPlan, isVisible: hasPlan,
        });
        commands.registerCommand({ id: TUTOR_COMMANDS.togglePanel, label: NoduTutorWidget.LABEL, category: '见微 Nodu' }, {
            execute: () => this.openView({ toggle: true, activate: true }),
            isEnabled: hasPlan, isVisible: hasPlan, isToggled: () => this.tutor.panelVisible,
        });
    }

    /** The side panel's own title row carries the hint toggle, so the panel draws no second header. */
    registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
        toolbar.registerItem({
            id: 'nodu.tutor.panel-toggle-hints',
            command: TUTOR_COMMANDS.toggleHints,
            icon: () => `codicon ${this.tutor.hintsVisible ? 'codicon-eye' : 'codicon-eye-closed'}`,
            tooltip: '显示 / 隐藏编辑器内代码提示 · Ctrl / ⌘ K, H',
            isVisible: widget => widget instanceof NoduTutorWidget && !!this.tutor.plan,
            onDidChange: this.tutor.onDidChange,
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.VIEW_LAYOUT, { commandId: TUTOR_COMMANDS.togglePanel, order: '0_nodu_5' });
        menus.registerMenuAction(CommonMenus.VIEW_LAYOUT, { commandId: TUTOR_COMMANDS.toggleHints, order: '0_nodu_6' });
    }
}
