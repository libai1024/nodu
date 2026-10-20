// SPDX-License-Identifier: MIT
// Serial/TCP/UDP byte terminals: a Theia xterm widget whose shell is the
// bundled nodu-terminal binary, mirroring the original IDE's
// -open_*_terminal launch flags. Ctrl-] exits a terminal; Ctrl-R / Ctrl-E
// forward raw bytes (0x12 / 0x05) instead of IDE run/stop actions.
import * as React from 'react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MAIN_MENU_BAR } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService } from '@theia/core/lib/common/quick-pick-service';
import { FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { isOSX } from '@theia/core/lib/common/os';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { SerialPortInfo } from '../common/nodu-device-protocol';
import { NoduDeviceModel } from './nodu-device-client';
import { BOARD_IDS } from './nodu-device-panel';

type TerminalMode = 'serial' | 'tcp-client' | 'tcp-server' | 'udp-client' | 'udp-server';

interface TerminalFormSpec {
    mode: TerminalMode;
    label: string;
    ports: SerialPortInfo[];
    boardId: number;
    /** IDE-connected port a serial terminal must not steal. */
    connectedPort?: string;
}

const MODE_ITEMS: { mode: TerminalMode; label: string; detail: string }[] = [
    { mode: 'serial', label: '串口终端', detail: 'port:baud · DTR 置位，可选板级复位' },
    { mode: 'tcp-client', label: 'TCP 客户端', detail: 'host:port · 主动连接' },
    { mode: 'tcp-server', label: 'TCP 服务器', detail: 'port · 监听本机，一次一个对端' },
    { mode: 'udp-client', label: 'UDP 客户端', detail: 'host:port · 限定对端' },
    { mode: 'udp-server', label: 'UDP 服务器', detail: 'port · 回复最近发送方' },
];

const CONTROL_EXIT_HINT = '终端内 Ctrl-] 结束；Ctrl-R / Ctrl-E 透传原始字节。';

/** One bounded host:port split matching the Rust parser (rsplit + [IPv6]). */
function splitHostPort(value: string): { host: string; port: number } | string {
    const at = value.lastIndexOf(':');
    if (at < 0) { return '格式须为 host:port（IPv6 写作 [地址]:端口）。'; }
    let host = value.slice(0, at);
    if (host.startsWith('[') && host.endsWith(']')) { host = host.slice(1, -1); }
    if (!host || host.length > 512 || host.includes('\0')) { return '主机名不能为空且不超过 512 字节。'; }
    const port = Number(value.slice(at + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) { return '端口须为 1–65535 的整数。'; }
    return { host, port };
}

function boundedMs(value: string, name: string): number | string {
    const ms = Number(value);
    if (!Number.isInteger(ms) || ms < 1 || ms > 60000) { return `${name}须为 1–60000 的整数毫秒。`; }
    return ms;
}

/** Mode-specific connection form; validates and builds nodu-terminal args. */
export class NoduTerminalDialog extends ReactDialog<string[] | undefined> {
    private args?: string[];
    private readonly inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();

    constructor(props: DialogProps, private readonly spec: TerminalFormSpec) {
        super(props);
        this.node.classList.add('nodu-terminal-dialog');
        this.appendAcceptButton('打开终端');
    }

    get value(): string[] | undefined { return this.args; }

    private field(id: string): string {
        return (this.inputs.get(id)?.value ?? '').trim();
    }

    protected override async accept(): Promise<void> {
        const result = this.buildArgs();
        if (typeof result === 'string') { this.setErrorMessage(result); return; }
        this.setErrorMessage(false);
        this.args = result;
        await super.accept();
    }

    private buildArgs(): string[] | string {
        const { mode, connectedPort } = this.spec;
        const args: string[] = [];
        if (mode === 'serial') {
            const port = this.field('port');
            if (!port || port.length > 512 || port.includes('\0')) { return '请填写有效的串口（不超过 512 字节）。'; }
            if (connectedPort && port === connectedPort) { return '该串口已被 IDE 占用，请先断开 IDE 连接。'; }
            const baud = Number(this.field('baud'));
            if (!Number.isInteger(baud) || baud < 1 || baud > 4000000) { return '波特率须为 1–4000000 的整数。'; }
            args.push('-open_serial_terminal', `${port}:${baud}`);
            const reset = this.inputs.get('reset') as HTMLInputElement | undefined;
            if (reset?.checked) {
                const board = Number(this.field('board'));
                if (!Number.isInteger(board) || board < 0 || board > 8) { return '板型编号须为 0–8 的整数。'; }
                args.push('--reset-board', String(board));
            }
        } else if (mode === 'tcp-client' || mode === 'udp-client') {
            const endpoint = splitHostPort(this.field('endpoint'));
            if (typeof endpoint === 'string') { return endpoint; }
            args.push(mode === 'tcp-client' ? '-open_tcp_client_terminal' : '-open_udp_client_terminal', this.field('endpoint'));
            const connect = boundedMs(this.field('connect'), '连接超时');
            if (typeof connect === 'string') { return connect; }
            args.push('--connect-timeout-ms', String(connect));
            if (mode === 'udp-client') {
                const bind = this.field('bind');
                if (bind) { args.push('--bind', bind); }
            }
        } else {
            const port = Number(this.field('port'));
            if (!Number.isInteger(port) || port < 0 || port > 65535) { return '监听端口须为 0–65535 的整数（0 表示随机端口）。'; }
            args.push(mode === 'tcp-server' ? '-open_tcp_server_terminal' : '-open_udp_server_terminal', String(port));
            const bind = this.field('bind');
            if (bind) { args.push('--bind', bind); }
        }
        const io = boundedMs(this.field('io'), 'I/O 超时');
        if (typeof io === 'string') { return io; }
        args.push('--io-timeout-ms', String(io));
        return args;
    }

    private input(id: string, label: string, initial: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}): React.ReactNode {
        return <label className="nodu-terminal-field">{label}
            <input ref={el => { if (el) { this.inputs.set(id, el); } }} defaultValue={initial} spellCheck={false} {...props} />
        </label>;
    }

    protected render(): React.ReactNode {
        const { mode, ports, boardId } = this.spec;
        return <div className="nodu-terminal-form">
            {mode === 'serial' && <>
                <label className="nodu-terminal-field">串口
                    <input ref={el => { if (el) { this.inputs.set('port', el); } }} list="nodu-terminal-ports" defaultValue={ports[0]?.path ?? ''} placeholder="/dev/cu.usbserial-… 或手动输入" spellCheck={false} />
                </label>
                <datalist id="nodu-terminal-ports">{ports.map(p => <option key={p.path} value={p.path}>{p.description}</option>)}</datalist>
                {this.input('baud', '波特率', '115200', { inputMode: 'numeric' })}
                <label className="nodu-terminal-check">
                    <input type="checkbox" ref={el => { if (el) { this.inputs.set('reset', el); } }} /> 打开后执行板级复位
                </label>
                <label className="nodu-terminal-field">板型（复位时生效）
                    <select ref={el => { if (el) { this.inputs.set('board', el); } }} defaultValue={String(boardId)}>
                        {BOARD_IDS.map((name, id) => <option key={id} value={id}>{name}</option>)}
                    </select>
                </label>
            </>}
            {(mode === 'tcp-client' || mode === 'udp-client') && <>
                {this.input('endpoint', '地址（host:port）', '127.0.0.1:9000')}
                {this.input('connect', '连接超时（毫秒）', '30000', { inputMode: 'numeric' })}
                {mode === 'udp-client' && this.input('bind', '本机绑定 IP（留空自动选择本机接口）', '')}
            </>}
            {(mode === 'tcp-server' || mode === 'udp-server') && <>
                {this.input('bind', '本机绑定 IP', '127.0.0.1')}
                {this.input('port', '监听端口（0 = 随机，见终端输出）', '0', { inputMode: 'numeric' })}
            </>}
            {this.input('io', 'I/O 超时（毫秒）', '1000', { inputMode: 'numeric' })}
            <p className="nodu-terminal-hint">{CONTROL_EXIT_HINT}</p>
        </div>;
    }
}

@injectable()
export class NoduTerminalContribution implements CommandContribution, MenuContribution, KeybindingContribution, FrontendApplicationContribution {
    @inject(TerminalService) protected readonly terminals!: TerminalService;
    @inject(QuickPickService) protected readonly quickPick!: QuickPickService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: 'scope.open-terminal', label: '新终端…', category: '见微 Nodu' }, {
            execute: () => this.openTerminal().catch(error => this.messages.error(`新终端：${error instanceof Error ? error.message : String(error)}`)),
        });
        // Original terminal context: Ctrl-R/Ctrl-E are raw bytes to the link,
        // not IDE run/stop. Only while a terminal has focus.
        registry.registerCommand({ id: 'scope.terminal-control-r', label: '终端：发送 Ctrl-R', category: '见微 Nodu' }, {
            execute: () => this.terminals.currentTerminal?.sendText('\x12'),
            isEnabled: () => !!this.terminals.currentTerminal,
        });
        registry.registerCommand({ id: 'scope.terminal-control-e', label: '终端：发送 Ctrl-E', category: '见微 Nodu' }, {
            execute: () => this.terminals.currentTerminal?.sendText('\x05'),
            isEnabled: () => !!this.terminals.currentTerminal,
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        const term = [...MAIN_MENU_BAR, '5_scope', 'terminal-tools'];
        menus.registerSubmenu(term, '终端');
        menus.registerMenuAction(term, { commandId: 'scope.open-terminal', order: '0' });
    }

    registerKeybindings(keys: KeybindingRegistry): void {
        keys.registerKeybinding({ command: 'scope.terminal-control-r', keybinding: 'ctrlcmd+r', when: 'terminalFocus' });
        keys.registerKeybinding({ command: 'scope.terminal-control-e', keybinding: 'ctrlcmd+e', when: 'terminalFocus' });
        if (isOSX) {
            // On macOS ctrlcmd is Cmd; the original terminal also used the
            // physical Ctrl key for these bytes.
            keys.registerKeybinding({ command: 'scope.terminal-control-r', keybinding: 'ctrl+r', when: 'terminalFocus' });
            keys.registerKeybinding({ command: 'scope.terminal-control-e', keybinding: 'ctrl+e', when: 'terminalFocus' });
        }
    }

    /** Launcher `-open_*_terminal` flags arrive once via the backend env. */
    async onStart(): Promise<void> {
        const requests = await this.device.takeStartupTerminals().catch(() => []);
        for (const args of requests) {
            await this.spawnTerminal(this.startupTitle(args), args)
                .catch(error => this.messages.error(`启动终端：${error instanceof Error ? error.message : String(error)}`));
        }
    }

    private startupTitle(args: string[]): string {
        const at = args[0]?.startsWith('-open_') ? args[0].replace(/^-open_/, '').replace(/_terminal$/, '') : 'terminal';
        return `${at} ${args[1] ?? ''}`.trim();
    }

    private async openTerminal(): Promise<void> {
        const picked = await this.quickPick.show(
            MODE_ITEMS.map(item => ({ label: item.label, description: item.detail, item })) as { label: string; description: string; item: typeof MODE_ITEMS[number] }[],
            { placeholder: '选择终端类型' },
        );
        if (!picked) { return; }
        const { mode, label } = picked.item;
        const dialog = new NoduTerminalDialog({ title: `${label} · ${CONTROL_EXIT_HINT}` }, {
            mode, label,
            ports: this.device.ports,
            boardId: this.device.boardId ?? 2,
            connectedPort: this.device.connected ? this.device.state.port : undefined,
        });
        const args = await dialog.open();
        if (!args) { return; }
        await this.spawnTerminal(`${label} ${args[1]}`, args);
    }

    private async spawnTerminal(title: string, args: string[]): Promise<void> {
        const shellPath = await this.device.getTerminalExecutable();
        const terminal = await this.terminals.newTerminal({
            title, shellPath, shellArgs: args, destroyTermOnClose: true, useServerTitle: false,
        });
        try {
            await terminal.start();
            await this.terminals.open(terminal, { mode: 'activate' });
        } catch (error) {
            terminal.dispose();
            throw error;
        }
    }
}
