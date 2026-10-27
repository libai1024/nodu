// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { isSafeCoursePath } from '../common/tutor/tutor-course';
import { isTutorContextRef } from '../common/tutor/tutor-conversation';
import type { TutorChatSnapshot } from '../common/tutor/tutor-conversation';
import { terminalContextLabel } from '../common/tutor/tutor-context';
import type { TutorChatItem } from './nodu-tutor-model';
import '../../style/tutor-messages.css';

export interface TutorMessageItem extends TutorChatItem {
    /** Already sanitized request diagnostics. Never include credentials. */
    detail?: string;
}
export interface TutorMessageProps {
    item: TutorMessageItem;
    snapshot?: TutorChatSnapshot;
    /** The host must resolve the reference against the current authorized project. */
    open(path: string, line: number): void | Promise<void>;
    retry?(item: TutorMessageItem): void | Promise<void>;
    /** Restore an editable draft; do not rewrite history or send automatically. */
    onReask?(item: TutorMessageItem): void | Promise<void>;
    busy?: boolean;
}
export type TutorInline = { kind: 'text' | 'code' | 'strong'; text: string }
    | { kind: 'reference'; text: string; path: string; line: number };
export type TutorMarkdownBlock = { kind: 'paragraph'; text: string }
    | { kind: 'list'; ordered: boolean; start: number; items: string[] }
    | { kind: 'code'; language: string; text: string };

const PARSE_LIMIT = 128_000;
const BLOCK_LIMIT = 512;
const INLINE_LIMIT = 256;
const CODE_PREVIEW_LINES = 14;
// Keep presentation choices across mode changes and sidebar reopening, without retaining message text.
const expandedMessages = new Map<string, boolean>();
function useExpansion(key: string): [boolean, () => void] {
    const [expanded, setExpanded] = React.useState(() => expandedMessages.get(key) ?? false);
    React.useEffect(() => { setExpanded(expandedMessages.get(key) ?? false); }, [key]);
    return [expanded, () => setExpanded(previous => {
        const next = !previous;
        expandedMessages.delete(key); expandedMessages.set(key, next);
        if (expandedMessages.size > 500) { expandedMessages.delete(expandedMessages.keys().next().value!); }
        return next;
    })];
}

