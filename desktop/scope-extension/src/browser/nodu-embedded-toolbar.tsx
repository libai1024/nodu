// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { ChipMark } from './nodu-project-icon';
import { ActionIcon } from './nodu-minimal-action';
import { NoduEmbeddedModel } from './nodu-embedded-model';
import { NoduCDevicePanel } from './nodu-embedded-device';
import { C_COMMANDS } from './nodu-embedded-commands';

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
    settingsButton?: React.ReactNode;
    moreButton?: React.ReactNode;
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
    const toggleDevice = (): void => {
        const next = !props.deviceOpen;
        props.setDeviceOpen(next);
        if (next) { void model.refreshDevices(); void model.loadBackups(); }
    };
    return <header className="nodu-professional-bar nodu-c-toolbar" aria-label="Nodu 工具栏">
        <div className="scope-device-picker">
            <button className={`scope-action scope-device-chip nodu-chip-${chip}`} aria-label={`开发板与下载器，${shortBoard}，${chipText}`} aria-haspopup="dialog" aria-controls="scope-device-popover" aria-expanded={props.deviceOpen} aria-pressed={props.deviceOpen} onClick={toggleDevice} title={model.lastError?.message || `${project.chip.name}，${chipText}`}>
                <span className="scope-status-dot" aria-hidden="true"/><ChipMark tag={project.chip.name}/><span className="scope-device-chip-board">{shortBoard}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/>
            </button>
            {!props.externalDevicePanel && <div id="scope-device-popover" className="scope-device-popover scope-widget" role="dialog" aria-label="开发板与下载" hidden={!props.deviceOpen}>
                <NoduCDevicePanel exec={id => { props.setDeviceOpen(false); exec(id); }} model={model} simple={simple} confirm={props.confirm} showOutput={() => { props.setDeviceOpen(false); exec(C_COMMANDS.showOutput); }} />
            </div>}
        </div>
        <div className="nodu-pro-actions" role="group" aria-label="编译与烧录">
            <button className="nodu-pro-action" data-action="build" aria-label="编译" disabled={model.busy || !!model.awaitUser} aria-busy={model.building || undefined} onClick={() => exec(C_COMMANDS.build)} title="编译（Ctrl / ⌘ B）">
                {model.building ? <i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"/> : <ActionIcon action="build"/>}
            </button>
            <button className="nodu-pro-action" data-action="flash" aria-label="烧录" disabled={model.busy || !!model.awaitUser} onClick={() => exec(C_COMMANDS.flash)} title="烧录现有构建"><ActionIcon action="flash"/></button>
            <button className="nodu-pro-action" data-action="run" aria-label="运行（编译并烧录）" disabled={model.busy || !!model.awaitUser} aria-busy={model.flashing || undefined} onClick={() => exec(C_COMMANDS.run)} title="运行：编译并烧录（Ctrl / ⌘ R）"><ActionIcon action="build-flash"/></button>
            <button className="nodu-pro-action nodu-pro-stop" aria-label="停止" disabled={model.savingOptions || (!model.busy && !model.awaitUser)} onClick={() => exec(C_COMMANDS.stop)} title={model.flashSteps.program === 'running' ? '写入完成后停止' : '停止'}><ActionIcon action="build-flash" stop/></button>
        </div>
        {props.tutorButton}
        {props.moreButton}
        {props.settingsButton}
        <span role="status" aria-live="polite" className="scope-visually-hidden">{model.task?.text}</span>
        <BootGuide model={model} exec={exec} />
    </header>;
}
