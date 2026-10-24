// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MessageService } from '@theia/core/lib/common';
import { OutputChannelManager, OutputChannelSeverity } from '@theia/output/lib/browser/output-channel';
import { OutputContribution } from '@theia/output/lib/browser/output-contribution';

export interface SystemFailure {
    source: string;
    key: string;
    message: string;
    error: unknown;
    context?: Record<string, string>;
    retry?: () => void | Promise<void>;
    isCurrent?: () => boolean;
}

/** System failures have one discoverable log, separate from build/device output. */
@injectable()
export class NoduDiagnostics implements CommandContribution {
    static readonly CHANNEL = 'Nodu 日志';
    @inject(OutputChannelManager) protected readonly output!: OutputChannelManager;
    @inject(OutputContribution) protected readonly outputView!: OutputContribution;
    @inject(MessageService) protected readonly messages!: MessageService;
    private readonly notified = new Map<string, { isCurrent?: () => boolean }>();
    private readonly muted = new Set<string>();

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: 'nodu.logs.show', label: '显示日志', category: 'Nodu' }, { execute: () => this.show() });
    }

    async show(): Promise<void> {
        this.output.getChannel(NoduDiagnostics.CHANNEL).show({ preserveFocus: true });
        await this.outputView.openView({ area: 'bottom', activate: true, reveal: true });
    }

    record(source: string, message: string, detail?: unknown): void {
        this.write(source, message, detail, OutputChannelSeverity.Info);
    }

    private write(source: string, message: string, detail: unknown, severity: OutputChannelSeverity): void {
        const raw = detail instanceof Error ? `${detail.stack || detail.message}${'code' in detail ? `\ncode: ${String(detail.code)}` : ''}`
            : typeof detail === 'string' ? detail : detail === undefined ? '' : JSON.stringify(detail);
        // Logs are local and bounded by Output's history limit. Remove terminal
        // control characters so an exception cannot disguise earlier entries.
        const clean = (value: string): string => value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 16_384);
        this.output.getChannel(NoduDiagnostics.CHANNEL).appendLine(
            `[${new Date().toISOString()}] [${severity === OutputChannelSeverity.Error ? 'error' : 'info'}] [${clean(source)}] ${clean(message)}${raw ? `\n${clean(raw)}` : ''}`,
            severity
        );
    }

    resolve(source: string, key: string): void {
        this.notified.delete(JSON.stringify([source, key]));
    }

    report(failure: SystemFailure): void {
        if (failure.isCurrent && !failure.isCurrent()) { return; }
        this.write(failure.source, failure.message, failure.error, OutputChannelSeverity.Error);
        if (failure.context) { this.record(failure.source, '上下文', failure.context); }
        const key = JSON.stringify([failure.source, failure.key]);
        if (this.muted.has(failure.source)) { return; }
        const previous = this.notified.get(key);
        // Re-entering the same project produces the same key but a new lifecycle.
        // Its old notification cannot retry anymore, so replace that stale entry.
        if (previous && (!previous.isCurrent || previous.isCurrent())) { return; }
        const token = { isCurrent: failure.isCurrent };
        this.notified.set(key, token);
        // Bound the session's deduplication index as users open many projects.
        if (this.notified.size > 100) { this.notified.delete(this.notified.keys().next().value!); }
        const actions = ['查看日志', ...(failure.retry ? ['重试'] : []), '本次不再提醒'];
        void this.messages.error(failure.message, ...actions).then(async action => {
            if (action === '查看日志') { await this.show(); return; }
            if (action === '本次不再提醒') { this.muted.add(failure.source); return; }
            if (action !== '重试' || this.notified.get(key) !== token || (failure.isCurrent && !failure.isCurrent())) { return; }
            this.notified.delete(key);
            await failure.retry?.();
        }).catch(error => {
            // A failed UI action must remain inspectable without spawning a
            // recursive notification or an unhandled rejection.
            this.write(failure.source, '通知操作未完成', error, OutputChannelSeverity.Error);
        });
    }
}
