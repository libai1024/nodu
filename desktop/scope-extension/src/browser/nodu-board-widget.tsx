// SPDX-License-Identifier: MIT
// 认识开发板：board-side config declaration, catalog pin reference and the
// Embedfire illustrative model. Everything here is declaration or reference —
// nothing is measured from hardware, and browsing never writes the board.
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandService, MenuModelRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { NoduDeviceModel } from './nodu-device-client';
import { ScopeLayoutState } from './scope-layout-state';
import { BoardInspection, boardPinSample } from '../common/nodu-board-info';
import { BOARD_DEFINITIONS, BoardDefinition, ConnectorDefinition, EMBEDFIRE_CONNECTORS } from '../common/nodu-board-data';
import boardTopUrl from '../../resources/boards/embedfire-cam-top.png';
import boardAngledUrl from '../../resources/boards/embedfire-cam-angled.png';

export const BOARD_GUIDE_COMMAND = 'scope.board-guide';

type Detail =
    { kind: 'alias'; name: string; io: number; origin: string } |
    { kind: 'peripheral'; peripheral: string; key: string; io: number } |
    { kind: 'contact'; connector: ConnectorDefinition; index: number } |
    { kind: 'component'; id: string };

interface BoardComponent {
    id: string;
    label: string;
    /** Percent position matching the top-view render layout in tools/boards/build_embedfire.py. */
    x: number;
    y: number;
    text: string;
    connector?: string;
}

// Positions track the orthographic top render (span 10.8 x 8.1 board units).
const COMPONENTS: readonly BoardComponent[] = [
    { id: 'buttons', label: '顶部按键', x: 66.2, y: 14.8, text: '复位与 BOOT 按键，位置为示意。' },
    { id: 'processor', label: 'K210 处理器', x: 25.9, y: 25.3, text: '主控芯片（K210 双核 RISC-V）。' },
    { id: 'camera', label: '摄像头模组', x: 55.6, y: 24.1, text: '相机模组与排线；当前项目为 GC2145 适配，具体型号请对照实物。' },
    { id: 'sd', label: 'microSD 卡座', x: 76.9, y: 34.6, text: 'microSD 卡座，板端路径 /sd。' },
    { id: 'lcd-socket', label: '屏幕排线座', x: 8.0, y: 45.1, text: '屏幕 FPC 排线插座。' },
    { id: 'fpc', label: '排线插座', x: 51.9, y: 64.8, text: '下部排线插座（示意）。' },
    { id: 'usb', label: 'USB 接口', x: 90.7, y: 42.6, text: 'USB 供电与串口数据。' },
    { id: 'header-1', label: '引脚组 1 · 2×14', x: 35.2, y: 79.0, text: '2×14 插座，IO 电平 3.3V。', connector: 'header-1' },
    { id: 'header-2', label: '引脚组 2 · 2×3', x: 74.1, y: 79.0, text: '2×3 插座，IO 电平 1.8V。', connector: 'header-2' },
];

const PERIPHERAL_LABELS: Record<string, string> = { sensor: '相机 sensor', lcd: '屏幕 lcd', sdcard: '存储卡 sdcard' };

// Physical IO lookup only: a connector contact resolves to a chip IO number;
// real GPIO use still needs explicit FPIOA allocation in user code.
const contactSample = (io: number): string => `io = ${io}\nprint(io)`;
const peripheralSample = (section: string, key: string): string =>
    `from Maix import config\nprint(config.get_value(${JSON.stringify(section)}, {})[${JSON.stringify(key)}])`;
const HELPER_SOURCE = 'desktop/examples/board-api/nodu_board.py';
const HELPER_SAMPLE = `import nodu_board\nnodu_board.pin('LED')      # USER_LED / LED_R\nnodu_board.pin('BUTTON')   # BOOT_KEY\nnodu_board.peripheral('sensor')`;

@injectable()
export class NoduBoardWidget extends ReactWidget {
    static readonly ID = 'nodu:board-guide';
    static readonly LABEL = '认识开发板';
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(MessageService) protected readonly messages!: MessageService;
    private selectedBoardId = '';
    private view: 'top' | 'angled' = 'top';
    private pinQuery = '';
    private detail: Detail | undefined;
    /** Once the user picks a catalog board, inspection events never override it. */
    private catalogManuallySelected = false;
    private lastInspection: BoardInspection | undefined;

    @postConstruct()
    protected init(): void {
        this.id = NoduBoardWidget.ID;
        this.title.label = NoduBoardWidget.LABEL;
        this.title.caption = 'Nodu · 板端配置声明与引脚资料';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-circuit-board';
        this.addClass('scope-widget');
        this.addClass('nodu-board-widget');
        this.node.tabIndex = 0;
        this.toDispose.push(this.device.onDidChange(() => this.update()));
        this.update();
    }

