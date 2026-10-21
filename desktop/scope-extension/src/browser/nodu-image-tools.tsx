// SPDX-License-Identifier: MIT
// Frame buffer image tools. Color math runs in the pinned Rust/WASM core
// (nodu-imaging.ts); this file owns decode, ROI geometry and presentation.
// Two layouts share one decoder and canvas:
//  - 'panel': the 帧缓冲 sidebar. The frame scales into whatever height is
//    left over and the histogram block has a fixed height, so the sidebar
//    never scrolls and never resizes when the color space changes.
//  - 'threshold': the 阈值编辑器 dialog (frame, pixel readout, threshold mask).
import * as React from '@theia/core/shared/react';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { DeviceFrame } from '../common/nodu-device-protocol';
import {
    analysisSize, clamp, clampRect, DEFAULT_LAB_THRESHOLD, ImagePoint, ImageRect,
    rectFromPoints, thresholdTuple, updateThreshold
} from './nodu-image-analysis';
import { analyze, binary, labRaster, frameDataWithinLimit, ColorSpace, NativeHistogram, ThresholdMode } from './nodu-imaging';
import { NoduImageToolState } from './nodu-image-state';
import { histogramResolutionText } from '../common/nodu-status';
import { copyImageParameters } from './nodu-image-clipboard';
import '../../style/image-tools.css';

interface Props {
    frame: DeviceFrame; tools: NoduImageToolState; clipboard: ClipboardService;
    variant?: 'panel' | 'threshold';
    /** Panel only: replaces the pixel readout, e.g. with the recording clock. */
    status?: React.ReactNode;
    /** Panel only: the board has stopped sending frames (禁用). */
    paused?: boolean;
}
interface DecodedFrame {
    frame: DeviceFrame;
    original: HTMLCanvasElement;
    width: number; height: number;
    rgba: Uint8ClampedArray;
}
interface PixelSample { x: number; y: number; rgb: [number, number, number]; lab: [number, number, number]; }
type Analysis<T> = { value: T } | { error: string };
const failed = (error: unknown): { error: string } => ({ error: error instanceof Error ? error.message : String(error) });

/** Single-pixel LAB via the pinned IDE lookup table (same path as the mask). */
function samplePixel(image: DecodedFrame, point: ImagePoint): PixelSample {
    const x = Math.floor(clamp(point.x, 0, image.width - 1)), y = Math.floor(clamp(point.y, 0, image.height - 1));
    const offset = (y * image.width + x) * 4;
    const rgb: [number, number, number] = [image.rgba[offset], image.rgba[offset + 1], image.rgba[offset + 2]];
    const lab = labRaster(new Uint8ClampedArray([...rgb, 255]), 1, 1);
    return { x, y, rgb, lab: [lab[0], lab[1], lab[2]] };
}

/** Content-box size of an element, kept current with a ResizeObserver. */
function useBoxSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
    const [size, setSize] = React.useState({ width: 0, height: 0 });
    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) { return; }
        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [ref]);
    return size;
}

const CHANNEL_CLASSES = ['nodu-image-histogram-red', 'nodu-image-histogram-green', 'nodu-image-histogram-blue'];
// Stat order matches the original histogram .ui (Mean/Median/Mode/StDev,
// then Min/Max/LQ/UQ); labels are the original's 中文 strings.
const STAT_LABELS: [keyof NativeHistogram['channels'][number]['statistics'], string][] = [
    ['mean', '平均数'], ['median', '中位数'], ['mode', '众数'], ['stdev', 'StDev'],
    ['min', '最小'], ['max', '最大'], ['lq', 'LQ'], ['uq', 'UQ'],
];

