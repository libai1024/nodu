// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { DeviceFrame } from '../common/nodu-device-protocol';
import {
    analysisSize, buildLabRaster, clamp, clampRect, DEFAULT_LAB_THRESHOLD, histogram,
    ImageHistogram, ImagePoint, ImageRect, rectFromPoints, rgbToLab, scaleRect,
    thresholdMask, thresholdTuple, updateThreshold
} from './nodu-image-analysis';
import { NoduImageToolState } from './nodu-image-state';
import { copyImageParameters } from './nodu-image-clipboard';
import '../../style/image-tools.css';

interface Props { frame: DeviceFrame; tools: NoduImageToolState; files: FileService; dialogs: FileDialogService; clipboard: ClipboardService; compact?: boolean; leading?: React.ReactNode; }
interface DecodedFrame {
    frame: DeviceFrame;
    original: HTMLCanvasElement;
    width: number; height: number;
    analysisWidth: number; analysisHeight: number;
    rgba: Uint8ClampedArray; lab: Float32Array;
}
interface PixelSample { x: number; y: number; rgb: [number, number, number]; lab: [number, number, number]; }

function samplePixel(image: DecodedFrame, point: ImagePoint): PixelSample {
    const x = Math.floor(clamp(point.x, 0, image.width - 1)), y = Math.floor(clamp(point.y, 0, image.height - 1));
    const value = image.original.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, 1, 1).data;
    return { x, y, rgb: [value[0], value[1], value[2]], lab: rgbToLab(value[0], value[1], value[2]) };
}

function Histogram({ values, mode }: { values: ImageHistogram; mode: 'rgb' | 'gray' }): React.ReactElement {
    const entries = mode === 'rgb' ? [{ key: 'red', label: 'R', values: values.red }, { key: 'green', label: 'G', values: values.green }, { key: 'blue', label: 'B', values: values.blue }] : [{ key: 'gray', label: 'Y′', values: values.gray }];
    let max = 1;
    for (const entry of entries) { for (const value of entry.values) { max = Math.max(max, value); } }
    return <>
        <svg className="nodu-image-histogram" viewBox="0 0 256 68" preserveAspectRatio="none" role="img" aria-label={`${mode === 'rgb' ? 'RGB' : '灰度'}直方图，${values.count} 个采样像素，横轴 0 到 255，各通道使用相同纵轴`}>
            <path className="nodu-image-histogram-axis" d="M0 2V64H256" />
            {entries.map(entry => <path key={entry.key} className={`nodu-image-histogram-${entry.key}`} d={Array.from(entry.values, (count, index) => `${index ? 'L' : 'M'}${index},${(64 - count / max * 60).toFixed(2)}`).join('')} fill="none" vectorEffect="non-scaling-stroke" />)}
        </svg>
        <div className="nodu-image-histogram-axis-labels"><span>0</span><span className="nodu-image-histogram-legend">{entries.map(entry => <span key={entry.key} className={`nodu-image-histogram-${entry.key}`}>{entry.label}</span>)}<span>峰值 {max}</span></span><span>255</span></div>
    </>;
}