    protected onActivateRequest(): void { this.node.focus(); }

    private selectedBoard(): BoardDefinition | undefined {
        return BOARD_DEFINITIONS.find(board => board.id === this.selectedBoardId);
    }

    private filteredPins(pins: Record<string, number>): [string, number][] {
        const query = this.pinQuery.trim().toLowerCase();
        const entries = Object.entries(pins);
        if (!query) { return entries; }
        return entries.filter(([name, io]) => name.toLowerCase().includes(query) || `io${io}` === query || String(io) === query);
    }

    private statusText(inspection: BoardInspection | undefined): { label: string; tone: string } {
        const board = inspection?.boardId ? BOARD_DEFINITIONS.find(entry => entry.id === inspection.boardId) : undefined;
        if (!this.device.connected) { return { label: '未连接设备', tone: '' }; }
        if (this.device.boardInspecting) { return { label: '正在读取板端配置…', tone: 'busy' }; }
        if (!inspection) { return { label: '已连接 · 尚未读取板端配置', tone: '' }; }
        switch (inspection.status) {
            case 'declared': return { label: `板端配置声明：${board?.label || inspection.boardId}`, tone: 'declared' };
            case 'missing': return { label: '板端无 config.json · 未声明板型', tone: 'unknown' };
            case 'unknown': return { label: '板端配置未识别', tone: 'unknown' };
            case 'invalid': return { label: '板端配置无效', tone: 'error' };
            case 'conflict': return { label: '板端配置标识冲突', tone: 'error' };
            case 'unavailable': return { label: '板端配置读取失败', tone: 'error' };
        }
    }

