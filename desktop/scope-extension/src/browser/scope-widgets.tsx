import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { NoduDeviceModel } from './nodu-device-client';
import { NoduDevicePanel } from './nodu-device-panel';
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
                ctx.fillStyle = '#edf8ef'; ctx.font = '10px monospace';
                ctx.fillText(`0${object.id} GREEN`, x + 2, y - 8);
                const cx = x + width / 2, cy = y + height / 2;
                ctx.beginPath(); ctx.moveTo(cx - 4, cy); ctx.lineTo(cx + 4, cy); ctx.moveTo(cx, cy - 4); ctx.lineTo(cx, cy + 4); ctx.stroke();
            }
        }
        ctx.fillStyle = '#51624f'; ctx.font = '9px monospace';
        ctx.fillText('Nodu / SYNTHETIC TEST PATTERN', 12, 222);
        ctx.fillStyle = '#263c30'; ctx.fillRect(0, 230, 320, 10);
        ctx.fillStyle = '#e6eee5'; ctx.font = '6px monospace';
        ctx.fillText('LOCAL DEMO  /  SYNTHETIC IMAGE', 8, 237);
    }, [snapshot]);
    return <canvas ref={ref} width={640} height={480} role="img" aria-label={`合成测试帧 ${snapshot.frame}，${syntheticDetections(snapshot).length} 个示例检测目标`} />;
}

@injectable()
export class ScopeVisionWidget extends ReactWidget {
    static readonly ID = 'scope:vision';
    static readonly LABEL = '视觉调试';
    // Only camera/preview faults surface here; REPL/script errors stay in the console.
    private static readonly CAMERA_OPS = new Set(['启动相机', '开启预览', '暂停预览']);
    @inject(ScopeSession) protected readonly session!: ScopeSession;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    private readonly imageTools = new NoduImageToolState();
    private applying = false;
    private applyError = '';
    private source: 'device' | 'demo' = 'device';
    private wasConnected = false;

    @postConstruct()
    protected init(): void {
        this.id = ScopeVisionWidget.ID;
        this.title.label = ScopeVisionWidget.LABEL;
        this.title.caption = 'Nodu · 视觉调试';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-eye';
        this.addClass('scope-widget');
        this.addClass('scope-vision-widget');
        this.node.tabIndex = 0;
        this.toDispose.push(this.session.onDidChange(() => this.update()));
        this.toDispose.push(this.layoutState.onDidChange(() => { if (this.layoutState.mode === 'simple') { this.source = 'device'; } this.update(); }));
        this.toDispose.push(this.device.onDidChange(() => {
            if (this.device.connected && !this.wasConnected) { this.source = 'device'; }
            this.wasConnected = this.device.connected;
            this.update();
        }));
        this.update();
    }

    protected onActivateRequest(): void { this.node.focus(); }

    showLocalDemo(): void { this.source = 'demo'; this.update(); }

    protected render(): React.ReactNode {
        const snapshot = this.session.snapshot;
        const detections = syntheticDetections(snapshot);
        const channels = [{ key: 'L', label: '亮度', min: 0, max: 100 }, { key: 'A', label: '绿 / 红', min: -128, max: 127 }, { key: 'B', label: '蓝 / 黄', min: -128, max: 127 }];
        if (this.layoutState.mode === 'simple') { return <div className="scope-panel-content">{this.renderDevicePreview()}</div>; }
        return <div className="scope-panel-content">
            <div className="nodu-preview-source" role="group" aria-label="画面来源"><button className={this.source === 'device' ? 'nodu-source-selected' : ''} aria-pressed={this.source === 'device'} onClick={() => { this.source = 'device'; this.update(); }}>设备相机</button><button className={this.source === 'demo' ? 'nodu-source-selected' : ''} aria-pressed={this.source === 'demo'} onClick={() => { this.source = 'demo'; this.update(); }}>示例</button></div>
            {this.source === 'device' ? this.renderDevicePreview() : <>
            <section className="scope-preview-section" aria-label="合成帧预览">
                <div className="scope-section-heading">
                    <h2><Icon name="camera" />帧预览</h2>
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
                {/* Synthetic samples remain distinct from device frames through the source selector/badge. */}
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
            </>}
        </div>;
    }