/** One plot per channel (each scaled to its own peak) plus one stats table. */
function HistogramCharts({ histogram, space }: { histogram: NativeHistogram; space: ColorSpace }): React.ReactElement {
    const channelClass = (index: number): string => space === 'gray' ? 'nodu-image-histogram-gray' : CHANNEL_CLASSES[index] ?? 'nodu-image-histogram-gray';
    return <>
        <div className="nodu-fb-charts">{histogram.channels.map((channel, index) => {
            const first = channel.values[0], last = channel.values[channel.values.length - 1];
            const peak = Math.max(1, ...channel.bins);
            const span = Math.max(1, channel.bins.length - 1);
            const line = Array.from(channel.bins, (count, bin) => `${bin ? 'L' : 'M'}${(bin / span * 256).toFixed(2)},${(62 - count / peak * 58).toFixed(2)}`).join('');
            return <figure className="nodu-fb-chart" key={channel.name} title={`${channel.name} · ${first}…${last} · ${histogram.count.toLocaleString()} 像素`}>
                <span className={`nodu-fb-chart-label ${channelClass(index)}`} aria-hidden="true">{channel.name}</span>
                <div className="nodu-fb-chart-plot">
                    <svg viewBox="0 0 256 64" preserveAspectRatio="none" role="img" aria-label={`${channel.name} 通道直方图，定义域 ${first}…${last}`}>
                        <path className="nodu-image-histogram-axis" d="M0 63.5H256" vectorEffect="non-scaling-stroke" />
                        <path className={`${channelClass(index)} nodu-fb-chart-area`} d={`${line}L256,64L0,64Z`} />
                        <path className={channelClass(index)} d={line} fill="none" vectorEffect="non-scaling-stroke" />
                    </svg>
                    <span className="nodu-fb-axis nodu-fb-axis-min" aria-hidden="true">{first}</span>
                    <span className="nodu-fb-axis nodu-fb-axis-max" aria-hidden="true">{last}</span>
                </div>
            </figure>;
        })}</div>
        <div className="nodu-fb-stats"><table><thead><tr><th scope="col"><span className="scope-visually-hidden">通道</span></th>{STAT_LABELS.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}</tr></thead>
            <tbody>{histogram.channels.map((channel, index) => <tr key={channel.name}><th scope="row" className={channelClass(index)}>{channel.name}</th>{STAT_LABELS.map(([key]) => <td key={key}>{channel.statistics[key]}</td>)}</tr>)}</tbody>
        </table></div>
    </>;
}

