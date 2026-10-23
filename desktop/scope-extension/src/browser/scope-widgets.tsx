import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, CommandService } from '@theia/core/lib/common/command';
import { Emitter } from '@theia/core/lib/common/event';
import { MessageService } from '@theia/core/lib/common/message-service';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { DeviceFrame } from '../common/nodu-device-protocol';
import { NoduDeviceModel } from './nodu-device-client';
import { NODU_COLORS } from './nodu-brand';
import { NoduImageTools } from './nodu-image-tools';
import { NoduImageToolState } from './nodu-image-state';
import { ScopeLayoutState } from './scope-layout-state';
import {
    ScopeSession, ScopeSnapshot, ScopeTarget, SCOPE_DEMO_TARGETS,
    syntheticDetections, syntheticObjects
} from './scope-session';

function Icon({ name }: { name: 'play' | 'pause' | 'camera' | 'device' | 'check' }): React.ReactElement {
    const paths = {
        play: 'm8 5 11 7-11 7V5Z', pause: 'M8 5v14M16 5v14',
        camera: 'M3 7h4l2-3h6l2 3h4v13H3V7Zm13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
        device: 'M7 3h10v18H7V3Zm3 3h4M10 18h4M3 8h4m10 0h4M3 12h4m10 0h4M3 16h4m10 0h4',
        check: 'm5 12 4 4L19 6'
    };
    return <svg className="scope-widget-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function SyntheticFrame({ snapshot }: { snapshot: ScopeSnapshot }): React.ReactElement {
    const ref = React.useRef<HTMLCanvasElement>(null);
    React.useEffect(() => {
        const canvas = ref.current;
        const context = canvas?.getContext('2d');
        if (!canvas || !context) { return; }
        const ctx = context;
        ctx.setTransform(2, 0, 0, 2, 0, 0);
        ctx.fillStyle = '#d9dfd4';
        ctx.fillRect(0, 0, 320, 240);
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = 'rgba(56,71,58,.12)';
        for (let x = 0; x <= 320; x += 20) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 240); ctx.stroke(); }
        for (let y = 0; y <= 240; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(320, y); ctx.stroke(); }
        ctx.fillStyle = '#b2b9ab'; ctx.fillRect(34, 180, 26, 18);
        ctx.fillStyle = '#b9957d'; ctx.beginPath(); ctx.arc(242, 52, 15, 0, Math.PI * 2); ctx.fill();
        for (const object of syntheticObjects(snapshot)) {
            ctx.fillStyle = object.color;
            if (object.kind === 'circle') {
                ctx.beginPath(); ctx.arc(object.x + object.width / 2, object.y + object.height / 2, object.width / 2, 0, Math.PI * 2); ctx.fill();
            } else {
                ctx.fillRect(object.x, object.y, object.width, object.height);
                ctx.fillStyle = '#70a573'; ctx.fillRect(object.x + 2, object.y + 2, object.width - 4, 2);
            }
        }
        if (snapshot.overlay) {
            for (const object of syntheticDetections(snapshot)) {
                const { x, y, width, height } = object;
                ctx.strokeStyle = '#173b30'; ctx.lineWidth = 1;
                ctx.strokeRect(x - 3, y - 3, width + 6, height + 6);
                ctx.fillStyle = '#173b30'; ctx.fillRect(x - 3, y - 19, 72, 16);
                ctx.fillStyle = '#FFFFFF'; ctx.font = '10px monospace';
                ctx.fillText(`0${object.id} GREEN`, x + 2, y - 8);
                const cx = x + width / 2, cy = y + height / 2;
                ctx.beginPath(); ctx.moveTo(cx - 4, cy); ctx.lineTo(cx + 4, cy); ctx.moveTo(cx, cy - 4); ctx.lineTo(cx, cy + 4); ctx.stroke();
            }
        }
        ctx.fillStyle = '#51624f'; ctx.font = '9px monospace';
        ctx.fillText('Nodu / SYNTHETIC TEST PATTERN', 12, 222);
        // Scene colours above are sample content; the demo watermark band is UI chrome and uses Chip Ink.
        ctx.fillStyle = NODU_COLORS.dark.ink; ctx.fillRect(0, 230, 320, 10);
        ctx.fillStyle = NODU_COLORS.dark.text; ctx.font = '6px monospace';
        ctx.fillText('LOCAL DEMO  /  SYNTHETIC IMAGE', 8, 237);
    }, [snapshot]);
    return <canvas ref={ref} width={640} height={480} role="img" aria-label={`合成测试帧 ${snapshot.frame}，${syntheticDetections(snapshot).length} 个示例检测目标`} />;
}

