// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import type { TutorGoalRequest } from '../common/tutor/tutor-goal';
import type { NoduTutorModel } from './nodu-tutor-model';

export interface TutorTaskWindowProps {
    tutor: NoduTutorModel;
    narrow: boolean;
    prepare(): void;
    open(path: string, line: number): void;
    openPanel(): void;
    move?(dx: number, dy: number): void;
}
const Icon = ({ name }: { name: string }): React.ReactElement => <i className={`codicon codicon-${name}`} aria-hidden="true" />;
/** A view of the existing teaching state; this component never awards completion. */
export function TutorTaskWindow({ tutor, narrow, prepare, open, openPanel, move }: TutorTaskWindowProps): React.ReactElement {
    const [collapsed, collapse] = React.useState(narrow);
    const [all, showAll] = React.useState(false);
    const [editing, edit] = React.useState(false);
    const [menu, showMenu] = React.useState(false);
    const [adding, add] = React.useState(false);
    const [prompt, setPrompt] = React.useState('');
    const [removeId, remove] = React.useState<string>();
    const [ending, end] = React.useState(false);
    const section = React.useRef<HTMLElement>(null);
    const header = React.useRef<HTMLButtonElement>(null);
    const drag = React.useRef<{ x: number; y: number } | undefined>(undefined);
    const state = tutor.goalState;
    const dynamic = !['none', 'cancelled'].includes(state.status);
    const course = tutor.plan;
    const current = dynamic ? state.current : Math.max(0, course?.steps.findIndex(s => s.id === tutor.currentStep()?.id) ?? 0);
    const steps = dynamic ? state.steps : (course?.steps ?? []).map(s => ({ ...s, path: s.anchors[0]?.path ?? '' }));
    const done = dynamic ? state.current : steps.filter(s => tutor.progress.steps[s.id]).length;
    const complete = dynamic ? state.status === 'complete' : done === steps.length;
    const paused = dynamic && state.status === 'paused';
    const busy = !!tutor.busy;
    const title = (dynamic ? state.title : course?.title) ?? '教学任务';
    const taskKey = `${tutor.workspaceId}:${state.goal ?? course?.contentHash ?? ''}`;
    React.useEffect(() => { edit(false); showMenu(false); add(false); remove(undefined); end(false); setPrompt(''); }, [taskKey]);
    React.useEffect(() => { if (narrow) { collapse(true); } }, [narrow]);
    const restoreFocus = (): void => { header.current?.focus(); };
    React.useEffect(() => {
        const selector = removeId || ending ? '.nodu-task-decision button' : adding ? 'textarea' : menu ? '.nodu-task-menu button' : editing ? '.nodu-task-list button[aria-label^="删除"]' : undefined;
        if (selector) { section.current?.querySelector<HTMLElement>(selector)?.focus(); }
    }, [removeId, ending, adding, menu, editing]);
    const action = async (kind: TutorGoalRequest['action'], anchor?: HTMLButtonElement): Promise<void> => {
        const workspace = tutor.workspaceId;
        await tutor.goalAction(kind);
        if (workspace === tutor.workspaceId) { requestAnimationFrame(() => { if (anchor?.isConnected && !anchor.disabled) { anchor.focus(); } else { restoreFocus(); } }); }
    };
    const closeLayer = (): void => {
        if (removeId) { remove(undefined); } else if (ending) { end(false); } else if (adding) { add(false); }
        else if (menu) { showMenu(false); } else if (editing) { edit(false); } else { collapse(true); }
        restoreFocus();
    };
    const submit = async (): Promise<void> => {
        if (!prompt.trim() || busy) { return; }
        const revision = state.revision, workspace = tutor.workspaceId;
        await tutor.goalAction('add', prompt.trim());
        if (tutor.workspaceId === workspace && tutor.goalState.revision > revision && !tutor.error) { setPrompt(''); add(false); restoreFocus(); }
    };
    return <section ref={section} className={`nodu-task-window${collapsed ? ' is-collapsed' : ''}`} aria-label="教学任务" onKeyDown={e => {
        e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); closeLayer(); }
    }} onPointerDown={e => e.stopPropagation()}>
        <header className="nodu-task-head">
            {!narrow && move && <button className="nodu-task-grip" aria-label="移动任务窗" title="拖动移动，方向键微调" onPointerDown={e => { e.preventDefault(); e.currentTarget.focus(); drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture(e.pointerId); }}
                onPointerMove={e => { if (drag.current) { move(e.clientX - drag.current.x, e.clientY - drag.current.y); drag.current = { x: e.clientX, y: e.clientY }; } }}
                onPointerUp={e => { drag.current = undefined; e.currentTarget.releasePointerCapture(e.pointerId); }} onLostPointerCapture={() => { drag.current = undefined; }}
                onKeyDown={e => { const delta: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }; if (delta[e.key]) { e.preventDefault(); move(...delta[e.key]); } }}><Icon name="gripper" /></button>}
            <button ref={header} className="nodu-task-title" title={title} aria-expanded={!collapsed} onClick={() => collapse(!collapsed)}>
                <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} /><span>{title}</span>
            </button>
            <button className="nodu-task-count" title={all ? '显示相邻步骤' : '显示全部步骤'} aria-label={`已检查 ${done} / ${steps.length} 步`} aria-pressed={all}
                onClick={() => { showAll(!all); collapse(false); }}>{done}/{steps.length}</button>
            <button className="nodu-task-icon" aria-label="任务操作" aria-expanded={menu} onClick={() => { showMenu(!menu); collapse(false); }}><Icon name="ellipsis" /></button>
        </header>
        {!collapsed && <>
            {menu && <div className="nodu-task-menu" aria-label="任务操作">
                {dynamic && <><button disabled={busy || state.steps.length >= 24} onClick={() => { add(true); showMenu(false); }}>添加步骤</button>
                    <button disabled={busy || complete || state.status === 'draft'} onClick={() => { edit(!editing); showMenu(false); showAll(true); }}>编辑步骤</button></>}
                <button onClick={() => { openPanel(); showMenu(false); }}>打开对话</button>
                <button onClick={() => tutor.setDisplay('floatVisible', false)}>隐藏任务窗</button>
                {dynamic && !complete && <button disabled={busy} onClick={() => { end(true); showMenu(false); }}>结束任务</button>}
            </div>}
            <ol className="nodu-task-list" aria-label="任务步骤">
                {steps.map((step, index) => {
                    if (!all && !editing && steps.length > 4 && index !== current && index !== current - 1 && index !== current + 1 && !(complete && index >= steps.length - 3)) { return null; }
                    const passed = dynamic ? index < current : !!tutor.progress.steps[step.id];
                    const active = index === current && !complete;
                    const checking = active && tutor.busy?.goal === 'check';
                    const verdict = active ? state.verdict : undefined;
                    const label = passed ? (dynamic ? '代码已检查' : '已自查') : checking ? '检查中' : active && paused ? '已暂停' : active && verdict === 'needs-work' ? '待修改' : active && verdict === 'context' ? '待补上下文' : active ? '当前步骤' : '未开始';
                    return <li key={step.id} className={`${active ? 'is-current' : ''} ${passed ? 'is-done' : ''}`} aria-current={active ? 'step' : undefined}>
                        <span className={`nodu-task-state${checking ? ' is-checking' : ''}`} title={label} aria-label={label}><Icon name={passed ? 'check' : checking ? 'loading' : active && paused ? 'debug-pause' : active && verdict === 'needs-work' ? 'warning' : active && verdict === 'context' ? 'question' : active ? 'circle-filled' : 'circle-outline'} /></span>
                        <button className="nodu-task-step" title={`${step.goal}\n${step.path}`} disabled={!step.path} onClick={() => open(step.path, active ? state.fragment?.answer.guidance?.anchorLine ?? 1 : 1)}>{step.title}</button>
                        {!editing && step.path && <button className="nodu-task-icon nodu-task-file" title={`打开 ${step.path}`} aria-label={`打开 ${step.path}：${step.title}`} onClick={() => open(step.path, active ? state.fragment?.answer.guidance?.anchorLine ?? 1 : 1)}><Icon name="go-to-file" /></button>}
                        {editing && dynamic && !passed && <button className="nodu-task-icon" aria-label={`删除 ${step.title}`} disabled={busy || steps.length - current <= 1} onClick={() => remove(step.id)}><Icon name="close" /></button>}
                    </li>;
                })}
            </ol>
            {removeId && <div className="nodu-task-decision"><span>移除“{steps.find(s => s.id === removeId)?.title}”？源码保留。</span><div>
                <button className="scope-text-button" disabled={busy} onClick={async () => { await tutor.goalAction('remove', undefined, undefined, removeId); remove(undefined); restoreFocus(); }}>移除</button>
                <button className="scope-text-button" onClick={() => { remove(undefined); restoreFocus(); }}>取消</button></div></div>}
            {ending && <div className="nodu-task-decision"><span>结束当前教学？源码保留。</span><div><button className="scope-text-button" disabled={busy} onClick={() => void tutor.goalAction('cancel')}>结束</button><button className="scope-text-button" onClick={() => { end(false); restoreFocus(); }}>取消</button></div></div>}
            {adding && <form className="nodu-task-add" onSubmit={e => { e.preventDefault(); void submit(); }}>
                <textarea aria-label="新增步骤内容" placeholder="要增加的功能" maxLength={1200} rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} disabled={busy} />
                <div><button className="scope-text-button" type="submit" disabled={busy || !prompt.trim() || !tutor.configured}>{tutor.busy?.goal === 'add' ? '生成中' : '生成步骤'}</button><button type="button" className="scope-text-button" onClick={() => { add(false); restoreFocus(); }}>取消</button></div>
            </form>}
            {tutor.error && <div className="nodu-task-error" role="alert">{tutor.error}</div>}
            {state.removed && <div className="nodu-task-undo"><span>已移除步骤</span><button className="scope-text-button" disabled={busy} onClick={e => void action('undo-remove', e.currentTarget)}>撤销</button></div>}
            <footer className="nodu-task-foot">
                {complete ? <span>{dynamic ? '代码跟写完成' : '课程已自查'}</span> : state.status === 'draft' && dynamic ? <button className="scope-text-button" onClick={openPanel}>确认计划</button> : <>
                    <button className="scope-text-button" disabled={busy || paused} onClick={e => {
                        if (!dynamic) { void tutor.send('step'); }
                        else if (!state.fragment || tutor.buffer?.path !== state.steps[state.current]?.path) { prepare(); }
                        else { void action('check', e.currentTarget); }
                    }}>{tutor.busy?.goal === 'check' ? '检查中' : dynamic && (!state.fragment || tutor.buffer?.path !== state.steps[state.current]?.path) ? '继续跟写' : '检查当前步骤'}</button>
                    {dynamic && <button className="scope-text-button" disabled={busy} onClick={e => void action(paused ? 'resume' : 'pause', e.currentTarget)}>{paused ? '继续' : '暂停'}</button>}
                </>}
                {editing && <button className="scope-text-button" onClick={() => { edit(false); restoreFocus(); }}>完成编辑</button>}
            </footer>
        </>}
    </section>;
}
