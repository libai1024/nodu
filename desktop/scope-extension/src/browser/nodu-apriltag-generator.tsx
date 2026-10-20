// SPDX-License-Identifier: MIT
// AprilTag batch generator dialog: renders pins/frozen tag pixels from the
// nodu-imaging WASM export and writes sequential PNGs to a chosen directory.
import * as React from '@theia/core/shared/react';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { tagPixels } from './nodu-imaging';

export interface TagFamily { id: string; label: string; count: number; side: number; }

export const TAG_FAMILIES: readonly TagFamily[] = [
    { id: 'tag16h5', label: 'TAG16H5', count: 30, side: 8 },
    { id: 'tag25h7', label: 'TAG25H7', count: 242, side: 9 },
    { id: 'tag25h9', label: 'TAG25H9', count: 35, side: 9 },
    { id: 'tag36h10', label: 'TAG36H10', count: 2320, side: 10 },
    { id: 'tag36h11', label: 'TAG36H11', count: 587, side: 10 },
    { id: 'tag36artoolkit', label: 'ARTOOLKIT', count: 512, side: 10 },
];

const LABEL_FOOTER = 32;

interface Deps { files: FileService; dialogs: FileDialogService; /** Optional TAG_FAMILIES id preselecting the in-dialog picker. */ family?: string; }

export class NoduAprilTagDialog extends ReactDialog<undefined> {
    /** Shared flag: true means the running batch should stop before the next write. */
    readonly cancelState = { current: false };

    constructor(props: DialogProps, private readonly deps: Deps) {
        super(props);
        this.node.classList.add('nodu-apriltag-dialog');
        this.contentNode.classList.add('scope-widget');
        this.appendAcceptButton('关闭');
    }

    get value(): undefined { return undefined; }

    override dispose(): void {
        this.cancelState.current = true;
        super.dispose();
    }

    protected render(): React.ReactNode {
        return <AprilTagGenerator files={this.deps.files} dialogs={this.deps.dialogs} cancelState={this.cancelState} initialFamily={this.deps.family} />;
    }
}

export interface TagRender { bytes: Uint8Array; width: number; height: number; }

/** Render one tag to PNG bytes: nearest-neighbor integer scaling, optional white label footer. */
export async function renderTagPng(family: TagFamily, id: number, cell: number, label: boolean): Promise<TagRender> {
    const pixels = tagPixels(family.id, id);
    if (pixels.length !== family.side * family.side) {
        throw new Error(`family ${family.id} 返回 ${pixels.length} 像素，期望 ${family.side * family.side}`);
    }
    const size = family.side * cell;
    const source = document.createElement('canvas');
    source.width = family.side;
    source.height = family.side;
    const image = source.getContext('2d')!.createImageData(family.side, family.side);
    pixels.forEach((value, index) => {
        image.data[index * 4] = value;
        image.data[index * 4 + 1] = value;
        image.data[index * 4 + 2] = value;
        image.data[index * 4 + 3] = 255;
    });
    source.getContext('2d')!.putImageData(image, 0, 0);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    const text = `${family.label}-${id}`;
    context.font = '13px monospace';
    const width = label ? Math.max(size, Math.ceil(context.measureText(text).width) + 16) : size;
    canvas.width = width;
    canvas.height = size + (label ? LABEL_FOOTER : 0);
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(source, Math.floor((width - size) / 2), 0, size, size);
    if (label) {
        context.fillStyle = '#000000';
        context.font = '13px monospace';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, width / 2, size + LABEL_FOOTER / 2);
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG 编码失败')), 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height: canvas.height };
}