    private renderDevicePreview(): React.ReactNode {
        const model = this.device;
        const { frame, state } = model;
        const compact = this.layoutState.mode === 'simple';
        // One camera toggle: preview on → freeze, a frame exists → resume, otherwise start the helper.
        const cameraControls = <>
            {state.preview
                ? <button className="theia-button secondary" disabled={model.busy || !state.capabilities.framebuffer} title="禁用帧缓冲区以获得最佳性能" onClick={() => void model.setPreview(false)}><i className="codicon codicon-debug-pause" aria-hidden="true" />禁用</button>
                : frame
                    ? <button className="theia-button secondary" disabled={model.busy || !state.capabilities.framebuffer} title="恢复帧缓冲区" onClick={() => void model.setPreview(true)}><i className="codicon codicon-play" aria-hidden="true" />启用</button>
                    : <button className="theia-button secondary" disabled={model.busy || state.running || !state.capabilities.framebuffer || !state.capabilities.script} onClick={() => void model.startCamera()}><i className="codicon codicon-play" aria-hidden="true" />启动相机</button>}
            {frame && <button className="theia-button secondary scope-icon-button" aria-label="重新启动相机" title="重新启动相机" disabled={model.busy || state.running || !state.capabilities.framebuffer || !state.capabilities.script} onClick={() => void model.startCamera()}><i className="codicon codicon-refresh" aria-hidden="true" /></button>}
            {state.recording?.active
                ? <button className="theia-button secondary nodu-recording-active" aria-label="结束录制" title={`结束录制 · ${state.recording.path}`} disabled={model.busy} onClick={() => void this.commands.executeCommand('scope.stop-recording')}><i className="codicon codicon-debug-stop" aria-hidden="true" />结束录制</button>
                : <button className="theia-button secondary scope-icon-button" aria-label="录制" title="录制帧缓冲区" disabled={model.busy || !state.preview || !state.capabilities.framebuffer} onClick={() => void this.commands.executeCommand('scope.start-recording')}><i className="codicon codicon-record" aria-hidden="true" /></button>}
            {state.recording?.active && <span className="scope-mono nodu-rec-status" role="status">{`${Math.round(state.recording.elapsedMs / 1000)} 秒 · ${state.recording.bytes} B · ${state.recording.elapsedMs > 0 ? (state.recording.frames / (state.recording.elapsedMs / 1000)).toFixed(1) : '0'} FPS`}</span>}
            {state.running && !compact && <button className="theia-button secondary" onClick={() => void model.stop()}>停止脚本</button>}
        </>;
        return <section className="scope-preview-section" aria-label="设备相机预览">
            {!compact && <div className="scope-section-heading"><h2><Icon name="camera" />设备相机</h2><span className={`scope-state ${model.connected ? 'scope-state-active' : ''}`}><i aria-hidden="true" />{model.connected ? (state.preview ? '预览中' : '预览暂停') : model.statusLabel}</span></div>}
            {model.connected ? <>
                {frame ? <NoduImageTools frame={frame} tools={this.imageTools} files={this.files} dialogs={this.dialogs} clipboard={this.clipboard} compact={compact} leading={cameraControls} /> : <><div className="scope-device-actions nodu-camera-actions">{cameraControls}</div><div className="scope-frame-stage nodu-camera-stage"><div className="nodu-preview-empty"><i className="codicon codicon-device-camera" aria-hidden="true" /><strong>{state.capabilities.framebuffer ? '等待图像' : '相机未启用'}</strong></div></div></>}
                {/* IDE framebuffer keeps streaming frames while a script runs. */}
                {model.error && ScopeVisionWidget.CAMERA_OPS.has(model.errorOperation) && <p className="scope-error" role="alert">{model.error}</p>}
            </> : <div className="nodu-preview-empty"><i className="codicon codicon-plug" aria-hidden="true" /><strong>未连接设备</strong><button className="theia-button" onClick={() => void this.commands.executeCommand('scope.show-devices')}>连接设备</button></div>}
        </section>;
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