/** Deliberately small grammar. Raw HTML, images, remote URLs and commands remain text. */
export function parseTutorInline(text: string): TutorInline[] {
    if (text.length > PARSE_LIMIT) { return [{ kind: 'text', text }]; }
    const result: TutorInline[] = [];
    const pattern = /`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]{1,200}\]\([^()\n]{1,260}\)/g;
    let offset = 0;
    for (let match = pattern.exec(text); match && result.length < INLINE_LIMIT; match = pattern.exec(text)) {
        const raw = match[0];
        if (text[match.index - 1] === '\\' || (raw.startsWith('[') && text[match.index - 1] === '!')) { continue; }
        let node: TutorInline | undefined;
        if (raw.startsWith('`')) { node = { kind: 'code', text: raw.slice(1, -1) }; }
        else if (raw.startsWith('**')) { node = { kind: 'strong', text: raw.slice(2, -2) }; }
        else {
            const reference = /^\[([^\]]+)\]\(([^#]+)(?:#L([1-9]\d{0,5}))?\)$/.exec(raw);
            if (reference && isSafeCoursePath(reference[2]) && /\.(c|h|cpp|hpp|cc|py|ino)$/i.test(reference[2])) {
                node = { kind: 'reference', text: reference[1], path: reference[2], line: Number(reference[3] ?? 1) };
            }
        }
        if (!node) { continue; }
        if (match.index > offset) { result.push({ kind: 'text', text: text.slice(offset, match.index) }); }
        result.push(node); offset = match.index + raw.length;
    }
    if (offset < text.length) { result.push({ kind: 'text', text: text.slice(offset) }); }
    return result;
}

/** Fences retain the original code bytes, including CRLF, for per-block copy. */
export function parseTutorMarkdown(text: string): TutorMarkdownBlock[] {
    if (!text) { return []; }
    if (text.length > PARSE_LIMIT) { return [{ kind: 'paragraph', text }]; }
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const result: TutorMarkdownBlock[] = [];
    const body = (line: string): string => line.replace(/\r?\n$/, '');
    const listItem = (line: string): RegExpExecArray | null => /^ {0,3}(?:([-+*])|([1-9]\d{0,5})[.)])\s+(.+)$/.exec(body(line));
    for (let i = 0; i < lines.length;) {
        if (result.length >= BLOCK_LIMIT) { result.push({ kind: 'paragraph', text: lines.slice(i).join('') }); break; }
        const line = body(lines[i]);
        if (!line.trim()) { i++; continue; }
        const fence = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
        if (fence) {
            const marker = fence[1][0], count = fence[1].length;
            const info = fence[2].trim();
            // A fence info string is a language hint, never evidence of file ownership.
            const language = /^[a-z][a-z0-9+#-]{0,23}$/i.test(info) ? info.toLowerCase() : '';
            const code: string[] = []; i++;
            for (; i < lines.length; i++) {
                const ending = body(lines[i]).trim();
                if (ending.length >= count && [...ending].every(c => c === marker)) { i++; break; }
                code.push(lines[i]);
            }
            result.push({ kind: 'code', language, text: code.join('') }); continue;
        }
        const item = listItem(lines[i]);
        if (item) {
            const ordered = !!item[2], start = Number(item[2] ?? 1), items: string[] = [];
            for (; i < lines.length; i++) {
                const next = listItem(lines[i]);
                if (!next || !!next[2] !== ordered) { break; }
                items.push(next[3]);
                if (items.length >= BLOCK_LIMIT) { i++; break; }
            }
            result.push({ kind: 'list', ordered, start, items }); continue;
        }
        const paragraph = [lines[i++]];
        for (; i < lines.length; i++) {
            if (!body(lines[i]).trim() || /^ {0,3}(?:`{3,}|~{3,})/.test(lines[i]) || listItem(lines[i])) { break; }
            paragraph.push(lines[i]);
        }
        result.push({ kind: 'paragraph', text: paragraph.join('').replace(/\r?\n$/, '') });
    }
    return result;
}

function CopyButton({ text, label }: { text: string; label: string }): React.ReactElement {
    const [status, setStatus] = React.useState<'idle' | 'copied' | 'failed'>('idle');
    const active = React.useRef(true), pending = React.useRef(false), generation = React.useRef(0);
    const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    React.useEffect(() => {
        active.current = true;
        return () => { active.current = false; generation.current++; clearTimeout(timer.current); };
    }, []);
    React.useEffect(() => { generation.current++; setStatus('idle'); clearTimeout(timer.current); }, [text]);
    const copy = async (): Promise<void> => {
        if (pending.current) { return; }
        pending.current = true;
        const request = generation.current;
        try {
            if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) { throw new Error('Clipboard unavailable'); }
            await navigator.clipboard.writeText(text);
            if (active.current && request === generation.current) {
                setStatus('copied'); clearTimeout(timer.current);
                timer.current = setTimeout(() => { if (active.current) { setStatus('idle'); } }, 1500);
            }
        } catch {
            if (active.current && request === generation.current) { setStatus('failed'); }
        } finally { pending.current = false; }
    };
    return <span className="nodu-chat-copy">
        <button type="button" className="nodu-chat-icon" title={status === 'copied' ? '已复制' : label}
            aria-label={status === 'copied' ? '已复制' : label} onClick={() => void copy()}>
            <i className={`codicon codicon-${status === 'copied' ? 'check' : 'copy'}`} aria-hidden="true" />
        </button>
        <span className={status === 'failed' ? 'nodu-chat-copy-error' : 'nodu-chat-sr-only'} role="status">
            {status === 'copied' ? '已复制' : status === 'failed' ? '复制失败' : ''}
        </span>
    </span>;
}

type CodeToken = { offset: number; type: string };
/** Map trusted tokenizer classes to a fixed vocabulary; no model-provided class names or HTML. */
export function tutorTokenClass(type: string): string | undefined {
    const token = type.split('.')[0];
    return ['comment', 'string', 'number', 'keyword', 'type', 'constant', 'identifier', 'delimiter'].includes(token)
        ? `nodu-chat-token-${token}` : undefined;
}
function HighlightedCode({ text, language }: { text: string; language: string }): React.ReactElement {
    const [tokenized, setTokenized] = React.useState<{ text: string; language: string; lines: CodeToken[][] }>();
    React.useEffect(() => {
        let live = true;
        if (text.length <= 32_000 && language) {
            void import('@theia/monaco-editor-core').then(monaco => {
                const id = ({ js: 'javascript', ts: 'typescript', py: 'python', 'c++': 'cpp', h: 'c' } as Record<string, string>)[language] ?? language;
                if (live && monaco.languages.getLanguages().some(entry => entry.id === id)) {
                    const lines = monaco.editor.tokenize(text, id);
                    if (live) { setTokenized({ text, language, lines }); }
                }
            }).catch(() => undefined); // SSR and unregistered languages remain readable plain code.
        }
        return () => { live = false; };
    }, [text, language]);
    if (!tokenized || tokenized.text !== text || tokenized.language !== language) { return <>{text}</>; }
    return <>{text.split('\n').map((line, i, all) => {
        const tokens = tokenized.lines[i] ?? [];
        return <React.Fragment key={i}>{!tokens.length ? line : <>
            {tokens[0].offset > 0 && line.slice(0, tokens[0].offset)}
            {tokens.map((token, n) => <span key={n} className={tutorTokenClass(token.type)}>
                {line.slice(token.offset, tokens[n + 1]?.offset ?? line.length)}
            </span>)}
        </>}{i < all.length - 1 ? '\n' : ''}</React.Fragment>;
    })}</>;
}

function CodeBlock({ block, stateKey }: { block: Extract<TutorMarkdownBlock, { kind: 'code' }>; stateKey: string }): React.ReactElement {
    const [expanded, toggle] = useExpansion(stateKey);
    const lines = block.text.split('\n').length - (block.text.endsWith('\n') ? 1 : 0);
    const long = lines > CODE_PREVIEW_LINES;
    return <section className="nodu-chat-code" aria-label={block.language ? `${block.language} 代码` : '代码'}>
        <div className="nodu-chat-code-head"><span>{block.language || '代码'}</span><CopyButton text={block.text} label="复制代码" /></div>
        <pre className={!expanded && long ? 'nodu-chat-code-collapsed' : undefined} tabIndex={0}>
            <code><HighlightedCode text={block.text} language={block.language} /></code>
        </pre>
        {long && <button type="button" className="nodu-chat-text-action nodu-chat-code-toggle" aria-expanded={expanded}
            onClick={toggle}>{expanded ? '收起代码' : `展开代码（${lines} 行）`}</button>}
    </section>;
}

function FileReference({ node, open }: { node: Extract<TutorInline, { kind: 'reference' }>; open: TutorMessageProps['open'] }): React.ReactElement {
    const [failed, setFailed] = React.useState(false);
    const [opening, setOpening] = React.useState(false);
    const active = React.useRef(true), pending = React.useRef(false);
    React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const follow = async (): Promise<void> => {
        if (pending.current) { return; }
        pending.current = true; setOpening(true); setFailed(false);
        try { await open(node.path, node.line); }
        catch { if (active.current) { setFailed(true); } }
        finally { pending.current = false; if (active.current) { setOpening(false); } }
    };
    return <><button type="button" className="nodu-chat-file-link" title={`${node.path}:${node.line}`} disabled={opening}
        onClick={() => void follow()}>{node.text}</button>{failed && <span className="nodu-chat-reference-error" role="status"> 无法打开此文件</span>}</>;
}
function Inline({ text, open }: { text: string; open: TutorMessageProps['open'] }): React.ReactElement {
    const inline = React.useMemo(() => parseTutorInline(text), [text]);
    return <>{inline.map((part, i) => part.kind === 'code' ? <code key={i}>{part.text}</code>
        : part.kind === 'strong' ? <strong key={i}>{part.text}</strong>
            : part.kind === 'reference' ? <FileReference key={`${i}:${part.path}:${part.line}`} node={part} open={open} /> : part.text)}</>;
}
function Markdown({ text, open, messageId }: { text: string; open: TutorMessageProps['open']; messageId: string }): React.ReactElement {
    const blocks = React.useMemo(() => parseTutorMarkdown(text), [text]);
    return <>{blocks.map((block, i) => {
        if (block.kind === 'code') { return <CodeBlock key={i} block={block} stateKey={`${messageId}:code:${i}`} />; }
        if (block.kind === 'paragraph') { return <p key={i}><Inline text={block.text} open={open} /></p>; }
        const items = block.items.map((text, n) => <li key={n}><Inline text={text} open={open} /></li>);
        return block.ordered ? <ol key={i} start={block.start}>{items}</ol> : <ul key={i}>{items}</ul>;
    })}</>;
}

export function TutorMessage({ item, snapshot, open, retry, onReask, busy = false }: TutorMessageProps): React.ReactElement {
    const [expanded, toggle] = useExpansion(`${item.id}:message`);
    const [details, setDetails] = React.useState(false);
    const [action, setAction] = React.useState<'retry' | 'reask'>();
    const [actionFailed, setActionFailed] = React.useState<string>();
    const pending = React.useRef(false), live = React.useRef(true);
    const more = React.useRef<HTMLButtonElement>(null);
    React.useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    const run = async (kind: 'retry' | 'reask'): Promise<void> => {
        const handler = kind === 'retry' ? retry : onReask;
        if (busy || pending.current || !handler) { return; }
        pending.current = true; setAction(kind); setActionFailed(undefined);
        try { await handler(item); }
        catch { if (live.current) { setActionFailed(kind === 'reask' ? '暂时无法编辑问题，请重试' : '操作未完成，请重试'); } }
        finally { pending.current = false; if (live.current) { setAction(undefined); } }
    };
    const user = item.role === 'user';
    const long = user && (item.text.length > 600 || item.text.split('\n').length > 6);
    const interrupted = item.status === 'failed', stopped = item.status === 'stopped';
    const diagnostics = item.detail || item.note;
    const references = user && Array.isArray(item.contextRefs) ? item.contextRefs.filter(isTutorContextRef).slice(0, 6) : [];
    return <article className={`nodu-chat-message nodu-chat-${user ? 'user' : 'assistant'}`} aria-label={user ? '你' : 'AI'}
        aria-busy={item.status === 'pending'} data-message-id={item.id}>
        <div className={`nodu-chat-content${user ? ' nodu-chat-bubble' : ''}`}>
            <div className={`nodu-chat-markdown${long && !expanded ? ' nodu-chat-message-collapsed' : ''}`}>
                {item.text ? user ? <p>{item.text}</p> : <Markdown text={item.text} open={open} messageId={item.id} /> : item.status === 'pending'
                    ? <span className="nodu-chat-status" role="status">正在生成…</span> : null}
            </div>
            {long && <button type="button" className="nodu-chat-text-action nodu-chat-message-toggle" aria-expanded={expanded}
                onClick={toggle}>{expanded ? '收起' : '展开'}</button>}
        </div>
        {references.length > 0 && <div className="nodu-chat-context-references" aria-label="本条消息附带的上下文">
            {references.map((reference, index) => {
                const text = snapshot?.contexts?.find(c => c.kind === reference.kind && c.path === reference.path && c.startLine === reference.startLine && c.endLine === reference.endLine
                    && (c.kind !== 'terminal' || !!c.terminalSelection === !!reference.terminalSelection))?.text
                    ?? (reference.kind === 'file' && snapshot?.buffer?.path === reference.path ? snapshot.buffer.text : undefined);
                const label = reference.kind === 'terminal' ? terminalContextLabel(reference) : `${reference.path.split('/').pop()}${reference.kind === 'selection' ? `:${reference.startLine}–${reference.endLine}` : ''}`;
                return text !== undefined ? <details className="nodu-chat-sent-context" key={`${index}:${reference.path}`}><summary><i className={`codicon codicon-${reference.kind === 'terminal' ? 'terminal' : reference.kind === 'selection' ? 'selection' : 'file-code'}`} aria-hidden="true"/>{label}</summary>
                    <div className="nodu-chat-sent-context-body">{reference.kind !== 'terminal' && <span>{reference.endLine - reference.startLine + 1} 行</span>}<pre>{text}</pre>
                        {reference.kind !== 'terminal' && <FileReference open={open} node={{ kind: 'reference', path: reference.path, line: reference.startLine, text: '打开源文件' }}/>}</div>
                </details> : <span key={`${index}:${reference.path}:${reference.startLine}`}>
                <i className={`codicon codicon-${reference.kind === 'terminal' ? 'terminal' : reference.kind === 'selection' ? 'selection' : 'file-code'}`} aria-hidden="true"/>{reference.kind === 'terminal' ? <span>{label}</span> : <FileReference open={open} node={{ kind: 'reference', path: reference.path, line: reference.startLine,
                    text: `${reference.path.split('/').pop()}${reference.kind === 'selection' ? `:${reference.startLine}–${reference.endLine}` : ''}` }} />}
            </span>; })}
        </div>}
        {(interrupted || stopped) && <div className="nodu-chat-recovery" role="status">
            <span>{stopped ? '已停止' : item.text ? '回复中断' : '未收到回复'}</span>
            {retry && <button type="button" className="nodu-chat-text-action" disabled={busy || !!action}
                onClick={() => void run('retry')}><i className="codicon codicon-refresh" aria-hidden="true" />{action === 'retry' ? '重试中' : '重试'}</button>}
        </div>}
        {actionFailed && <div className="nodu-chat-status" role="status">{actionFailed}</div>}
        {(!!item.text || !!diagnostics) && item.status !== 'pending' && <div className="nodu-chat-message-actions">
            {item.text && <CopyButton text={item.text} label={user ? '复制问题' : '复制回复'} />}
            {user && onReask && <button type="button" className="nodu-chat-icon" title="修改后再问" aria-label="修改后再问"
                disabled={busy || !!action} onClick={() => void run('reask')}><i className="codicon codicon-edit" aria-hidden="true" /></button>}
            {diagnostics && <button ref={more} type="button" className="nodu-chat-icon" title="消息详情" aria-label="消息详情" aria-expanded={details}
                onClick={() => setDetails(!details)}><i className="codicon codicon-ellipsis" aria-hidden="true" /></button>}
        </div>}
        {details && diagnostics && <div className="nodu-chat-details" role="group" aria-label="消息详情" onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDetails(false); more.current?.focus(); }
        }}>
            <pre>{diagnostics}</pre><CopyButton text={diagnostics} label="复制消息详情" />
        </div>}
    </article>;
}
