// SPDX-License-Identifier: MIT
import { AbstractDialog } from '@theia/core/lib/browser/dialogs';
import { Message } from '@theia/core/shared/@lumino/messaging';

// Shared by the dialog and status-bar hover; no model, RPC or hardware dependencies.
export function downloadHelpContent(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'nodu-download-help-content';
    const append = (parent: HTMLElement, tag: string, text: string): HTMLElement => {
        const element = document.createElement(tag); element.textContent = text; parent.appendChild(element); return element;
    };
    append(root, 'p', '适用：STM32F103C8T6（已实测）。其他型号请核对芯片手册，勿直接套用以下引脚。');
    const table = document.createElement('table');
    table.setAttribute('aria-label', 'STM32F103 下载方式对比'); root.appendChild(table);
    const head = table.createTHead().insertRow();
    for (const label of ['项目', 'ST-LINK（SWD）', '串口（ISP）']) { const th = append(head, 'th', label); th.setAttribute('scope', 'col'); }
    const body = table.createTBody();
    const rows: [string, string | string[], string | string[]][] = [
        ['接线', 'SWDIO、SWCLK、GND；目标板需供电。', '3.3V TTL USB 转串口：TXD → PA10，RXD → PA9，GND → GND。板子独立供电时无需接模块 VCC。'],
        ['操作', ['BOOT0=0，BOOT1 可保持 0。', '选择 ST-LINK，点击“运行”编译并下载，通常无需提前手动复位。', '写入后自动校验、复位并尝试运行。'], ['BOOT0=1、BOOT1=0，按复位进入 Bootloader。', '选择串口 ISP 和端口，点击“运行”下载。已在 Bootloader 时通常无需再次复位。', '成功后 BOOT0 改回 0，再按复位运行。ST-LINK 可保持连接，ISP 不依赖它。']],
        ['运行通信', '可同时连接 PA9、PA10 的 USB 转串口；与右侧接线相同。', '原接线可继续通信；用户程序必须初始化 USART1。'],
        ['串口参数', '运行参数由用户程序决定。', '下载使用偶校验（8E1）；运行参数由程序决定，例如 115200、8N1。'],
    ];
    for (const [label, ...cells] of rows) {
        const row = body.insertRow(); const th = append(row, 'th', label); th.setAttribute('scope', 'row');
        for (const value of cells) {
            const cell = row.insertCell();
            if (Array.isArray(value)) { const list = document.createElement('ol'); cell.appendChild(list); value.forEach(line => append(list, 'li', line)); }
            else { cell.textContent = value; }
        }
    }
    append(root, 'p', 'Nodu 在 ISP 下载时自动释放已打开的串口，结束后恢复监视器；成功后会尝试打开所选端口。当前监视器为 8N1，波特率需与程序一致。收到有效的完整文本行后，恢复启动引导自动收起。');
    append(root, 'p', '以上 ISP 步骤按手动复位说明。工程设置中可选 DTR/RTS 自动下载，仅限 STM32F103C8T6 且需先核对电路；启用后自动切换 BOOT0 并复位，读回校验通过后请求运行。该电路尚待实物验证。');
    const faq = document.createElement('dl'); root.appendChild(faq);
    for (const [question, answer] of [
        ['每次下载前都要按复位？', 'SWD 通常不用。ISP 首次进入 Bootloader 要按，仍在 Bootloader 时通常不用。'],
        ['双 0 能否下载？', 'SWD 可以。ISP 在 BOOT0=0、BOOT1=0 复位后会进入用户程序，需改为 1、0 再复位。'],
        ['下载后能用原串口接线通信？', '可以。BOOT0=0 复位运行，程序初始化 USART1，监视器参数与程序一致即可。'],
    ]) { append(faq, 'dt', question); append(faq, 'dd', answer); }
    return root;
}

export class NoduDownloadHelpDialog extends AbstractDialog<void> {
    constructor() {
        super({ title: '下载帮助' });
        this.addClass('nodu-download-help-dialog');
        this.node.setAttribute('role', 'dialog'); this.node.setAttribute('aria-modal', 'true');
        this.node.setAttribute('aria-label', '下载帮助');
        this.contentNode.appendChild(downloadHelpContent());
        this.contentNode.tabIndex = 0; this.contentNode.setAttribute('aria-label', '下载帮助内容');
        this.closeCrossNode.setAttribute('role', 'button'); this.closeCrossNode.setAttribute('aria-label', '关闭下载帮助');
        this.closeCrossNode.tabIndex = 0;
        this.closeCrossNode.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.close(); } });
        this.appendCloseButton('关闭');
        this.node.addEventListener('keydown', event => {
            if (event.key !== 'Tab') { return; }
            const targets = [this.closeCrossNode, this.contentNode, this.closeButton!];
            const index = targets.indexOf(document.activeElement as HTMLElement);
            if (event.shiftKey && index === 0) { event.preventDefault(); this.closeButton?.focus(); }
            else if (!event.shiftKey && index === targets.length - 1) { event.preventDefault(); this.closeCrossNode.focus(); }
        });
    }
    get value(): void { return; }
    protected onActivateRequest(msg: Message): void { super.onActivateRequest(msg); this.closeButton?.focus(); }
    protected handleEnter(): boolean { return false; }
}