function AprilTagGenerator({ files, dialogs, cancelState, initialFamily }: Omit<Deps, 'family'> & { cancelState: { current: boolean }; initialFamily?: string }): React.ReactElement {
    const [familyIndex, setFamilyIndex] = React.useState(() => {
        const at = initialFamily ? TAG_FAMILIES.findIndex(family => family.id === initialFamily) : -1;
        return at >= 0 ? at : 0;
    });
    const [start, setStart] = React.useState(0);
    const [end, setEnd] = React.useState(0);
    const [cell, setCell] = React.useState(24);
    const [labels, setLabels] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [progress, setProgress] = React.useState<{ done: number; total: number }>();
    const [message, setMessage] = React.useState<{ error: boolean; text: string }>();
    const [preview, setPreview] = React.useState<{ url: string; width: number; height: number }>();
    const alive = React.useRef(true);
    const previewUrl = React.useRef<string | undefined>(undefined);
    React.useEffect(() => () => { alive.current = false; if (previewUrl.current) { URL.revokeObjectURL(previewUrl.current); } }, []);

    const family = TAG_FAMILIES[familyIndex];
    const startOk = Number.isInteger(start) && start >= 0 && start < family.count;
    const endOk = Number.isInteger(end) && end >= start && end < family.count;
    const cellOk = Number.isInteger(cell) && cell >= 4 && cell <= 64;
    const valid = startOk && endOk && cellOk;
    const outputCount = valid ? end - start + 1 : 0;

    React.useEffect(() => {
        if (!startOk || !cellOk) { setPreview(undefined); return; }
        let cancelled = false;
        void renderTagPng(family, start, cell, labels).then(rendered => {
            if (cancelled) { return; }
            const url = URL.createObjectURL(new Blob([rendered.bytes.slice()], { type: 'image/png' }));
            if (previewUrl.current) { URL.revokeObjectURL(previewUrl.current); }
            previewUrl.current = url;
            setPreview({ url, width: rendered.width, height: rendered.height });
        }).catch(error => { if (!cancelled) { setPreview(undefined); setMessage({ error: true, text: `预览失败：${error instanceof Error ? error.message : String(error)}` }); } });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [familyIndex, start, cell, labels]);

    const generate = async (): Promise<void> => {
        if (!valid || busy) { return; }
        setBusy(true);
        setMessage(undefined);
        setProgress({ done: 0, total: outputCount });
        cancelState.current = false;
        try {
            const uri = await dialogs.showOpenDialog({
                title: '选择输出目录', openLabel: '选择目录',
                canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            });
            const dir = (Array.isArray(uri) ? uri[0] : uri);
            if (!dir) { return; }
            const names: string[] = [];
            for (let id = start; id <= end; id++) { names.push(`${family.id}-${id}.png`); }
            for (const name of names) {
                if (cancelState.current || !alive.current) { break; }
                if (await files.exists(dir.resolve(name))) {
                    throw new Error(`目标文件已存在，未写入任何文件：${name}`);
                }
            }
            let written = 0;
            for (let index = 0; index < names.length; index++) {
                if (cancelState.current || !alive.current) { break; }
                const rendered = await renderTagPng(family, start + index, cell, labels);
                if (cancelState.current || !alive.current) { break; } // cancel/close during encode must not write
                try {
                    await files.createFile(dir.resolve(names[index]), BinaryBuffer.wrap(rendered.bytes), { overwrite: false });
                } catch (error) {
                    throw new Error(`已写入 ${written} / ${names.length} 个文件，失败于 ${names[index]}：${error instanceof Error ? error.message : String(error)}`);
                }
                written++;
                if (alive.current) { setProgress({ done: written, total: names.length }); }
                await new Promise(resolve => setTimeout(resolve, 0)); // yield between files so cancel/UI stay responsive
            }
            const stopped = cancelState.current || !alive.current;
            if (alive.current) {
                setMessage({ error: false, text: stopped ? `已取消：写入 ${written} / ${names.length} 个文件。` : `完成：写入 ${written} 个文件到 ${dir.path.toString()}。` });
            }
        } catch (error) {
            if (alive.current) { setMessage({ error: true, text: `生成失败：${error instanceof Error ? error.message : String(error)}` }); }
        } finally {
            if (alive.current) { setBusy(false); setProgress(undefined); }
        }
    };

    const numberInput = (label: string, value: number, set: (n: number) => void, ok: boolean, min: number, max: number): React.ReactElement => (
        <label className="nodu-tag-field"><span>{label}</span>
            <input type="number" className={ok ? undefined : 'nodu-tag-invalid'} value={value} min={min} max={max} disabled={busy}
                onChange={event => set(event.currentTarget.valueAsNumber)} aria-invalid={!ok} aria-label={label} />
        </label>
    );

    return <div className="nodu-tag-generator">
        <div className="nodu-tag-form">
            <label className="nodu-tag-field"><span>标签族</span>
                <select value={familyIndex} disabled={busy} onChange={event => { setFamilyIndex(Number(event.currentTarget.value)); setStart(0); setEnd(0); }} aria-label="AprilTag 标签族">
                    {TAG_FAMILIES.map((f, index) => <option key={f.id} value={index}>{f.label}（{f.count}）</option>)}
                </select>
            </label>
            {numberInput(`起始 ID（0–${family.count - 1}）`, start, setStart, startOk, 0, family.count - 1)}
            {numberInput(`结束 ID（含，${start}–${family.count - 1}）`, end, setEnd, endOk, start, family.count - 1)}
            {numberInput('单元格像素（4–64）', cell, setCell, cellOk, 4, 64)}
            <label className="nodu-tag-field nodu-tag-check"><input type="checkbox" checked={labels} disabled={busy} onChange={event => setLabels(event.currentTarget.checked)} />图片下方添加标签</label>
        </div>
        <div className="nodu-tag-preview" aria-label="首个标签预览">
            {preview ? <img src={preview.url} width={preview.width} height={preview.height} alt={`${family.label}-${start} 预览`} /> : <span>{valid ? '生成预览…' : '参数无效，无法预览'}</span>}
        </div>
        <div className="nodu-tag-actions">
            <button className="theia-button" disabled={!valid || busy} onClick={() => void generate()}>生成 {outputCount > 0 ? `${outputCount} 个 PNG` : ''}…</button>
            {busy && <button className="theia-button secondary" onClick={() => { cancelState.current = true; }}>取消生成</button>}
            {progress && <span className="scope-mono">{progress.done} / {progress.total}</span>}
        </div>
        {message && <p className={`${message.error ? "scope-error" : "nodu-image-feedback"}`} role={message.error ? 'alert' : undefined}>{message.text}</p>}
    </div>;
}
