// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { SerialPortInfo } from '../common/nodu-device-protocol';
import { BOARD_FAMILIES, BoardFamilyId, BoardPreset, boardPorts, familyById, presetsIn, resolvePort, shortPortName } from '../common/nodu-board-presets';
import { NoduDeviceModel } from './nodu-device-client';

interface Props { model: NoduDeviceModel; onConnected?: () => void; showBoardGuide?: () => void; }

/**
 * Simple-mode device picker: chip family, then the board on the desk, and it connects.
 * With a remembered board it opens on that family's boards (one click to reconnect).
 * The port is chosen automatically when only one USB serial device is
 * present (or the remembered one is); otherwise a second step lists them.
 * Nothing here connects without a click: connecting resets a K210.
 */
export function NoduBoardPicker({ model, onConnected, showBoardGuide }: Props): React.ReactElement {
    // undefined: follow the remembered board's family; null: the user went back to the family list.
    const [familyChoice, setFamilyChoice] = React.useState<BoardFamilyId | null | undefined>();
    const [choosing, setChoosing] = React.useState<BoardPreset | undefined>();
    const [showAll, setShowAll] = React.useState(false);
    const [target, setTarget] = React.useState<string | undefined>();
    const { state } = model;
    const connecting = state.phase === 'connecting' || (model.busy && model.pending === '连接设备');
    const blocked = model.busy || model.flashing;

    const connect = async (preset: BoardPreset, port: SerialPortInfo): Promise<void> => {
        setTarget(preset.id);
        try {
            await model.connectPreset(preset, port);
            if (model.connected) { setChoosing(undefined); setShowAll(false); onConnected?.(); }
        } finally { setTarget(undefined); }
    };
    const pick = async (preset: BoardPreset): Promise<void> => {
        if (blocked || model.connected) { return; }
        setTarget(preset.id);
        try { await model.scanPorts(); } finally { setTarget(undefined); }
        const port = resolvePort(boardPorts(model.ports), model.remembered);
        if (port) { await connect(preset, port); return; }
        setShowAll(false);
        setChoosing(preset);
    };

    if (model.connected) {
        const board = model.connectedPreset?.label ?? model.boardLabel;
        return <div className="nodu-picker-connected">
            <div className="nodu-picker-current"><i className="codicon codicon-circuit-board" aria-hidden="true" /><span><strong>{board}</strong><span className="scope-mono">{shortPortName(state.port || '')}</span></span></div>
            <div className="scope-device-actions">
                <button className="theia-button secondary" disabled={model.flashing} onClick={() => void model.disconnect()}>断开</button>
                {showBoardGuide && <button className="theia-button secondary" onClick={showBoardGuide} title="查看板端配置声明与引脚资料">认识开发板</button>}
            </div>
        </div>;
    }

    if (choosing) {
        const candidates = boardPorts(model.ports);
        const listed = showAll ? model.ports : candidates;
        const hidden = model.ports.length - candidates.length;
        return <div className="nodu-picker" aria-label={`为 ${choosing.label} 选择串口`}>
            <div className="nodu-picker-step">
                <button className="scope-text-button" onClick={() => setChoosing(undefined)} disabled={connecting}><i className="codicon codicon-arrow-left" aria-hidden="true" />{familyById(choosing.family)?.label ?? ''} 开发板</button>
                <span>{choosing.label}</span>
            </div>
            {listed.length === 0
                ? <p className="nodu-picker-empty">未检测到 USB 串口。请用数据线连接开发板，然后重新扫描。</p>
                : <>
                    <p className="nodu-picker-hint">{candidates.length > 1 && !showAll ? '检测到多个 USB 串口，选择开发板所在的一个：' : '选择串口：'}</p>
                    <ul className="nodu-picker-list">{listed.map(port => <li key={port.path}>
                        <button className="nodu-picker-item" disabled={blocked} aria-busy={target === choosing.id || undefined} onClick={() => void connect(choosing, port)}>
                            <i className="codicon codicon-plug" aria-hidden="true" />
                            <span className="nodu-picker-label">{shortPortName(port.path)}</span>
                            <span className="nodu-picker-meta">{port.description}</span>
                            {model.remembered?.port === port.path && <span className="nodu-picker-tag">上次使用</span>}
                        </button>
                    </li>)}</ul>
                </>}
            <div className="scope-device-actions">
                <button className="theia-button secondary" disabled={blocked} onClick={() => void model.scanPorts()}><i className="codicon codicon-refresh" aria-hidden="true" />重新扫描</button>
                {!showAll && hidden > 0 && <button className="scope-text-button" onClick={() => setShowAll(true)} title="蓝牙、调试控制台等非 USB 串口">显示全部串口（另有 {hidden} 个）</button>}
                {connecting && <button className="theia-button secondary" onClick={() => void model.disconnect()}>取消</button>}
            </div>
        </div>;
    }

    const last = model.rememberedPreset;
    const family = familyById(familyChoice === undefined ? last?.family : familyChoice ?? undefined);
    if (!family?.available) {
        return <div className="nodu-picker" aria-label="选择芯片系列">
            <p className="nodu-picker-hint">先选择开发板使用的芯片系列。</p>
            <ul className="nodu-picker-list">{BOARD_FAMILIES.map(entry => {
                const count = presetsIn(entry.id).length;
                return <li key={entry.id}>
                    <button className="nodu-picker-item nodu-picker-family" disabled={!entry.available} onClick={() => setFamilyChoice(entry.id)}
                        title={entry.available ? undefined : `${entry.label} 支持${entry.status ?? '尚未完成'}，暂不能连接`}>
                        <i className="codicon codicon-chip" aria-hidden="true" />
                        <span className="nodu-picker-label"><strong>{entry.label}</strong><span>{entry.detail}</span></span>
                        <span className="nodu-picker-meta">{entry.available ? `${count} 款开发板` : entry.status}</span>
                        {entry.available && <i className="codicon codicon-chevron-right" aria-hidden="true" />}
                    </button>
                </li>;
            })}</ul>
        </div>;
    }

    const boards = presetsIn(family.id);
    const presets = last && last.family === family.id ? [last, ...boards.filter(preset => preset !== last)] : boards;
    return <div className="nodu-picker" aria-label={`选择 ${family.label} 开发板`}>
        <div className="nodu-picker-step">
            <button className="scope-text-button" onClick={() => setFamilyChoice(null)} disabled={connecting}><i className="codicon codicon-arrow-left" aria-hidden="true" />芯片系列</button>
            <span>{family.label}</span>
        </div>
        <p className="nodu-picker-hint">选择桌上的开发板，Nodu 会找到它的串口并连接。连接时开发板会复位。</p>
        <ul className="nodu-picker-list">{presets.map(preset => <li key={preset.id}>
            <button className="nodu-picker-item" disabled={blocked} aria-busy={target === preset.id || undefined} onClick={() => void pick(preset)}>
                <i className={`codicon ${target === preset.id ? 'codicon-loading codicon-modifier-spin' : 'codicon-circuit-board'}`} aria-hidden="true" />
                <span className="nodu-picker-label">{preset.label}</span>
                {preset === last && <span className="nodu-picker-tag">上次使用</span>}
            </button>
        </li>)}</ul>
        {connecting && <div className="scope-device-actions"><button className="theia-button secondary" onClick={() => void model.disconnect()}>取消</button></div>}
    </div>;
}
