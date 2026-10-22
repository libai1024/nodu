// SPDX-License-Identifier: MIT
// ORB keypoints editor dialog: canvas point selection over `.orb` files via the
// pinned WASM codec (nodu-imaging orb.rs). Edits go through editOrb/keep/merge;
// bytes are only written through the native save-as dialog.
import * as React from '@theia/core/shared/react';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { MAX_IMAGE_FILE_BYTES, OrbInfo, editOrb, orbInfo } from './nodu-imaging';
import { NODU_COLORS } from './nodu-brand';
import { pickBinaryFile } from './nodu-vision-files';

const ORB_LIMIT = 2 * 1024 * 1024;
const VIEW_W = 640;
const VIEW_H = 400;
const CLICK_RADIUS = 8;

export interface OrbDoc {
    bytes: Uint8Array;
    info: OrbInfo;
    name: string;
}

interface Deps { files: FileService; dialogs: FileDialogService; }

export class NoduKeypointsDialog extends ReactDialog<undefined> {
    constructor(props: DialogProps,
        private readonly initial: OrbDoc,
        private readonly deps: Deps) {
        super(props);
        this.node.classList.add('nodu-keypoints-dialog');
        this.contentNode.classList.add('scope-widget');
        this.appendAcceptButton('关闭');
    }

    get value(): undefined { return undefined; }

    protected render(): React.ReactNode {
        return <KeypointsEditor initial={this.initial} files={this.deps.files} dialogs={this.deps.dialogs} />;
    }
}

interface Extent { width: number; height: number; }