    private async copyCode(code: string): Promise<void> {
        try {
            await this.clipboard.writeText(code);
            void this.messages.info('已复制示例代码。示例不会在设备上自动运行。');
        } catch (error) {
            void this.messages.error(`复制失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private setDetail(detail: Detail | undefined): void {
        this.detail = detail;
        this.update();
        if (detail) {
            setTimeout(() => this.node.querySelector('.nodu-board-detail')?.scrollIntoView({ block: 'nearest' }), 0);
        }
    }

    /** A detail pane quoting live values must not outlive its inspection. */
    private liveDetail(): Detail | undefined {
        const detail = this.detail;
        const inspection = this.device.boardInspection;
        if (detail?.kind === 'alias' && detail.origin === '板端配置' && inspection?.pins[detail.name] !== detail.io) { return undefined; }
        if (detail?.kind === 'peripheral' && inspection?.peripherals[detail.peripheral]?.[detail.key] !== detail.io) { return undefined; }
        return detail;
    }

    private pinTable(pins: [string, number][], origin: string, caption: string, peripheral?: string): React.ReactNode {
        if (!pins.length) {
            return <p className="scope-caption">{this.pinQuery.trim() ? '没有匹配的引脚。' : caption}</p>;
        }
        return <table className="scope-results-table nodu-pin-table">
            <caption className="scope-visually-hidden">{caption}</caption>
            <thead><tr><th scope="col">逻辑别名</th><th scope="col">芯片 IO</th><th scope="col">来源</th></tr></thead>
            <tbody>{pins.map(([name, io]) => <tr key={name}>
                <td><button className="nodu-pin-name scope-mono" title={peripheral ? `${peripheral}.${name}` : name}
                    onClick={() => this.setDetail(peripheral
                        ? { kind: 'peripheral', peripheral, key: name, io }
                        : { kind: 'alias', name, io, origin })}>{name}</button></td>
                <td className="scope-mono">IO{io}</td>
                <td className="scope-muted">{origin}</td>
            </tr>)}</tbody>
        </table>;
    }

    // Logical contact list only: two contacts per row,序号按资料表排列，不代表孔位方向。
    private connectorTable(connector: ConnectorDefinition): React.ReactNode {
        const cell = (index: number): [React.ReactNode, React.ReactNode] => {
            const contact = connector.contacts[index];
            const power = typeof contact !== 'number';
            const selected = this.detail?.kind === 'contact' && this.detail.connector.id === connector.id && this.detail.index === index;
            return [<td key={`n${index}`} className="nodu-contact-num-cell">
                    <button className={selected ? 'nodu-contact nodu-contact-selected' : 'nodu-contact'} aria-pressed={selected}
                        title={`触点 ${index + 1}：${power ? contact : `IO${contact}`}`}
                        onClick={() => this.setDetail({ kind: 'contact', connector, index })}>{index + 1}</button></td>,
                <td key={`v${index}`} className={`nodu-contact-io scope-mono${power ? ' nodu-contact-power' : ''}`}
                    >{power ? contact : `IO${contact}`}</td>];
        };
        const rows: React.ReactNode[] = [];
        for (let index = 0; index < connector.contacts.length; index += 2) {
            const [leftNum, leftValue] = cell(index);
            const [rightNum, rightValue] = index + 1 < connector.contacts.length ? cell(index + 1) : [<td key="e1" />, <td key="e2" />];
            rows.push(<tr key={index}>{leftNum}{leftValue}{rightNum}{rightValue}</tr>);
        }
        return <table className="nodu-connector-table" key={connector.id}>
            <caption>{connector.label} <span className="scope-muted">IO {connector.ioVoltage} · 逻辑触点表，未核实针脚 1 方向</span></caption>
            <thead><tr><th scope="col">触点</th><th scope="col">功能</th><th scope="col">触点</th><th scope="col">功能</th></tr></thead>
            <tbody>{rows}</tbody>
        </table>;
    }

    private renderDetail(board: BoardDefinition | undefined, detail: Detail | undefined): React.ReactNode {
        if (!detail) { return undefined; }
        let heading = '';
        let body: React.ReactNode;
        let code: string | undefined;
        let codeNote = '';
        if (detail.kind === 'alias') {
            heading = `引脚 ${detail.name} · IO${detail.io}`;
            code = boardPinSample(detail.name);
            codeNote = `需先上传 nodu_board.py（示例目录 board-api，${HELPER_SOURCE}）；模块只读配置，不初始化驱动。`;
            body = <p className="scope-helper">来源：{detail.origin}。IO 号是芯片引脚编号，不是 GPIO 通道号。</p>;
        } else if (detail.kind === 'peripheral') {
            heading = `${PERIPHERAL_LABELS[detail.peripheral] || detail.peripheral} · ${detail.key} · IO${detail.io}`;
            code = peripheralSample(detail.peripheral, detail.key);
            codeNote = '标准 Maix 配置查询，只读。';
            body = <p className="scope-helper">外设声明字段 {detail.peripheral}.{detail.key} → 芯片 IO{detail.io}；接线与驱动可用性仍以官方文档为准。</p>;
        } else if (detail.kind === 'contact') {
            const contact = detail.connector.contacts[detail.index];
            heading = `${detail.connector.label} · 触点 ${detail.index + 1}`;
            if (typeof contact === 'number') {
                code = contactSample(contact);
                codeNote = '只读查询物理 IO 号；实际 GPIO 使用仍需代码显式做 FPIOA 资源分配。';
                body = <p className="scope-helper">触点 {detail.index + 1} → 芯片 IO{contact}，IO 电平 {detail.connector.ioVoltage}。</p>;
            } else {
                body = <p className="scope-helper">触点 {detail.index + 1} 为 {contact} 电源 / 接地，没有 GPIO 代码示例。</p>;
            }
        } else {
            const component = COMPONENTS.find(entry => entry.id === detail.id);
            if (!component) { return undefined; }
            heading = component.label;
            body = <>
                <p className="scope-helper">{component.text}</p>
                {component.connector && this.connectorTable(EMBEDFIRE_CONNECTORS.find(entry => entry.id === component.connector)!)}
            </>;
        }
        return <section className="nodu-board-detail" aria-label="引脚与部件详情">
            <div className="scope-section-heading"><h2>{heading}</h2>
                <button className="scope-text-button" onClick={() => this.setDetail(undefined)}>收起</button></div>
            {body}
            {code && <div className="nodu-board-code">
                <p className="scope-caption">{codeNote}</p>
                <pre className="nodu-repl-output" tabIndex={0}>{code}</pre>
                <button className="theia-button secondary" onClick={() => void this.copyCode(code!)}><i className="codicon codicon-copy" aria-hidden="true" />复制示例</button>
            </div>}
        </section>;
    }

    private renderFigure(board: BoardDefinition | undefined): React.ReactNode {
        if (!board) {
            return <p className="scope-helper nodu-board-invite">从上方选择一块开发板查看引脚资料；这里的浏览与当前连接、相机适配相互独立。</p>;
        }
        if (board.id !== 'embedfire-cam-gc2145') {
            return <p className="scope-helper">{board.description} 该开发板暂无结构模型；引脚表来自官方配置脚本。</p>;
        }
        return <>
            <div className="scope-section-heading"><h2>结构示意</h2>
                <span className="nodu-view-toggle" role="group" aria-label="视图">
                    <button aria-pressed={this.view === 'top'} className={this.view === 'top' ? 'nodu-view-selected' : ''} onClick={() => { this.view = 'top'; this.update(); }}>俯视</button>
                    <button aria-pressed={this.view === 'angled'} className={this.view === 'angled' ? 'nodu-view-selected' : ''} onClick={() => { this.view = 'angled'; this.update(); }}>斜视</button>
                </span></div>
            <div className="nodu-board-figure">
                <img src={this.view === 'top' ? boardTopUrl : boardAngledUrl} alt="野火 K210 CAM 结构示意渲染图" draggable={false} />
                {this.view === 'top' && COMPONENTS.map((component, index) => {
                    const selected = this.detail?.kind === 'component' && this.detail.id === component.id;
                    return <button key={component.id} className={`nodu-part-marker${selected ? ' nodu-part-selected' : ''}`}
                        style={{ left: `${component.x}%`, top: `${component.y}%` }} aria-pressed={selected}
                        title={`${index + 1}. ${component.label}`} aria-label={`${index + 1}. ${component.label}`}
                        onClick={() => this.setDetail({ kind: 'component', id: component.id })}>{index + 1}</button>;
                })}
            </div>
            <div className="nodu-part-legend" role="group" aria-label="部件编号（非触点序号）">
                {COMPONENTS.map((component, index) => {
                    const selected = this.detail?.kind === 'component' && this.detail.id === component.id;
                    return <button key={component.id} className={`nodu-legend-item${selected ? ' nodu-legend-selected' : ''}`}
                        aria-pressed={selected} onClick={() => this.setDetail({ kind: 'component', id: component.id })}>
                        <span className="nodu-legend-num">{index + 1}</span>{component.label}</button>;
                })}
            </div>
            <p className="scope-caption">结构示意，非机械 CAD；接线请对照官方引脚表与实物丝印。数字标记为部件编号，非触点序号。</p>
        </>;
    }

    protected render(): React.ReactNode {
        const inspection = this.device.boardInspection;
        // Inspection identity changes (read, clear, new device) drop live
        // details and — until the user picks a board themselves — follow the
        // latest declaration instead of the one at first open.
        if (inspection !== this.lastInspection) {
            this.lastInspection = inspection;
            if (this.detail?.kind === 'peripheral'
                || (this.detail?.kind === 'alias' && this.detail.origin === '板端配置')) {
                this.detail = undefined;
            }
            if (!this.catalogManuallySelected) {
                this.selectedBoardId = inspection?.status === 'declared' && inspection.boardId ? inspection.boardId : '';
            }
        }
        const board = this.selectedBoard();
        const status = this.statusText(inspection);
        const canInspect = this.device.connected && !this.device.state.running && !this.device.busy && !this.device.boardInspecting;
        const livePinCount = inspection ? Object.keys(inspection.pins).length : 0;
        const peripherals = Object.entries(inspection?.peripherals ?? {});
        const detail = this.liveDetail();
        const isEmbedfire = board?.id === 'embedfire-cam-gc2145';
        return <div className="scope-panel-content nodu-board-guide">
            <section className="nodu-board-head" aria-label="当前设备与开发板资料">
                <div className="nodu-board-headline">
                    <span className={`scope-state nodu-status-${status.tone}`} role="status"><i aria-hidden="true" />{status.label}</span>
                    <button className="theia-button secondary" disabled={!canInspect} aria-busy={this.device.boardInspecting || undefined}
                        title={this.device.connected ? '重新读取板端配置声明（只读）' : '需要先连接设备'} onClick={() => void this.device.inspectBoard()}>
                        <i className="codicon codicon-refresh" aria-hidden="true" />读取板端配置</button>
                    {!this.device.connected && <button className="scope-text-button" onClick={() => void this.commands.executeCommand('scope.show-devices')}>设备与连接</button>}
                    <span className="nodu-device-field nodu-board-catalog"><label htmlFor="nodu-board-catalog">浏览开发板资料</label>
                        <select id="nodu-board-catalog" value={this.selectedBoardId} onChange={event => { this.selectedBoardId = event.currentTarget.value; this.catalogManuallySelected = true; this.detail = undefined; this.update(); }}>
                            <option value="">选择要查看的开发板</option>
                            {BOARD_DEFINITIONS.map(entry => <option value={entry.id} key={entry.id}>{entry.label}</option>)}
                        </select></span>
                </div>
                <p className="scope-helper">识别来自板端 /flash/config.json 声明，不是硬件实测；烧相同固件的不同硬件仍以实物为准。</p>
                {inspection?.issues.map((issue, index) => <p key={index} className="scope-error" role={inspection.status === 'invalid' || inspection.status === 'conflict' ? 'alert' : undefined}>{issue}</p>)}
                {inspection && (inspection.declaredType || inspection.configName) && <p className="scope-caption scope-mono">type={inspection.declaredType || '—'} · config_name={inspection.configName || '—'}</p>}
            </section>
            <div className="nodu-board-workspace">
                <div className="nodu-board-left">{this.renderFigure(board)}</div>
                <div className="nodu-board-right">
                    {this.renderDetail(board, detail)}
                    {(board || livePinCount > 0 || peripherals.length > 0) && <section aria-label="引脚表">
                        <div className="scope-section-heading"><h2>引脚表</h2></div>
                        <div className="nodu-device-field"><label htmlFor="nodu-pin-search">搜索引脚</label>
                            <input id="nodu-pin-search" value={this.pinQuery} onChange={event => { this.pinQuery = event.currentTarget.value; this.update(); }} placeholder="别名或 IO 号" /></div>
                        {board && <>
                            <h3 className="nodu-pin-heading">参考引脚 · {board.label}</h3>
                            {this.pinTable(this.filteredPins({ ...board.pins }), '资料', `${board.label} 参考引脚`)}
                        </>}
                        {this.device.connected && inspection && <>
                            <h3 className="nodu-pin-heading">当前配置引脚 · 板端 config.json</h3>
                            {this.pinTable(this.filteredPins(inspection.pins), '板端配置', '当前板端配置声明的引脚')}
                            {peripherals.map(([name, pinsOf]) => <div key={name}>
                                <h3 className="nodu-pin-heading">{PERIPHERAL_LABELS[name] || name} · 板端声明</h3>
                                {this.pinTable(this.filteredPins(pinsOf), '板端配置', `${name} 板端声明引脚`, name)}
                            </div>)}
                        </>}
                        <details className="nodu-board-api">
                            <summary>板端辅助模块 nodu_board.py（可选）</summary>
                            <p className="scope-helper">用文件管理器把 <code className="scope-mono">{HELPER_SOURCE}</code> 发送到板端 /flash 后可统一查询别名；模块只读配置声明，不初始化驱动、不占用 GPIO。</p>
                            <div className="nodu-board-code">
                                <pre className="nodu-repl-output" tabIndex={0}>{HELPER_SAMPLE}</pre>
                                <button className="theia-button secondary" onClick={() => void this.copyCode(HELPER_SAMPLE)}><i className="codicon codicon-copy" aria-hidden="true" />复制示例</button>
                            </div>
                        </details>
                        <p className="scope-caption">IO 号是芯片引脚编号（0–47），不是 GPIO 通道号；GPIO 通道由固件 FPIOA 映射决定。</p>
                    </section>}
                </div>
            </div>
            {board && isEmbedfire && <details className="nodu-connectors">
                <summary>连接器触点表（2×14 与 2×3）</summary>
                {EMBEDFIRE_CONNECTORS.map(connector => this.connectorTable(connector))}
            </details>}
            <footer className="nodu-board-footer">
                <p>板端 config.json 是缓存前的配置文件，可能与固件当前运行值不同，重启后才重新读取；在本页切换资料不会改写板端配置。</p>
                <div className="nodu-source-line">引脚事实来源：{board ? (board.source.startsWith('https://')
                    ? <a href={board.source} target="_blank" rel="noreferrer">官方配置脚本</a>
                    : <details className="nodu-source-detail"><summary>当前设备配置参考</summary><code className="scope-mono">{board.source}</code></details>) : '—'}
                    {isEmbedfire && <> · <a href="https://doc.embedfire.com/k210/quick_start/zh/latest/k210/peripheral/pin/pin.html" target="_blank" rel="noreferrer">野火官方引脚文档</a></>}</div>
            </footer>
        </div>;
    }
}

@injectable()
export class NoduBoardGuideContribution extends AbstractViewContribution<NoduBoardWidget> {
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    constructor() {
        super({ widgetId: NoduBoardWidget.ID, widgetName: NoduBoardWidget.LABEL,
            defaultWidgetOptions: { area: 'main' } });
    }
    override registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({ id: BOARD_GUIDE_COMMAND, label: NoduBoardWidget.LABEL, category: '见微 Nodu' },
            { execute: () => { this.layoutState.setDeviceOpen(false); return this.openView({ activate: true }); } });
    }
    override registerMenus(_menus: MenuModelRegistry): void {
        // The 见微 menu entry is registered by ScopeWorkbenchContribution.
    }
}