/** All operations use decoded device frames; LAB values come from the pinned lookup, not sensor pixels. */
export function NoduImageTools({ frame, tools, clipboard, variant = 'panel', status, paused = false }: Props): React.ReactElement {
    const panel = variant === 'panel';
    const [, update] = React.useReducer(value => value + 1, 0);
    const [image, setImage] = React.useState<DecodedFrame>();
    const [decoding, setDecoding] = React.useState(false);
    const [decodeError, setDecodeError] = React.useState('');
    const [pixel, setPixel] = React.useState<PixelSample>();
    const [feedback, setFeedback] = React.useState<{ error: boolean; text: string }>();
    // The dialog keeps its own zoom; the panel follows tools.fit (the 缩放 action).
    const [dialogZoom, setDialogZoom] = React.useState<'fit' | '100' | '200'>('fit');
    const canvas = React.useRef<HTMLCanvasElement>(null);
    const stage = React.useRef<HTMLDivElement>(null);
    const stageSize = useBoxSize(stage);
    const decodeGeneration = React.useRef(0);
    const drag = React.useRef<ImagePoint | undefined>(undefined);
    const alive = React.useRef(true);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    React.useEffect(() => {
        const generation = ++decodeGeneration.current;
        let cancelled = false;
        const current = (): boolean => !cancelled && generation === decodeGeneration.current;
        const source = new Image();
        setDecoding(true); setDecodeError('');
        source.onload = () => {
            try {
                const width = source.naturalWidth, height = source.naturalHeight;
                // Validation only: analysis runs on the whole decoded raster so
                // ROI and pixel counts match the source frame 1:1.
                analysisSize(width, height);
                const original = document.createElement('canvas');
                original.width = width; original.height = height;
                const context = original.getContext('2d', { willReadFrequently: true });
                if (!context) { throw new Error('当前图形环境无法读取 Canvas 像素。'); }
                context.drawImage(source, 0, 0);
                const rgba = context.getImageData(0, 0, width, height).data;
                if (!current()) { return; }
                if (tools.roi) { tools.roi = clampRect(tools.roi, width, height); }
                const next = { frame, original, width, height, rgba };
                setImage(next);
                setPixel(tools.samplePoint ? samplePixel(next, tools.samplePoint) : undefined);
                setDecoding(false);
            } catch (error) {
                if (current()) { setDecodeError(`图像处理失败：${error instanceof Error ? error.message : String(error)}`); setDecoding(false); }
            }
        };
        source.onerror = () => { if (current()) { setDecodeError('图像解码失败。请暂停后重新接收图像。'); setDecoding(false); } };
        // Avoid unbounded decode allocations even if a remote device sends invalid metadata.
        if (!frameDataWithinLimit(frame.data.length) || !/^image\/(jpeg|png)$/.test(frame.mime)) {
            setDecodeError('设备帧格式或大小超过图像工具上限。'); setDecoding(false);
        } else {
            try {
                // File sources may carry no declared size; the decoded size is
                // what the pixel cap enforces.
                if (frame.width > 0 && frame.height > 0) { analysisSize(frame.width, frame.height); }
                source.src = `data:${frame.mime};base64,${frame.data}`;
            }
            catch (error) { setDecodeError(error instanceof Error ? error.message : String(error)); setDecoding(false); }
        }
        return () => { cancelled = true; source.onload = null; source.onerror = null; source.src = ''; };
    }, [frame, tools]);

    const roiKey = tools.roi ? `${tools.roi.x}:${tools.roi.y}:${tools.roi.width}:${tools.roi.height}` : '';
    const distribution = React.useMemo<Analysis<NativeHistogram> | undefined>(() => {
        if (!panel || !image) { return undefined; }
        try { return { value: analyze(image.rgba, image.width, image.height, tools.roi, tools.histogram) }; }
        catch (error) { return failed(error); }
    }, [panel, image, tools.histogram, roiKey]);
    const activeBounds: readonly number[] = tools.thresholdMode === 'lab' ? tools.threshold : tools.grayThreshold;
    const boundsKey = `${tools.thresholdMode}:${activeBounds.join(':')}:${tools.invert}`;
    const mask = React.useMemo<Analysis<{ rgba: Uint8ClampedArray; matched: number; total: number }> | undefined>(() => {
        if (panel || !image || !tools.mask) { return undefined; }
        try {
            const rgba = binary(image.rgba, image.width, image.height, tools.roi, activeBounds, tools.thresholdMode, tools.invert);
            // Count white output within the ROI only; outside stays black.
            const rect = clampRect(tools.roi, image.width, image.height);
            let matched = 0;
            for (let y = rect.y; y < rect.y + rect.height; y++) {
                for (let x = rect.x; x < rect.x + rect.width; x++) {
                    if (rgba[(y * image.width + x) * 4] === 255) { matched++; }
                }
            }
            return { value: { rgba, matched, total: rect.width * rect.height } };
        } catch (error) { return failed(error); }
    }, [panel, image, tools.mask, boundsKey, roiKey]);
    const maskResult = mask && 'value' in mask ? mask.value : undefined;
    React.useEffect(() => {
        const target = canvas.current, context = target?.getContext('2d');
        if (!target || !context || !image) { return; }
        target.width = image.width; target.height = image.height;
        if (maskResult) {
            const pixels = context.createImageData(image.width, image.height);
            pixels.data.set(maskResult.rgba);
            context.putImageData(pixels, 0, 0);
        } else { context.drawImage(image.original, 0, 0); }
    }, [image, maskResult]);

    const pointAt = (event: React.PointerEvent<HTMLCanvasElement>): ImagePoint | undefined => {
        if (!image) { return undefined; }
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) { return undefined; }
        return { x: Math.floor(clamp((event.clientX - rect.left) / rect.width * image.width, 0, image.width - 1)), y: Math.floor(clamp((event.clientY - rect.top) / rect.height * image.height, 0, image.height - 1)) };
    };
    const inspect = (point: ImagePoint): void => {
        if (!image) { return; }
        tools.samplePoint = point;
        try { setPixel(samplePixel(image, point)); }
        catch (error) { if (alive.current) { setFeedback({ error: true, text: `像素采样失败：${error instanceof Error ? error.message : String(error)}` }); } }
    };
    const changeRoi = (rect: ImageRect | undefined): void => { tools.roi = rect; update(); };
    const release = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        if (!drag.current) { return; }
        const point = pointAt(event);
        if (point && image) { changeRoi(rectFromPoints(drag.current, point, image.width, image.height)); }
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); }
    };
    const activeTuple = tools.thresholdMode === 'lab' ? thresholdTuple(tools.threshold) : `(${tools.grayThreshold[0]}, ${tools.grayThreshold[1]})`;
    const copy = async (): Promise<void> => {
        try { await copyImageParameters(clipboard, activeTuple); if (alive.current) { setFeedback({ error: false, text: '已复制' }); } }
        catch (error) { if (alive.current) { setFeedback({ error: true, text: `复制失败：${error instanceof Error ? error.message : String(error)}` }); } }
    };

    const roi = image ? clampRect(tools.roi, image.width, image.height) : undefined;
    // Panel: scale into the stage box (contain); 缩放 off shows native pixels.
    // Dialog: the old 适配 / 100% / 200% select, capped at a 260px tall viewport.
    let rasterStyle: React.CSSProperties = { width: '100%' };
    let canvasStyle: React.CSSProperties = { width: '100%', height: 'auto' };
    let pixelated = !panel && dialogZoom !== 'fit';
    if (image && panel) {
        const scale = tools.fit ? Math.min(stageSize.width / image.width, stageSize.height / image.height) : 1;
        if (scale > 0 && Number.isFinite(scale)) {
            const width = Math.max(1, Math.floor(image.width * scale)), height = Math.max(1, Math.floor(image.height * scale));
            rasterStyle = { width, height };
            canvasStyle = { width, height };
        }
        pixelated = !tools.fit || scale >= 2;
    } else if (image) {
        const zoom = dialogZoom === 'fit' ? undefined : Number(dialogZoom) / 100;
        rasterStyle = zoom ? { width: image.width * zoom } : { width: `min(100%, ${(260 * image.width / image.height).toFixed(0)}px)`, marginInline: 'auto' };
    }
    const raster = image
        ? <div className={`nodu-image-raster${pixelated ? ' nodu-image-pixelated' : ''}`} style={rasterStyle}>
            <canvas ref={canvas} role="img" tabIndex={0} aria-label={`设备帧 ${image.frame.sequence}。拖拽选择 ROI；Escape 清除选区。像素查看始终使用原图。`} style={canvasStyle}
                onPointerDown={event => { if (event.button !== 0) { return; } const point = pointAt(event); if (point) { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = point; inspect(point); changeRoi(rectFromPoints(point, point, image.width, image.height)); } }}
                onPointerMove={event => { const point = pointAt(event); if (!point) { return; } inspect(point); if (drag.current) { changeRoi(rectFromPoints(drag.current, point, image.width, image.height)); } }}
                onPointerUp={release} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}
                onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); drag.current = undefined; changeRoi(undefined); } }} />
            {tools.roi && roi && <svg className="nodu-image-roi-overlay" viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="none" aria-hidden="true"><rect x={roi.x} y={roi.y} width={roi.width} height={roi.height} vectorEffect="non-scaling-stroke" /></svg>}
        </div>
        : <div className="nodu-preview-empty" aria-label={decodeError ? '图像不可用' : '加载图像'}><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /></div>;
    const pixelText = pixel ? `(${pixel.x}, ${pixel.y})  RGB ${pixel.rgb.join(', ')}  LAB ${pixel.lab.join(', ')}` : undefined;

    if (panel) {
        const readout = pixelText ?? (image ? `#${image.frame.sequence} · ${image.width} × ${image.height}` : '');
        return <div className="nodu-fb">
            <div className="nodu-fb-stage" ref={stage} aria-busy={decoding}>
                {raster}
                {paused && <span className="nodu-fb-badge" aria-hidden="true">已禁用</span>}
            </div>
            <div className="nodu-fb-status" role="status" title={typeof status === 'string' ? status : readout}>{status ?? readout}</div>
            {(decodeError || feedback?.error) && <p className="nodu-fb-error" role="alert">{decodeError ? `${decodeError}${image ? '（保留上一帧）' : ''}` : feedback?.text}</p>}
            <section className="nodu-fb-histogram" aria-label="直方图">
                <div className="nodu-fb-histogram-head">
                    <h3>{tools.roi ? '选区直方图' : '直方图'}</h3>
                    <select aria-label="直方图色彩空间" title="使用灰度/LAB进行颜色跟踪" value={tools.histogram} onChange={event => { tools.histogram = event.currentTarget.value as ColorSpace; update(); }}><option value="rgb">RGB色彩空间</option><option value="gray">灰度色彩空间</option><option value="lab">LAB色彩空间</option><option value="yuv">YUV色彩空间</option></select>
                </div>
                <div className="nodu-fb-res"><span title={histogramResolutionText(image?.width, image?.height, tools.roi ?? undefined)}>{histogramResolutionText(image?.width, image?.height, tools.roi ?? undefined)}</span>{tools.roi && <button className="scope-text-button" onClick={() => changeRoi(undefined)}>清除选区</button>}</div>
                {distribution && 'value' in distribution && <HistogramCharts histogram={distribution.value} space={tools.histogram} />}
                {distribution && 'error' in distribution && <p className="nodu-fb-error" role="alert">直方图分析失败：{distribution.error}</p>}
            </section>
        </div>;
    }

    const labChannels = [{ name: 'L', description: '亮度', min: 0, max: 100 }, { name: 'A', description: '绿 / 红', min: -128, max: 127 }, { name: 'B', description: '蓝 / 黄', min: -128, max: 127 }];
    const grayChannels = [{ name: 'Y', description: '灰度', min: 0, max: 255 }];
    const thresholdChannels = tools.thresholdMode === 'lab' ? labChannels : grayChannels;
    const resetThreshold = (): void => {
        if (tools.thresholdMode === 'lab') { tools.threshold = [...DEFAULT_LAB_THRESHOLD]; }
        else { tools.grayThreshold = [0, 255]; }
        tools.invert = false;
        update();
    };
    const setBound = (index: number, value: number): void => {
        if (tools.thresholdMode === 'lab') {
            tools.threshold = updateThreshold(tools.threshold, index, value);
        } else {
            const next: [number, number] = [...tools.grayThreshold];
            next[index] = Math.round(clamp(value, 0, 255));
            const paired = index === 0 ? 1 : 0;
            next[paired] = index === 0 ? Math.max(next[paired], next[index]) : Math.min(next[paired], next[index]);
            tools.grayThreshold = next;
        }
        update();
    };
    return <div className="nodu-image-tools nodu-image-tools-threshold">
        <div className="nodu-image-toolbar"><select aria-label="缩放" title="缩放到合适大小" value={dialogZoom} onChange={event => setDialogZoom(event.currentTarget.value as typeof dialogZoom)}><option value="fit">适配</option><option value="100">100%</option><option value="200">200%</option></select></div>
        <div className="nodu-image-frame">
            <div className="nodu-image-viewport" aria-busy={decoding}>{raster}</div>
            {image && <span className="nodu-image-badge" aria-hidden="true">#{image.frame.sequence} · {image.width} × {image.height}{tools.mask ? ` · ${tools.thresholdMode.toUpperCase()}` : ''}</span>}
        </div>
        {decodeError && <p className="scope-error" role="alert">{decodeError}{image ? '（保留上一帧）' : ''}</p>}
        <div className="nodu-image-pixel" aria-label="原图像素值"><span className="nodu-image-swatch" style={{ backgroundColor: pixel ? `rgb(${pixel.rgb.join(',')})` : 'transparent' }} aria-hidden="true" /><div>{pixel ? <><span className="scope-mono">({pixel.x}, {pixel.y}) · RGB {pixel.rgb.join(', ')}</span><span className="scope-mono" title="按原版 IDE 查表；JPEG 像素可能与传感器原始像素不同。">LAB {pixel.lab.join(', ')}</span></> : <span>RGB / LAB —</span>}</div></div>
        <section className="nodu-image-tool-section" aria-label="阈值"><div className="nodu-image-tool-heading"><h3>{tools.thresholdMode === 'lab' ? 'LAB 阈值' : '灰度阈值'}</h3><select aria-label="阈值模式" value={tools.thresholdMode} onChange={event => { tools.thresholdMode = event.currentTarget.value as ThresholdMode; update(); }}><option value="lab">LAB</option><option value="gray">灰度</option></select><button className="scope-text-button" onClick={resetThreshold}>重置</button></div><label className="scope-check nodu-image-mask-toggle"><input type="checkbox" checked={tools.mask} disabled={!image} onChange={event => { tools.mask = event.currentTarget.checked; update(); }} />阈值蒙版{tools.roi ? '（选区）' : ''}</label><label className="scope-check nodu-image-mask-toggle"><input type="checkbox" checked={tools.invert} disabled={!image} onChange={event => { tools.invert = event.currentTarget.checked; update(); }} />反向</label>
            {thresholdChannels.map((channel, channelIndex) => <fieldset className="scope-channel" key={channel.name}><legend><strong>{channel.name}</strong><span>{channel.description}</span><code>{activeBounds[channelIndex * 2]} … {activeBounds[channelIndex * 2 + 1]}</code></legend>{[0, 1].map(bound => { const index = channelIndex * 2 + bound; return <label className="scope-range-row" key={bound}><span>{bound ? '上限' : '下限'}</span><input type="range" min={channel.min} max={channel.max} aria-label={`${channel.name} ${bound ? '上限' : '下限'}`} value={activeBounds[index]} onChange={event => setBound(index, Number(event.currentTarget.value))} /><output>{activeBounds[index]}</output></label>; })}</fieldset>)}
            {maskResult && <p className="nodu-image-mask-count">白色命中 {maskResult.matched.toLocaleString()} / {maskResult.total.toLocaleString()} 像素 · {(100 * maskResult.matched / maskResult.total).toFixed(1)}%</p>}
            {mask && 'error' in mask && <p className="scope-error" role="alert">阈值蒙版失败：{mask.error}</p>}
            {/* LAB 数值来自原版 IDE 查表；JPEG 像素可能与传感器原始像素不同。 */}
            <div className="nodu-image-copy"><code tabIndex={0} aria-label="可复制的阈值 Python 元组" title="按原版 IDE 查表；JPEG 像素可能与传感器原始像素不同。">{activeTuple}</code><button className="theia-button secondary" onClick={() => void copy()}><i className="codicon codicon-copy" aria-hidden="true" />复制参数</button></div>
        </section>
        {feedback && <p className={feedback.error ? 'scope-error' : 'nodu-image-feedback'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    </div>;
}