/** All operations use decoded device JPEGs; no detection or board-side LAB claim. */
export function NoduImageTools({ frame, tools, files, dialogs, clipboard, compact = false, leading }: Props): React.ReactElement {
    const [, update] = React.useReducer(value => value + 1, 0);
    const [image, setImage] = React.useState<DecodedFrame>();
    const [decoding, setDecoding] = React.useState(false);
    const [decodeError, setDecodeError] = React.useState('');
    const [pixel, setPixel] = React.useState<PixelSample>();
    const [feedback, setFeedback] = React.useState<{ error: boolean; text: string }>();
    const [exporting, setExporting] = React.useState(false);
    const canvas = React.useRef<HTMLCanvasElement>(null);
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
        source.onload = () => void (async () => {
            try {
                const width = source.naturalWidth, height = source.naturalHeight;
                const size = analysisSize(width, height);
                const original = document.createElement('canvas');
                original.width = width; original.height = height;
                const context = original.getContext('2d', { willReadFrequently: true });
                if (!context) { throw new Error('当前图形环境无法读取 Canvas 像素。'); }
                context.drawImage(source, 0, 0);
                const analysis = document.createElement('canvas');
                analysis.width = size.width; analysis.height = size.height;
                const analysisContext = analysis.getContext('2d', { willReadFrequently: true });
                if (!analysisContext) { throw new Error('当前图形环境无法创建分析图像。'); }
                analysisContext.drawImage(original, 0, 0, size.width, size.height);
                const rgba = analysisContext.getImageData(0, 0, size.width, size.height).data;
                const lab = await buildLabRaster(rgba, size.width, size.height, current, () => new Promise(resolve => setTimeout(resolve, 0)));
                if (!current() || !lab) { return; }
                if (tools.roi) { tools.roi = clampRect(tools.roi, width, height); }
                const next = { frame, original, width, height, analysisWidth: size.width, analysisHeight: size.height, rgba, lab };
                setImage(next);
                setPixel(tools.samplePoint ? samplePixel(next, tools.samplePoint) : undefined);
                setDecoding(false);
            } catch (error) {
                if (current()) { setDecodeError(`图像处理失败：${error instanceof Error ? error.message : String(error)}`); setDecoding(false); }
            }
        })();
        source.onerror = () => { if (current()) { setDecodeError('JPEG 解码失败。请暂停后重新接收设备图像。'); setDecoding(false); } };
        // Avoid unbounded decode allocations even if a remote device sends invalid metadata.
        if (frame.data.length > 6 * 1024 * 1024 || frame.mime !== 'image/jpeg') {
            setDecodeError('设备帧格式或大小超过图像工具上限。'); setDecoding(false);
        } else {
            try { analysisSize(frame.width, frame.height); source.src = `data:image/jpeg;base64,${frame.data}`; }
            catch (error) { setDecodeError(error instanceof Error ? error.message : String(error)); setDecoding(false); }
        }
        return () => { cancelled = true; source.onload = null; source.onerror = null; source.src = ''; };
    }, [frame, tools]);

    const roiKey = tools.roi ? `${tools.roi.x}:${tools.roi.y}:${tools.roi.width}:${tools.roi.height}` : '';
    const analysisRoi = React.useMemo(() => image ? scaleRect(tools.roi, image.width, image.height, image.analysisWidth, image.analysisHeight) : undefined, [image, roiKey]);
    const distribution = React.useMemo(() => image ? histogram(image.rgba, image.analysisWidth, image.analysisHeight, analysisRoi) : undefined, [image, analysisRoi]);
    const thresholdKey = tools.threshold.join(':');
    const mask = React.useMemo(() => image && tools.mask ? thresholdMask(image.lab, image.analysisWidth, image.analysisHeight, tools.threshold, analysisRoi) : undefined, [image, tools.mask, thresholdKey, analysisRoi]);
    React.useEffect(() => {
        const target = canvas.current, context = target?.getContext('2d');
        if (!target || !context || !image) { return; }
        target.width = image.width; target.height = image.height;
        if (mask) {
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = image.analysisWidth; maskCanvas.height = image.analysisHeight;
            const maskContext = maskCanvas.getContext('2d')!;
            const pixels = maskContext.createImageData(image.analysisWidth, image.analysisHeight);
            pixels.data.set(mask.rgba); maskContext.putImageData(pixels, 0, 0);
            context.imageSmoothingEnabled = false;
            context.drawImage(maskCanvas, 0, 0, image.width, image.height);
        } else { context.drawImage(image.original, 0, 0); }
    }, [image, mask]);

    const pointAt = (event: React.PointerEvent<HTMLCanvasElement>): ImagePoint | undefined => {
        if (!image) { return undefined; }
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) { return undefined; }
        return { x: Math.floor(clamp((event.clientX - rect.left) / rect.width * image.width, 0, image.width - 1)), y: Math.floor(clamp((event.clientY - rect.top) / rect.height * image.height, 0, image.height - 1)) };
    };
    const inspect = (point: ImagePoint): void => { if (image) { tools.samplePoint = point; setPixel(samplePixel(image, point)); } };
    const changeRoi = (rect: ImageRect | undefined): void => { tools.roi = rect; update(); };
    const release = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        if (!drag.current) { return; }
        const point = pointAt(event);
        if (point && image) { changeRoi(rectFromPoints(drag.current, point, image.width, image.height)); }
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); }
    };
    const copy = async (): Promise<void> => {
        try { await copyImageParameters(clipboard, thresholdTuple(tools.threshold)); if (alive.current) { setFeedback({ error: false, text: '已复制' }); } }
        catch (error) { if (alive.current) { setFeedback({ error: true, text: `复制失败：${error instanceof Error ? error.message : String(error)}` }); } }
    };
    const exportImage = async (): Promise<void> => {
        if (!image || exporting) { return; }
        const captured = image, format = tools.exportFormat;
        setExporting(true); setFeedback(undefined);
        try {
            const extension = format === 'jpeg' ? 'jpg' : 'png';
            const uri = await dialogs.showSaveDialog({ title: '导出原图', inputValue: `nodu-camera-${captured.frame.time}-${captured.frame.sequence}.${extension}`, saveLabel: '导出原图', filters: format === 'png' ? { PNG: ['png'] } : { JPEG: ['jpg', 'jpeg'] } });
            if (!uri) { return; }
            const lowerName = uri.path.base.toLowerCase();
            if (format === 'png' ? !lowerName.endsWith('.png') : !/\.jpe?g$/.test(lowerName)) { throw new Error(`请使用 .${extension} 文件名，或选择对应的导出格式。`); }
            if (await files.exists(uri)) { throw new Error('文件已经存在，请选择新文件名。'); }
            let bytes: Uint8Array;
            if (format === 'jpeg') {
                // Preserve the actual received JPEG, rather than recompressing the mask/display.
                const raw = atob(captured.frame.data);
                bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
            } else {
                const blob = await new Promise<Blob>((resolve, reject) => captured.original.toBlob(value => value ? resolve(value) : reject(new Error('PNG 编码失败。')), 'image/png'));
                bytes = new Uint8Array(await blob.arrayBuffer());
            }
            await files.createFile(uri, BinaryBuffer.wrap(bytes), { overwrite: false });
            if (alive.current) { setFeedback({ error: false, text: `已导出 ${uri.path.base}` }); }
        } catch (error) { if (alive.current) { setFeedback({ error: true, text: `导出失败：${error instanceof Error ? error.message : String(error)}` }); } }
        finally { if (alive.current) { setExporting(false); } }
    };

    const roi = image ? clampRect(tools.roi, image.width, image.height) : undefined;
    const downsampled = image && (image.analysisWidth !== image.width || image.analysisHeight !== image.height);
    const zoom = tools.zoom === 'fit' ? undefined : Number(tools.zoom) / 100;
    const channels = [{ name: 'L', description: '亮度', min: 0, max: 100 }, { name: 'A', description: '绿 / 红', min: -128, max: 127 }, { name: 'B', description: '蓝 / 黄', min: -128, max: 127 }];
    return <div className="nodu-image-tools">
        <div className="nodu-image-toolbar">{leading && <div className="nodu-image-toolbar-leading">{leading}</div>}<div className="nodu-image-toolbar-controls"><select aria-label="图像缩放" value={tools.zoom} onChange={event => { tools.zoom = event.currentTarget.value as typeof tools.zoom; update(); }}><option value="fit">适配</option><option value="100">100%</option><option value="200">200%</option></select><select aria-label="原图导出格式" value={tools.exportFormat} onChange={event => { tools.exportFormat = event.currentTarget.value as typeof tools.exportFormat; update(); }}><option value="png">PNG</option><option value="jpeg">JPEG</option></select><button className="theia-button secondary scope-icon-button" aria-label="截图" title="截图…" disabled={!image || exporting} aria-busy={exporting} onClick={() => void exportImage()}><i className="codicon codicon-device-camera" aria-hidden="true" /></button></div></div>
        {/* Capture saves the displayed complete source frame, without the analysis overlays. */}
        <div className="nodu-image-frame">
        <div className="nodu-image-viewport" aria-busy={decoding}>
            {image ? <div className="nodu-image-raster" style={{ width: zoom ? image.width * zoom : '100%' }}>
                <canvas ref={canvas} role="img" tabIndex={0} aria-label={`设备帧 ${image.frame.sequence}。拖拽选择 ROI，也可通过下方坐标输入选区；Escape 清除选区。像素查看始终使用原图。`} style={{ width: '100%', height: 'auto' }}
                    onPointerDown={event => { if (event.button !== 0) { return; } const point = pointAt(event); if (point) { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = point; inspect(point); changeRoi(rectFromPoints(point, point, image.width, image.height)); } }}
                    onPointerMove={event => { const point = pointAt(event); if (!point) { return; } inspect(point); if (drag.current) { changeRoi(rectFromPoints(drag.current, point, image.width, image.height)); } }}
                    onPointerUp={release} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}
                    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); drag.current = undefined; changeRoi(undefined); } }} />
                {tools.roi && roi && <svg className="nodu-image-roi-overlay" viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="none" aria-hidden="true"><rect x={roi.x} y={roi.y} width={roi.width} height={roi.height} vectorEffect="non-scaling-stroke" /></svg>}
            </div> : <div className="nodu-preview-empty" aria-label={decodeError ? '图像不可用' : '加载图像'}><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" /></div>}
        </div>
        {image && <span className="nodu-image-badge" aria-hidden="true">#{image.frame.sequence} · {image.width} × {image.height}{tools.mask ? ' · LAB' : ''}</span>}
        </div>
        {decodeError && <p className="scope-error" role="alert">{decodeError}{image ? '（保留上一帧）' : ''}</p>}
        <details className="nodu-analysis-details" open={compact ? undefined : true}><summary>ROI</summary>
        <div className="nodu-image-pixel" aria-label="原图像素值"><span className="nodu-image-swatch" style={{ backgroundColor: pixel ? `rgb(${pixel.rgb.join(',')})` : 'transparent' }} aria-hidden="true" /><div>{pixel ? <><span className="scope-mono">({pixel.x}, {pixel.y}) · RGB {pixel.rgb.join(', ')}</span><span className="scope-mono">PC LAB ≈ {pixel.lab.map(value => value.toFixed(1)).join(', ')}</span></> : <span>RGB / PC LAB —</span>}</div></div>
        <fieldset className="nodu-image-roi"><legend>选区 ROI</legend><div className="nodu-image-roi-heading"><span className="scope-mono">{roi && tools.roi ? `${roi.x}, ${roi.y}, ${roi.width}, ${roi.height}` : '整张图像'}</span><button className="scope-text-button" disabled={!tools.roi} onClick={() => changeRoi(undefined)}>清除选区</button></div><div className="nodu-image-roi-inputs">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>{['X', 'Y', '宽', '高'][index]}<input type="number" aria-label={`ROI ${['X', 'Y', '宽度', '高度'][index]}`} disabled={!image} min={index < 2 ? 0 : 1} max={image ? index % 2 === 0 ? image.width - (index < 2 ? 1 : 0) : image.height - (index < 2 ? 1 : 0) : 1} value={roi?.[key] ?? 0} onChange={event => { if (image && roi) { changeRoi(clampRect({ ...roi, [key]: Number(event.currentTarget.value) }, image.width, image.height)); } }} /></label>)}</div></fieldset>
        </details>
        {/* Histogram luminance uses Y' = 0.2126R + 0.7152G + 0.0722B. */}
        <details className="nodu-analysis-details" open={compact ? undefined : true}><summary>直方图</summary>
        <section className="nodu-image-tool-section" aria-label="直方图"><div className="nodu-image-tool-heading"><h3>{tools.roi ? '选区直方图' : '全图直方图'}</h3><select aria-label="直方图通道" value={tools.histogram} onChange={event => { tools.histogram = event.currentTarget.value as typeof tools.histogram; update(); }}><option value="rgb">RGB</option><option value="gray">灰度 Y′</option></select></div>{distribution && <><Histogram values={distribution} mode={tools.histogram} /><p className="scope-caption">{distribution.count.toLocaleString()} 像素{downsampled ? ` · ${image.analysisWidth} × ${image.analysisHeight}` : ''}</p></>}</section>
        </details>
        <details className="nodu-analysis-details" open={compact ? undefined : true}><summary>LAB</summary>
        <section className="nodu-image-tool-section" aria-label="LAB 阈值"><div className="nodu-image-tool-heading"><h3>LAB 阈值</h3><button className="scope-text-button" onClick={() => { tools.threshold = [...DEFAULT_LAB_THRESHOLD]; update(); }}>重置</button></div><label className="scope-check nodu-image-mask-toggle"><input type="checkbox" checked={tools.mask} disabled={!image} onChange={event => { tools.mask = event.currentTarget.checked; update(); }} />阈值蒙版{tools.roi ? '（选区）' : ''}</label>
            {channels.map((channel, channelIndex) => <fieldset className="scope-channel" key={channel.name}><legend><strong>{channel.name}</strong><span>{channel.description}</span><code>{tools.threshold[channelIndex * 2]} … {tools.threshold[channelIndex * 2 + 1]}</code></legend>{[0, 1].map(bound => { const index = channelIndex * 2 + bound; return <label className="scope-range-row" key={bound}><span>{bound ? '上限' : '下限'}</span><input type="range" min={channel.min} max={channel.max} aria-label={`${channel.name} ${bound ? '上限' : '下限'}`} value={tools.threshold[index]} onChange={event => { tools.threshold = updateThreshold(tools.threshold, index, Number(event.currentTarget.value)); update(); }} /><output>{tools.threshold[index]}</output></label>; })}</fieldset>)}
            {mask && <p className="nodu-image-mask-count">白色命中 {mask.matched.toLocaleString()} / {mask.total.toLocaleString()} 像素 · {(100 * mask.matched / mask.total).toFixed(1)}%</p>}
            {/* PC sRGB/D65 LAB is approximate and differs from the board's RGB565/LAB lookup. */}
            <div className="nodu-image-copy"><code tabIndex={0} aria-label="可复制的 LAB Python 元组">{thresholdTuple(tools.threshold)}</code><button className="theia-button secondary" onClick={() => void copy()}><i className="codicon codicon-copy" aria-hidden="true" />复制参数</button></div>
        </section>
        </details>
        {feedback && <p className={feedback.error ? 'scope-error' : 'nodu-image-feedback'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    </div>;
}