function extentOf(doc: OrbDoc, background: HTMLImageElement | undefined): Extent {
    if (background) { return { width: background.naturalWidth, height: background.naturalHeight }; }
    let maxX = 0;
    let maxY = 0;
    for (const [x, y] of doc.info.points) { maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    return { width: Math.max(320, maxX + 16), height: Math.max(240, maxY + 16) };
}

function KeypointsEditor({ initial, files, dialogs }: { initial: OrbDoc } & Deps): React.ReactElement {
    const [doc, setDoc] = React.useState(initial);
    const [selection, setSelection] = React.useState<ReadonlySet<number>>(new Set());
    const [hiddenOctaves, setHiddenOctaves] = React.useState<ReadonlySet<number>>(new Set());
    const [background, setBackground] = React.useState<HTMLImageElement>();
    const [hover, setHover] = React.useState<number>();
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState<{ error: boolean; text: string }>();
    const [dragRect, setDragRect] = React.useState<{ x: number; y: number; width: number; height: number }>();
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const dragStart = React.useRef<[number, number] | undefined>(undefined);

    const extent = extentOf(doc, background);
    const scale = Math.min(VIEW_W / extent.width, VIEW_H / extent.height);
    const octaves = React.useMemo(() => [...new Set(doc.info.points.map(p => p[3]))].sort((a, b) => a - b), [doc]);
    const visible = (index: number): boolean => !hiddenOctaves.has(doc.info.points[index][3]);

    const toView = (x: number, y: number): [number, number] => [x * scale, y * scale];
    const canvasScale = (): { rect: DOMRect; cssPerSource: number } => {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        // canvas.width device px = extent.width*scale source units; CSS px per source unit.
        return { rect, cssPerSource: scale * (rect.width / canvas.width) };
    };
    const fromEvent = (event: React.PointerEvent | React.MouseEvent): [number, number] => {
        const { rect } = canvasScale();
        return [(event.clientX - rect.left) * (canvasRef.current!.width / rect.width) / scale,
        (event.clientY - rect.top) * (canvasRef.current!.height / rect.height) / scale];
    };
    const nearest = (x: number, y: number, radius: number): number | undefined => {
        let best: number | undefined;
        let distance = radius;
        doc.info.points.forEach((point, index) => {
            if (!visible(index)) { return; }
            const d = Math.hypot(point[0] - x, point[1] - y);
            if (d <= distance) { distance = d; best = index; }
        });
        return best;
    };

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) { return; }
        canvas.width = Math.max(1, Math.round(extent.width * scale));
        canvas.height = Math.max(1, Math.round(extent.height * scale));
        const context = canvas.getContext('2d')!;
        const styles = getComputedStyle(canvas);
        context.fillStyle = styles.getPropertyValue('--theia-editor-background').trim() || NODU_COLORS.dark.editor;
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (background) { context.drawImage(background, 0, 0, canvas.width, canvas.height); }
        const brand = styles.getPropertyValue('--theia-focusBorder').trim() || NODU_COLORS.dark.focus;
        const plain = styles.getPropertyValue('--theia-editor-foreground').trim() || NODU_COLORS.dark.text;
        doc.info.points.forEach((point, index) => {
            if (!visible(index)) { return; }
            const [cx, cy] = toView(point[0], point[1]);
            const selected = selection.has(index);
            context.strokeStyle = selected ? brand : plain;
            context.lineWidth = selected ? 2 : 1;
            context.beginPath();
            context.arc(cx, cy, selected ? 5 : 3.5, 0, Math.PI * 2);
            context.stroke();
            const rad = point[4] * Math.PI / 180;
            context.beginPath();
            context.moveTo(cx, cy);
            context.lineTo(cx + Math.cos(rad) * 12, cy - Math.sin(rad) * 12);
            context.stroke();
        });
        if (dragRect) {
            context.strokeStyle = brand;
            context.setLineDash([4, 3]);
            context.strokeRect(dragRect.x, dragRect.y, dragRect.width, dragRect.height);
            context.setLineDash([]);
        }
    });

    const apply = (bytes: Uint8Array): void => {
        const info = orbInfo(bytes); // throws on malformed output; doc untouched on error
        setDoc({ ...doc, bytes, info });
        setSelection(new Set());
    };

    const deleteSelected = (): void => {
        if (busy || !selection.size) { return; }
        try {
            const keep = doc.info.points.map((_, index) => index).filter(index => !selection.has(index));
            apply(editOrb(doc.bytes, keep));
            setMessage({ error: false, text: `已删除 ${selection.size} 个点。` });
        } catch (error) {
            setMessage({ error: true, text: `删除失败：${error instanceof Error ? error.message : String(error)}` });
        }
    };

    const mergeFile = async (): Promise<void> => {
        setBusy(true);
        setMessage(undefined);
        try {
            const picked = await pickBinaryFile({ files, dialogs }, {
                title: '合并 ORB 文件', openLabel: '合并', filters: { 'ORB 关键点': ['orb'] }, maxBytes: ORB_LIMIT, tooLarge: 'ORB 文件超过 2 MiB 上限。',
            });
            if (!picked) { return; }
            const merged = editOrb(doc.bytes, doc.info.points.map((_, index) => index), picked.bytes);
            apply(merged);
            setMessage({ error: false, text: `已合并 ${picked.uri.path.base}，共 ${orbInfo(merged).points.length} 个点。` });
        } catch (error) {
            setMessage({ error: true, text: `合并失败：${error instanceof Error ? error.message : String(error)}` });
        } finally {
            setBusy(false);
        }
    };

    const saveAs = async (): Promise<void> => {
        setBusy(true);
        setMessage(undefined);
        try {
            const target = await dialogs.showSaveDialog({ title: '保存 ORB 关键点', filters: { 'ORB 关键点': ['orb'] } });
            if (!target) { return; }
            await files.createFile(target, BinaryBuffer.wrap(doc.bytes), { overwrite: false });
            setMessage({ error: false, text: `已保存到 ${target.path.base}（原文件未改动）。` });
        } catch (error) {
            setMessage({ error: true, text: `保存失败：${error instanceof Error ? error.message : String(error)}` });
        } finally {
            setBusy(false);
        }
    };

    const loadBackground = async (): Promise<void> => {
        setBusy(true);
        setMessage(undefined);
        try {
            const picked = await pickBinaryFile({ files, dialogs }, {
                title: '选择背景图片', openLabel: '选择', filters: { '图像 (JPEG/PNG)': ['jpg', 'jpeg', 'png'] }, maxBytes: MAX_IMAGE_FILE_BYTES, tooLarge: '图像文件超过 8 MiB 上限。',
            });
            if (!picked) { return; }
            const url = URL.createObjectURL(new Blob([picked.bytes.slice()], { type: 'image/*' }));
            try {
                const image = new Image();
                await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('无法解码图片')); image.src = url; });
                if (image.naturalWidth > 2048 || image.naturalHeight > 2048 || image.naturalWidth * image.naturalHeight > 1048576) {
                    throw new Error('背景图片超过像素上限。');
                }
                setBackground(image);
            } finally {
                URL.revokeObjectURL(url);
            }
        } catch (error) {
            setMessage({ error: true, text: `背景图片：${error instanceof Error ? error.message : String(error)}` });
        } finally {
            setBusy(false);
        }
    };

    const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        if (busy || event.button !== 0) { return; }
        event.preventDefault();
        event.currentTarget.focus();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* non-pointer sources (e.g. assistive events) may not have an active pointer */ }
        dragStart.current = fromEvent(event);
        setDragRect(undefined);
    };
    const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        if (dragStart.current) {
            const [x, y] = fromEvent(event);
            const [sx, sy] = dragStart.current;
            setDragRect({ x: Math.min(sx, x) * scale, y: Math.min(sy, y) * scale, width: Math.abs(x - sx) * scale, height: Math.abs(y - sy) * scale });
        } else {
            const [x, y] = fromEvent(event);
            setHover(nearest(x, y, CLICK_RADIUS / canvasScale().cssPerSource));
        }
    };
    const endDrag = (): void => {
        dragStart.current = undefined;
        setDragRect(undefined);
    };
    const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
        const start = dragStart.current;
        endDrag();
        try {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
        } catch { /* mirror of the capture guard above */ }
        if (!start) { return; }
        const [x, y] = fromEvent(event);
        const moved = Math.hypot(x - start[0], y - start[1]) * canvasScale().cssPerSource;
        if (moved < 4) {
            const hit = nearest(x, y, CLICK_RADIUS / canvasScale().cssPerSource);
            setSelection(hit === undefined ? new Set() : new Set([hit]));
        } else {
            const [minX, maxX] = [Math.min(start[0], x), Math.max(start[0], x)];
            const [minY, maxY] = [Math.min(start[1], y), Math.max(start[1], y)];
            const inside = new Set<number>();
            doc.info.points.forEach((point, index) => {
                if (visible(index) && point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY) { inside.add(index); }
            });
            setSelection(inside);
        }
    };

    const keyDown = (event: React.KeyboardEvent<HTMLCanvasElement>): void => {
        if (busy) { return; }
        if ((event.key === 'Delete' || event.key === 'Backspace') && selection.size) {
            event.preventDefault();
            deleteSelected();
        }
    };

    const hoverPoint = hover === undefined ? undefined : doc.info.points[hover];
    return <div className="nodu-keypoints">
        <div className="nodu-keypoints-toolbar">
            <button className="theia-button secondary" disabled={busy || !selection.size} onClick={deleteSelected}>删除选中</button>
            <button className="theia-button secondary" disabled={busy} onClick={() => void mergeFile()}>合并…</button>
            <button className="theia-button secondary" disabled={busy} onClick={() => void loadBackground()}>{background ? '更换背景…' : '背景图片…'}</button>
            {background && <button className="theia-button secondary" disabled={busy} onClick={() => setBackground(undefined)}>清除背景</button>}
            <button className="theia-button" disabled={busy} onClick={() => void saveAs()}>保存为…</button>
        </div>
        <div className="nodu-keypoints-octaves" role="group" aria-label="octave 过滤">
            {octaves.map(octave => {
                const count = doc.info.points.filter(p => p[3] === octave).length;
                return <label key={octave} className="nodu-keypoints-octave"><input type="checkbox" checked={!hiddenOctaves.has(octave)} disabled={busy} onChange={event => {
                    const next = new Set(hiddenOctaves);
                    if (event.currentTarget.checked) { next.delete(octave); } else { next.add(octave); }
                    setHiddenOctaves(next);
                    setSelection(new Set([...selection].filter(index => !next.has(doc.info.points[index][3]))));
                }} />octave {octave}（{count}）</label>;
            })}
        </div>
        <canvas ref={canvasRef} className="nodu-keypoints-canvas" tabIndex={0} role="application" aria-label="关键点画布"
            onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
            onPointerCancel={endDrag} onLostPointerCapture={endDrag} onKeyDown={keyDown} />
        <div className="nodu-keypoints-status">
            <span className="scope-mono">已选 {selection.size} / 共 {doc.info.points.length} · 类型 {doc.info.kind} · {doc.name}</span>
            <span className="scope-mono">{hoverPoint && hover !== undefined ? `#${hover} (${hoverPoint[0]}, ${hoverPoint[1]}) 得分 ${hoverPoint[2]} · octave ${hoverPoint[3]} · 角度 ${hoverPoint[4]}°` : '拖拽选择，可按 Delete 删除'}</span>
        </div>
        {message && <p className={`${message.error ? "scope-error" : "nodu-image-feedback"}`} role={message.error ? 'alert' : undefined}>{message.text}</p>}
    </div>;
}
