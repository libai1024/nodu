// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { NoduBrand } from './scope-brand';
import { NoduEmbeddedModel } from './nodu-embedded-model';
import { NoduCDevicePanel } from './nodu-embedded-device';
import { C_COMMANDS, NODU_C_RUN_MENU } from './nodu-embedded-commands';

export interface CToolbarProps {
    model: NoduEmbeddedModel;
    simple: boolean;
    project: string;
    deviceOpen: boolean;
    filesVisible: boolean;
    panelVisible: boolean;
    rightVisible: boolean;
    setDeviceOpen(open: boolean): void;
    exec(id: string): void;
    openMenu(path: string[], anchor: HTMLElement): void;
    projectMenu: string[];
    moreMenu: string[];
    confirm(title: string, message: string, ok: string): Promise<boolean>;
    /** Teaching-step toggle when the project has a tutor plan. */
    tutorButton?: React.ReactNode;
    externalDevicePanel?: boolean;
}

const STEP_ICON: Record<string, string> = { done: 'pass', running: 'loading codicon-modifier-spin', failed: 'error', pending: 'circle-large-outline' };

function TaskStrip({ model, exec, setDeviceOpen }: Pick<CToolbarProps, 'model' | 'exec' | 'setDeviceOpen'>): React.ReactElement | null {
    const task = model.task;
    if (!task) { return <span role="status" aria-live="polite" className="scope-visually-hidden" />; }
    const open = (): void => {
        if (task.target === 'problems') { exec(C_COMMANDS.showProblems); }
        else if (task.target === 'monitor') { exec(C_COMMANDS.showMonitor); }
        else if (task.target === 'device') { setDeviceOpen(true); }
        else { exec(C_COMMANDS.showOutput); }
    };
    const icon = task.tone === 'busy' ? 'loading codicon-modifier-spin' : task.tone === 'ok' ? 'pass' : task.tone === 'warn' ? 'warning' : 'error';
    return <button className={`nodu-c-task nodu-c-task-${task.tone}`} onClick={open} title={task.text} aria-busy={task.tone === 'busy' || undefined}>
        <span role="status" aria-live="polite" className="nodu-c-task-text">
            {task.steps ? <span className="nodu-c-steps">
                {task.steps.map(step => <span key={step.id} className={`nodu-c-step nodu-c-step-${step.state}`}>
                    <i className={`codicon codicon-${STEP_ICON[step.state] ?? STEP_ICON.pending}`} aria-hidden="true"/>{step.label}
                    <span className="scope-visually-hidden">{step.state === 'done' ? '完成' : step.state === 'running' ? '进行中' : '未开始'}</span>
                </span>)}
                <span className="nodu-c-step-now">{task.text}</span>
            </span> : <><i className={`codicon codicon-${icon}`} aria-hidden="true"/><span>{task.text}</span></>}
        </span>
    </button>;
}

/** Serial ISP guide card (UI-DESIGN §8.3): enter the ROM bootloader, then leave it. */
export function BootGuide({ model, exec }: Pick<CToolbarProps, 'model' | 'exec'>): React.ReactElement | null {
    const project = model.project;
    if (!project || !model.awaitUser) { return null; }
    const enter = model.awaitUser === 'enterBoot';
    return <div className="nodu-c-guide" role="dialog" aria-label={enter ? '进入串口下载模式' : '恢复正常启动'} aria-live="polite">
        <h3><i className={`codicon codicon-${enter ? 'debug-step-into' : 'debug-step-out'}`} aria-hidden="true"/>{enter ? '进入串口下载模式' : '恢复正常启动'}</h3>
        {enter ? <ol>
            <li>把 <strong>BOOT0</strong> 跳线接到 <strong>1</strong>（BOOT1 保持 0）。</li>
            <li>按一下开发板上的<strong>复位键</strong>。</li>
        </ol> : <ol>
            <li>把 <strong>BOOT0</strong> 接回 <strong>0</strong>。</li>
            <li>按一下<strong>复位键</strong>。</li>
        </ol>}
        {enter && <p className="nodu-c-muted">等待芯片应答</p>}
        <div className="nodu-c-guide-actions">
            {enter ? <button className="theia-button secondary" onClick={() => exec(C_COMMANDS.stop)}>停止</button>
                : <button className="theia-button main" onClick={() => exec(C_COMMANDS.finishBoot)}>已复位</button>}
        </div>
    </div>;
}