/** mm:ss.t (h:mm:ss.t past an hour) for the recording clock. */
function clockText(ms: number): string {
    const tenths = Math.floor(ms / 100) % 10, seconds = Math.floor(ms / 1000) % 60, minutes = Math.floor(ms / 60000) % 60, hours = Math.floor(ms / 3600000);
    const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
    return hours ? `${hours}:${mmss}` : mmss;
}
function sizeText(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 帧缓冲 side panel. Device source: the frame scales into the free height and
 * the histogram block has a fixed height, so nothing scrolls. Frame actions
 * (录制 / 缩放 / 禁用 / 截图) live in the panel title row, see
 * ScopeVisionToolbarContribution. The pro-mode 示例 source keeps its old
 * scrolling layout.
 */
@injectable()
export class ScopeVisionWidget extends ReactWidget {
    static readonly ID = 'scope:vision';
    static readonly LABEL = '帧缓冲';
    // Only camera/preview faults surface here; REPL/script errors stay in the console.
    private static readonly CAMERA_OPS = new Set(['启动相机', '开启预览', '暂停预览', '开始录像', '结束录像']);
    @inject(ScopeSession) protected readonly session!: ScopeSession;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    readonly imageTools = new NoduImageToolState();
    private readonly toolbarChanged = new Emitter<void>();
    /** Fires when anything the title-row actions show has changed. */
    readonly onDidChangeToolbar = this.toolbarChanged.event;
    private toolbarKey = '';
    private applying = false;
    private applyError = '';
    private source: 'device' | 'demo' = 'device';
    private wasConnected = false;
    private exporting = false;
    // The worker reports recording counters with each appended frame; between
    // frames the clock keeps running locally so it never appears to stall.
    private recClock: { elapsedMs: number; at: number } | undefined;
    private recTimer: number | undefined;

    @postConstruct()
    protected init(): void {
        this.id = ScopeVisionWidget.ID;
        this.title.label = ScopeVisionWidget.LABEL;
        this.title.caption = 'Nodu · 帧缓冲';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-eye';
        this.addClass('scope-widget');
        this.addClass('scope-vision-widget');
        this.node.tabIndex = 0;
        this.toDispose.push(this.toolbarChanged);
        this.toDispose.push({ dispose: () => this.stopClock() });
        this.toDispose.push(this.session.onDidChange(() => this.update()));
        this.toDispose.push(this.layoutState.onDidChange(() => { if (this.layoutState.mode === 'simple') { this.source = 'device'; } this.refresh(); }));
        this.toDispose.push(this.device.onDidChange(() => {
            if (this.device.connected && !this.wasConnected) { this.source = 'device'; }
            this.wasConnected = this.device.connected;
            this.syncClock();
            this.refresh();
        }));
        this.refresh();
    }

    protected onActivateRequest(): void { this.node.focus(); }

    showLocalDemo(): void { this.source = 'demo'; this.refresh(); }
    get showingDemo(): boolean { return this.source === 'demo'; }
    toggleDemo(): void { this.source = this.source === 'demo' ? 'device' : 'demo'; this.refresh(); }
    get exportBusy(): boolean { return this.exporting; }
    toggleFit(): void { this.imageTools.fit = !this.imageTools.fit; this.refresh(); }

    /** Re-render the body, and the title-row actions only when what they show changed. */
    private refresh(): void {
        const { state, frame } = this.device;
        this.node.classList.toggle('nodu-vision-demo', this.source === 'demo');
        const key = [this.layoutState.mode, this.source, this.device.connected, this.device.busy, state.running, state.preview,
            !!frame, state.recording?.active, state.capabilities.framebuffer, state.capabilities.script, this.imageTools.fit, this.exporting].join(':');
        if (key !== this.toolbarKey) { this.toolbarKey = key; this.toolbarChanged.fire(); }
        this.update();
    }

    private syncClock(): void {
        const recording = this.device.state.recording;
        if (!recording?.active) { this.stopClock(); return; }
        if (!this.recClock || recording.elapsedMs !== this.recClock.elapsedMs) { this.recClock = { elapsedMs: recording.elapsedMs, at: performance.now() }; }
        this.recTimer ??= window.setInterval(() => this.update(), 100);
    }
    private stopClock(): void {
        if (this.recTimer !== undefined) { window.clearInterval(this.recTimer); this.recTimer = undefined; }
        this.recClock = undefined;
    }

    /** 截图: the received JPEG as-is, or re-encoded as PNG when the name says so. */
    async exportFrame(): Promise<void> {
        const captured = this.device.frame;
        if (!captured || this.exporting) { return; }
        this.exporting = true; this.refresh();
        try {
            const uri = await this.dialogs.showSaveDialog({ title: '保存截图', saveLabel: '保存', inputValue: `nodu-frame-${captured.sequence}.jpg`, filters: { 'JPEG 图像': ['jpg', 'jpeg'], 'PNG 图像': ['png'] } }, this.workspace.tryGetRoots()[0]);
            if (!uri) { return; }
            const lower = uri.path.base.toLowerCase();
            if (!/\.(jpe?g|png)$/.test(lower)) { throw new Error('请使用 .jpg 或 .png 文件名。'); }
            const bytes = lower.endsWith('.png') ? await pngBytes(captured) : Uint8Array.from(atob(captured.data), character => character.charCodeAt(0));
            await this.files.writeFile(uri, BinaryBuffer.wrap(bytes));
            this.device.note(`截图已保存到 ${uri.path.fsPath()}`);
        } catch (error) {
            await this.messages.error(`保存截图失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.exporting = false;
            if (!this.isDisposed) { this.refresh(); }
        }
    }

    protected render(): React.ReactNode {
        if (this.source === 'device' || this.layoutState.mode === 'simple') { return this.renderDevicePreview(); }
        return this.renderDemo();
    }

    private renderDevicePreview(): React.ReactNode {
        const model = this.device;
        const { frame, state } = model;
        const cameraError = model.error && ScopeVisionWidget.CAMERA_OPS.has(model.errorOperation)
            ? <p className="nodu-fb-error" role="alert">{model.error}</p> : null;
        if (!model.connected) {
            return <div className="nodu-fb-empty"><i className="codicon codicon-plug" aria-hidden="true" /><strong>未连接设备</strong><button className="theia-button" onClick={() => void this.commands.executeCommand('scope.show-devices')}>连接设备</button></div>;
        }
        if (!frame) {
            const canStart = state.capabilities.framebuffer && state.capabilities.script;
            return <div className="nodu-fb-panel"><div className="nodu-fb-empty">
                <i className="codicon codicon-device-camera" aria-hidden="true" />
                <strong>{state.capabilities.framebuffer ? (state.running ? '等待图像' : '没有图像') : '相机未启用'}</strong>
                {canStart && !state.running && <button className="theia-button" disabled={model.busy} onClick={() => void model.startCamera()}>启动相机</button>}
            </div>{cameraError}</div>;
        }
        const recording = state.recording?.active ? state.recording : undefined;
        let status: React.ReactNode;
        if (recording) {
            const elapsed = (this.recClock?.elapsedMs ?? recording.elapsedMs) + (this.recClock ? performance.now() - this.recClock.at : 0);
            const fps = recording.elapsedMs > 0 ? (recording.frames / (recording.elapsedMs / 1000)).toFixed(1) : '0.0';
            status = <span className="nodu-fb-rec"><i aria-hidden="true" />录制 {clockText(elapsed)}<span>{sizeText(recording.bytes)}</span><span>{fps} FPS</span></span>;
        }
        return <div className="nodu-fb-panel">
            <NoduImageTools frame={frame} tools={this.imageTools} clipboard={this.clipboard} status={status} paused={!state.preview} />
            {cameraError}
        </div>;
    }

    private renderDemo(): React.ReactNode {
        const snapshot = this.session.snapshot;
        const detections = syntheticDetections(snapshot);
        const channels = [{ key: 'L', label: '亮度', min: 0, max: 100 }, { key: 'A', label: '绿 / 红', min: -128, max: 127 }, { key: 'B', label: '蓝 / 黄', min: -128, max: 127 }];
        return <div className="scope-panel-content">
            <section className="scope-preview-section" aria-label="合成帧预览">
                <div className="scope-section-heading">
                    <h2><Icon name="camera" />示例画面</h2>
                    <span className={`scope-state ${snapshot.running ? 'scope-state-active' : ''}`}><i aria-hidden="true" />{snapshot.running ? '播放中' : '已暂停'}</span>
                </div>
                <div className="scope-frame-stage"><SyntheticFrame snapshot={snapshot} /><span className="scope-frame-badge">示例</span></div>
                <div className="scope-frame-tools">
                    <label className="scope-check"><input type="checkbox" checked={snapshot.overlay} onChange={event => this.session.setOverlay(event.currentTarget.checked)} />检测叠加</label>
                    <span className="scope-mono">320 × 240</span>
                    <strong>{detections.length} 个目标</strong>
                </div>
                <div className="scope-playback">
                    <button className="theia-button secondary scope-icon-button" onClick={() => this.session.toggleRun()} title={snapshot.running ? '暂停合成序列' : '播放合成序列'} aria-label={snapshot.running ? '暂停合成序列' : '播放合成序列'}><Icon name={snapshot.running ? 'pause' : 'play'} /></button>
                    <input type="range" min={1} max={90} value={snapshot.frame} onChange={event => this.session.setFrame(Number(event.currentTarget.value))} aria-label="合成序列帧位置" aria-valuetext={`第 ${snapshot.frame} 帧，共 90 帧`} />
                    <span className="scope-frame-counter">{String(snapshot.frame).padStart(3, '0')}<span> / 090</span></span>
                </div>
                {/* Synthetic samples remain distinct from device frames through the badge and title. */}
                <label className="nodu-device-field">样本<select value={snapshot.selectedTarget} onChange={event => this.session.setTarget(event.currentTarget.value as ScopeTarget)}>{SCOPE_DEMO_TARGETS.map(target => <option value={target.id} key={target.id}>{target.label}</option>)}</select></label>
            </section>
            <section className="scope-threshold-section" aria-labelledby="scope-threshold-heading">
                <div className="scope-section-heading"><h2 id="scope-threshold-heading">LAB 阈值</h2><button className="scope-text-button" onClick={() => this.session.resetThresholds()}>重置</button></div>
                {channels.map((channel, channelIndex) => <fieldset key={channel.key} className="scope-channel">
                    <legend><strong>{channel.key}</strong><span>{channel.label}</span><code>{snapshot.threshold[channelIndex * 2]} … {snapshot.threshold[channelIndex * 2 + 1]}</code></legend>
                    {[0, 1].map(bound => {
                        const index = channelIndex * 2 + bound;
                        const label = `${channel.key} ${bound === 0 ? '下限' : '上限'}`;
                        return <label className="scope-range-row" key={bound}><span>{bound === 0 ? '下限' : '上限'}</span><input type="range" min={channel.min} max={channel.max} value={snapshot.threshold[index]} onChange={event => this.session.setThreshold(index, Number(event.currentTarget.value))} aria-label={label} /><output>{snapshot.threshold[index]}</output></label>;
                    })}
                </fieldset>)}
                <button className="theia-button scope-apply-button" disabled={this.applying} aria-busy={this.applying} onClick={() => void this.applyThresholds()}><Icon name="check" />复制参数</button>
                {this.applyError && <p className="scope-error" role="alert">{this.applyError}</p>}
            </section>
            <section className="scope-results-section" aria-labelledby="scope-results-heading">
                <div className="scope-section-heading"><h2 id="scope-results-heading">检测结果</h2></div>
                {/* This branch filters synthetic LAB metadata; it does not execute a MaixPy detector. */}
                {detections.length === 0 ? <div className="scope-empty-result"><strong>未检测到目标</strong></div> : <table className="scope-results-table"><caption className="scope-visually-hidden">示例目标坐标</caption><thead><tr><th scope="col">目标</th><th scope="col">中心坐标</th><th scope="col">LAB 样本值</th></tr></thead><tbody>{detections.map(object => <tr key={object.id}><td><span className="scope-result-dot" />GREEN {String(object.id).padStart(2, '0')}</td><td className="scope-mono">{object.x + object.width / 2}, {object.y + object.height / 2}</td><td className="scope-mono">{object.lab.join(', ')}</td></tr>)}</tbody></table>}
            </section>
        </div>;
    }

    private async applyThresholds(): Promise<void> {
        if (this.applying) { return; }
        this.applying = true;
        this.applyError = '';
        this.update();
        try {
            await this.commands.executeCommand('scope.apply-thresholds');
        } catch (error) {
            this.applyError = `无法准备参数预览：${error instanceof Error ? error.message : String(error)}`;
        } finally {
            this.applying = false;
            if (!this.isDisposed) { this.update(); }
        }
    }
}

async function pngBytes(frame: DeviceFrame): Promise<Uint8Array> {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('图像解码失败。')); image.src = `data:${frame.mime};base64,${frame.data}`; });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG 编码失败。')), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Frame actions in the 帧缓冲 title row, one item so the order is ours and the
 * row never wraps: 示例 (pro only) | 重新启动相机 | 录制 | 缩放 | 禁用 | 截图.
 * Icon buttons with tooltips, like the VS Code view title bar.
 */
@injectable()
export class ScopeVisionToolbarContribution implements TabBarToolbarContribution, CommandContribution {
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    @inject(WidgetManager) protected readonly widgets!: WidgetManager;
    private readonly changed = new Emitter<void>();

    registerCommands(registry: CommandRegistry): void {
        const vision = (): ScopeVisionWidget | undefined => this.widgets.tryGetWidget<ScopeVisionWidget>(ScopeVisionWidget.ID);
        registry.registerCommand({ id: 'scope.framebuffer.fit', label: '缩放到合适大小', category: '见微 Nodu' }, {
            execute: () => vision()?.toggleFit(), isToggled: () => vision()?.imageTools.fit ?? true,
        });
        registry.registerCommand({ id: 'scope.framebuffer.toggle-preview', label: '禁用帧缓冲区', category: '见微 Nodu' }, {
            execute: () => this.device.setPreview(!this.device.state.preview),
            isEnabled: () => this.device.connected && !this.device.busy && !!this.device.state.capabilities.framebuffer && (this.device.state.preview || !!this.device.frame),
            isToggled: () => this.device.connected && !this.device.state.preview && !!this.device.frame,
        });
        registry.registerCommand({ id: 'scope.framebuffer.snapshot', label: '保存截图…', category: '见微 Nodu' }, {
            execute: () => vision()?.exportFrame(), isEnabled: () => !!this.device.frame && !vision()?.exportBusy,
        });
    }

    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        registry.registerItem({
            id: 'nodu.framebuffer.actions',
            isVisible: widget => widget instanceof ScopeVisionWidget,
            onDidChange: this.changed.event,
            render: widget => widget instanceof ScopeVisionWidget ? this.renderActions(widget) : null,
        });
        // The registry asks isVisible only when items change; re-check when the panel is created.
        void this.widgets.getOrCreateWidget<ScopeVisionWidget>(ScopeVisionWidget.ID).then(widget => widget.onDidChangeToolbar(() => this.changed.fire()));
    }

    private renderActions(widget: ScopeVisionWidget): React.ReactNode {
        const model = this.device, state = model.state;
        const demo = widget.showingDemo && this.layoutState.mode === 'pro';
        const recording = !!state.recording?.active;
        const button = (key: string, icon: string, label: string, onClick: () => unknown, options: { disabled?: boolean; pressed?: boolean; className?: string } = {}): React.ReactNode =>
            <button key={key} type="button" className={`nodu-fb-action${options.pressed ? ' nodu-fb-action-on' : ''}${options.className ? ` ${options.className}` : ''}`}
                aria-label={label} title={label} aria-pressed={options.pressed} disabled={options.disabled} onClick={event => { event.stopPropagation(); void onClick(); }}>
                <i className={`codicon codicon-${icon}`} aria-hidden="true" />
            </button>;
        const items: React.ReactNode[] = [];
        if (this.layoutState.mode === 'pro') { items.push(button('demo', 'beaker', demo ? '返回设备相机' : '示例画面（合成，不来自设备）', () => widget.toggleDemo(), { pressed: demo })); }
        if (!demo && model.connected) {
            const cameraBlocked = model.busy || state.running || !state.capabilities.framebuffer || !state.capabilities.script;
            if (model.frame) { items.push(button('restart', 'refresh', '重新启动相机', () => model.startCamera(), { disabled: cameraBlocked })); }
            items.push(recording
                ? button('record', 'debug-stop', '停止录制', () => this.commands.executeCommand('scope.stop-recording'), { disabled: model.busy, className: 'nodu-fb-action-rec' })
                : button('record', 'record', '录制帧缓冲区', () => this.commands.executeCommand('scope.start-recording'), { disabled: model.busy || !state.preview || !state.capabilities.framebuffer }));
            items.push(button('fit', widget.imageTools.fit ? 'screen-normal' : 'screen-full', widget.imageTools.fit ? '缩放到合适大小（已开启，点击显示原始像素）' : '缩放到合适大小', () => widget.toggleFit(), { pressed: widget.imageTools.fit, disabled: !model.frame }));
            const paused = !state.preview && !!model.frame;
            items.push(button('preview', paused ? 'eye-closed' : 'eye', paused ? '启用帧缓冲区' : '禁用帧缓冲区以获得最佳性能', () => model.setPreview(!state.preview),
                { pressed: paused, disabled: model.busy || !state.capabilities.framebuffer || (!state.preview && !model.frame) }));
            items.push(button('snapshot', 'device-camera', '保存截图…', () => widget.exportFrame(), { disabled: !model.frame || widget.exportBusy }));
        }
        return <div key="nodu-fb-actions" className="nodu-fb-actions" role="toolbar" aria-label="帧缓冲操作">{items}</div>;
    }
}

@injectable()
export class ScopeDeviceWidget extends ReactWidget {
    static readonly ID = 'scope:devices';
    static readonly LABEL = '设备与连接';
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(EditorManager) protected readonly editors!: EditorManager;

    @postConstruct()
    protected init(): void {
        this.id = ScopeDeviceWidget.ID;
        this.title.label = ScopeDeviceWidget.LABEL;
        this.title.caption = '见微 Nodu · 串口、REPL 与板端文件';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-circuit-board';
        this.addClass('scope-widget');
        this.addClass('scope-device-widget');
        this.node.tabIndex = 0;
        this.toDispose.push(this.device.onDidChange(() => this.update()));
        this.update();
    }

    protected onActivateRequest(): void { void this.commands.executeCommand('scope.show-devices'); }

    protected render(): React.ReactNode {
        // Kept only for saved-layout/command compatibility; the toolbar owns the sole form.
        return null;
    }
}