/** Toolbar for STM32 C projects (UI-DESIGN §3): 编译 is separate from 运行 so it works without a board. */
export function NoduCToolbar(props: CToolbarProps): React.ReactElement {
    const { model, simple, exec } = props;
    const project = model.project!;
    const method = project.flashMethod;
    const shortBoard = project.board.name.replace(/^正点原子\s*/, '').replace(/最小系统板$/, '');
    const probe = model.probes.find(p => p.serial === model.probe) ?? model.probes[0];
    const port = model.monitorPort.replace(/^\/dev\/(cu\.|tty\.)?/, '');
    let chip: 'disconnected' | 'connecting' | 'connected' | 'error' | 'writing' = 'disconnected';
    let chipText = method === 'stlink' ? (probe ? 'ST-LINK' : '未检测到下载器') : (port || '未选择串口');
    if (model.flashing && (model.flashSteps.program === 'running' || model.flashSteps.verify === 'running')) { chip = 'writing'; chipText = '写入中，请勿断电'; }
    else if (model.busy) { chip = 'connecting'; chipText = model.building ? chipText : '检测中'; }
    else if (model.lastError && !model.flashing && ['wrongChip', 'noProbe', 'noPower', 'noTarget', 'romTimeout', 'portBusy', 'portOpen'].includes(model.lastError.code)) { chip = 'error'; }
    else if (model.identity && model.identity.matches) { chip = 'error'; chipText = '芯片不一致'; }
    else if (method === 'stlink' ? !!probe : !!port) { chip = 'connected'; }
    const errors = model.errors.length;
    const running = model.flashing;
    const toggleDevice = (): void => {
        const next = !props.deviceOpen;
        props.setDeviceOpen(next);
        if (next) { void model.refreshDevices(); void model.loadBackups(); }
    };
    return <header className="scope-workspace-bar nodu-c-toolbar" aria-label="Nodu 工具栏">
        <div className="scope-toolbar-start">
            <NoduBrand />
            <button className="scope-action nodu-toolbar-project" aria-label={`项目菜单，${props.project}`} aria-haspopup="menu" title="新建、打开与最近的项目" onClick={event => props.openMenu(props.projectMenu, event.currentTarget)}><i className="codicon codicon-folder" aria-hidden="true"/><span className="nodu-toolbar-project-name">{props.project}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
            <button className="scope-action nodu-c-build" disabled={model.flashing} aria-busy={model.building || undefined} onClick={() => exec(C_COMMANDS.build)} title="编译（Ctrl / ⌘ B）">
                <i className={`codicon ${model.building ? 'codicon-loading codicon-modifier-spin' : 'codicon-tools'}`} aria-hidden="true"/>{model.building ? '编译中' : '编译'}
            </button>
            <div className="nodu-run-split" role="group" aria-label="运行">
                <button className={`scope-action scope-action-primary scope-toolbar-run${running ? ' nodu-is-running' : ''}`} disabled={model.busy} aria-busy={running || undefined} onClick={() => exec(C_COMMANDS.run)} title="编译并下载（Ctrl / ⌘ R）">
                    <i className={`codicon ${running ? 'codicon-loading codicon-modifier-spin' : 'codicon-play'}`} aria-hidden="true"/>{running ? '下载中' : '运行'}
                </button>
                <button className="scope-action scope-action-primary nodu-run-more" aria-label="更多运行方式" aria-haspopup="menu" title="下载方式、复位开发板、重新编译" onClick={event => props.openMenu(NODU_C_RUN_MENU, event.currentTarget)}><i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
            </div>
            <button className={`scope-action scope-toolbar-icon nodu-toolbar-stop${model.busy || model.awaitUser ? ' nodu-stop-active' : ''}`} aria-label="停止" disabled={!model.busy && !model.awaitUser} onClick={() => exec(C_COMMANDS.stop)} title={model.flashSteps.program === 'running' ? '写入完成后停止' : '停止'}><i className="codicon codicon-debug-stop" aria-hidden="true"/></button>
            <div className="scope-device-picker">
                <button className={`scope-action scope-device-chip nodu-chip-${chip}`} aria-label={`开发板与下载器，${shortBoard}，${chipText}`} aria-haspopup="dialog" aria-controls="scope-device-popover" aria-expanded={props.deviceOpen} aria-pressed={props.deviceOpen} onClick={toggleDevice} title={model.lastError?.message || project.chip.name}>
                    <span className="scope-status-dot" aria-hidden="true"/><span className="scope-device-chip-board">{shortBoard}</span><span className="scope-device-chip-port">{chipText}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/>
                </button>
                {!props.externalDevicePanel && <div id="scope-device-popover" className="scope-device-popover scope-widget" role="dialog" aria-label="开发板与下载" hidden={!props.deviceOpen}>
                    <NoduCDevicePanel exec={id => { props.setDeviceOpen(false); exec(id); }} model={model} simple={simple} confirm={props.confirm} showOutput={() => { props.setDeviceOpen(false); exec(C_COMMANDS.showOutput); }} />
                </div>}
            </div>
        </div>
        <div className="scope-toolbar-center"><TaskStrip model={model} exec={exec} setDeviceOpen={props.setDeviceOpen} /></div>
        <div className="scope-toolbar-end">
            <button className="scope-action scope-toolbar-icon scope-toolbar-files" aria-label="文件列表" aria-pressed={props.filesVisible} onClick={() => exec('scope.toggle-files')} title={props.filesVisible ? '隐藏文件列表' : '显示文件列表'}><i className={`codicon codicon-layout-sidebar-left${props.filesVisible ? '' : '-off'}`} aria-hidden="true"/></button>
            <button className={`scope-action scope-toolbar-icon nodu-c-panel-toggle${errors ? ' nodu-has-error' : ''}`} aria-label={`STM32 开发面板${errors ? `，${errors} 个错误` : ''}`} aria-pressed={props.panelVisible} onClick={() => exec(C_COMMANDS.togglePanel)} title={props.panelVisible ? '收起 STM32 开发面板' : '显示 STM32 开发面板'}>
                <i className={`codicon codicon-layout-panel${props.panelVisible ? '' : '-off'}`} aria-hidden="true"/>{errors ? <span className="nodu-c-badge" aria-hidden="true">{errors > 99 ? '99+' : errors}</span> : null}
            </button>
            {!simple && <button className="scope-action scope-toolbar-icon scope-toolbar-right" aria-label="右侧栏" aria-pressed={props.rightVisible} onClick={() => exec('scope.toggle-right')} title={props.rightVisible ? '隐藏右侧栏' : '显示右侧栏'}><i className={`codicon codicon-layout-sidebar-right${props.rightVisible ? '' : '-off'}`} aria-hidden="true"/></button>}
            {props.tutorButton}
            <span className="scope-toolbar-divider" aria-hidden="true"/>
            <button className="scope-action scope-toolbar-icon nodu-toolbar-more" aria-label={`更多，当前${simple ? '简洁' : '专业'}模式`} aria-haspopup="menu" title="主题、布局模式与设置" onClick={event => props.openMenu(props.moreMenu, event.currentTarget)}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>
        </div>
        <BootGuide model={model} exec={exec} />
    </header>;
}
