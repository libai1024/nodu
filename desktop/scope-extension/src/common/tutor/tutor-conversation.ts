// SPDX-License-Identifier: MIT
import type { TutorBuffer, TutorChatRequest, TutorMode } from './tutor-ai-protocol';
import { TutorContext, validateTutorContexts, isTerminalContextName, terminalContextLabel } from './tutor-context';
import { isSafeCoursePath } from './tutor-course';
import type { TutorHistoryStorage } from './tutor-line-history';
export type TutorChatStatus = 'pending' | 'done' | 'stopped' | 'failed';
export interface TutorChatSnapshot {
    prompt: string; mode: TutorMode; kind: TutorChatRequest['kind'] | 'goal'; buffer?: TutorBuffer; contexts?: TutorContext[]; goalRevision: number;
}
export interface TutorChatItem {
    id: string; role: 'user' | 'assistant'; text: string; status: TutorChatStatus; note?: string;
    replyTo?: string; request?: TutorChatSnapshot;
    /** Immutable display metadata of the actual sent context; never another source copy. */
    contextRefs?: TutorContextRef[];
}
export interface TutorContextRef { kind: TutorContext['kind']; path: string; startLine: number; endLine: number; terminalName?: string; terminalSelection?: boolean; }
export function isTutorContextRef(value: unknown): value is TutorContextRef {
    const ref = value as TutorContextRef;
    return !!ref && typeof ref === 'object' && !Array.isArray(ref)
        && Object.keys(ref).every(key => ['kind','path','startLine','endLine','terminalName','terminalSelection'].includes(key))
        && ['file','selection','terminal'].includes(ref.kind) && typeof ref.path === 'string'
        && (ref.kind === 'terminal' ? isTerminalContextName(ref.path) : isSafeCoursePath(ref.path) && /\.(c|h|cpp|hpp|cc|py|ino)$/i.test(ref.path))
        && (ref.terminalName === undefined || ref.kind === 'terminal' && isTerminalContextName(ref.terminalName))
        && (ref.terminalSelection === undefined || ref.kind === 'terminal' && typeof ref.terminalSelection === 'boolean')
        && Number.isSafeInteger(ref.startLine) && ref.startLine > 0
        && Number.isSafeInteger(ref.endLine) && ref.endLine >= ref.startLine && ref.endLine <= 1000000
        && (ref.kind !== 'file' || ref.startLine === 1);
}
export function chatContextRefs(buffer?: TutorBuffer, contexts: readonly TutorContext[] = []): TutorContextRef[] {
    return [...(buffer ? [{ kind: 'file' as const, path: buffer.path, startLine: 1, endLine: buffer.text.split('\n').length }] : []),
        ...contexts.map(({ kind, path, startLine, endLine, terminalName, terminalSelection }) => ({ kind, path, startLine, endLine,
            ...(terminalName !== undefined ? { terminalName } : {}), ...(terminalSelection !== undefined ? { terminalSelection } : {}) }))].filter(isTutorContextRef);
}
export interface TutorConversationSummary { id: string; title: string; updatedAt: number; archived?: boolean; }
export interface TutorHistoryEntry extends TutorConversationSummary { mode: TutorMode; preview: string; hasDraft: boolean; status?: TutorChatStatus; empty?: boolean; }
export interface TutorConversation extends TutorConversationSummary {
    schema: 1; project: string; mode: TutorMode; owner: string; messages: TutorChatItem[]; draft: string; contexts?: TutorContext[]; includeCode?: boolean; customTitle?: string;
}
export interface TutorPromptMessage { role: 'user' | 'assistant'; content: string; }
const PREFIX = 'nodu.tutor.conversation.v1.';
const LIMIT = 400000, TOTAL = 3 * 1024 * 1024;
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
/** Secrets pasted into messages must not become a durable credential store. No settings are serialized here. */
export const redactChatSecrets = (text: string): string => text
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|[a-f0-9]{32}\.[a-zA-Z0-9]{12,})\b/g, '[已隐藏凭据]')
    .replace(/((?:authorization\s*:\s*bearer|api[_ -]?key\s*[:=])\s*["']?)[^\s"',}]+/gi, '$1[已隐藏凭据]');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const cleanTitle = (text: string): string => text.replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim();
const safeTitle = (text: string): string => cleanTitle(redactChatSecrets(cleanTitle(text)));
const titleLength = (text: string): number => Array.from(text).length;
const contextName = (context: TutorContext): string => context.kind === 'terminal' ? terminalContextLabel(context) : context.path.split('/').pop() || context.path;
type ConversationTitleSource = Pick<TutorConversation, 'title' | 'draft' | 'messages' | 'contexts' | 'mode' | 'customTitle'>;
const emptyConversation = (c: ConversationTitleSource): boolean => !c.customTitle?.trim() && !c.draft.trim() && !c.contexts?.length
    && !c.messages.some(m => m.text.trim() || m.contextRefs?.length || m.request?.prompt.trim() || m.request?.contexts?.length || m.request?.buffer);
/** Deterministic display metadata only; never rewrites the sent question or asks a model for a title. */
export function conversationDisplayTitle(c: Pick<TutorConversation, 'title' | 'draft' | 'messages' | 'contexts' | 'mode' | 'customTitle'>): string {
    const custom = c.customTitle && safeTitle(c.customTitle);
    // Redact before taking a sentence or truncating, so a partial credential cannot escape.
    const question = c.messages.find(m => m.role === 'user' && m.text.trim())?.text || (c.title === '新对话' ? '' : c.title);
    const firstLine = question ? redactChatSecrets(question).trim().split(/\r\n|[\n\r\u2028\u2029]/, 1)[0] : '';
    const sentence = firstLine.match(/^.*?(?:[。！？!?]|\.(?=\s|$))[”’"']*/u)?.[0] ?? firstLine;
    const source = custom || safeTitle(sentence) || safeTitle(c.draft) || (c.contexts?.length ? safeTitle(`${contextName(c.contexts[0])} 的${c.mode === 'teach' ? '教学' : '提问'}`) : '') || '新对话';
    const chars = Array.from(source);
    return chars.length > 40 ? chars.slice(0, 39).join('') + '…' : source;
}
type ConversationMetadata = Pick<TutorConversation, 'customTitle' | 'archived'>;
interface PendingConversationWrite { content: boolean; metadata: ConversationMetadata; }
/** Only complete ordinary chat pairs enter model memory. Teaching reviews/history never replay task commands. */
export function conversationPrompt(messages: readonly TutorChatItem[]): TutorPromptMessage[] {
    const out: TutorPromptMessage[] = [];
    for (const reply of messages) {
        if (reply.role !== 'assistant' || reply.status !== 'done' || !reply.replyTo || reply.request?.kind !== 'chat') { continue; }
        const user = messages.find(item => item.id === reply.replyTo && item.role === 'user');
        if (user) { out.push({ role: 'user', content: user.text }, { role: 'assistant', content: reply.text }); }
    }
    while (out.length > 12 || bytes(JSON.stringify(out)) > 16000) { out.splice(0, 2); }
    return out;
}
/** Local profile transcript cache. Each renderer owns independent writes; selecting a foreign record forks on write. */
export class TutorConversationStore {
    private readonly memory = new Map<string, TutorConversation>();
    private readonly dirty = new Map<string, PendingConversationWrite>();
    get storageError(): string | undefined { return this.dirty.size ? '对话暂未保存，内容保留在当前窗口' : undefined; }
    constructor(private readonly storage?: TutorHistoryStorage, readonly owner = crypto.randomUUID()) { }
    private valid(value: unknown): value is TutorConversation {
        const c = value as TutorConversation;
        return !!c && c.schema === 1 && /^[\w-]{8,96}$/.test(c.id) && typeof c.owner === 'string' && typeof c.project === 'string' && c.project.length <= 8192
            && ['teach','ask'].includes(c.mode) && typeof c.title === 'string' && c.title.length <= 80 && Number.isFinite(c.updatedAt)
            && (c.customTitle === undefined || typeof c.customTitle === 'string' && titleLength(c.customTitle) <= 60 && !!c.customTitle && safeTitle(c.customTitle) === c.customTitle)
            && (c.archived === undefined || typeof c.archived === 'boolean')
            && (c.contexts === undefined || this.validContexts(c.contexts, c.mode)) && (c.includeCode === undefined || typeof c.includeCode === 'boolean')
            && typeof c.draft === 'string' && c.draft.length <= 6000 && Array.isArray(c.messages) && c.messages.length <= 100
            && c.messages.every(m => m && /^[\w-]{8,96}$/.test(m.id) && ['user','assistant'].includes(m.role) && typeof m.text === 'string'
                && m.text.length <= 64000 && ['pending','done','stopped','failed'].includes(m.status) && (m.note === undefined || typeof m.note === 'string' && m.note.length <= 4000)
                && (m.contextRefs === undefined || Array.isArray(m.contextRefs) && m.contextRefs.length <= 6 && m.contextRefs.every(isTutorContextRef))
                && (m.replyTo === undefined || typeof m.replyTo === 'string') && (!m.request || this.validSnapshot(m.request)));
    }
    private validSnapshot(s: TutorChatSnapshot): boolean {
        const b = s.buffer;
        return !!s && typeof s.prompt === 'string' && s.prompt.length <= 6000 && ['teach','ask'].includes(s.mode) && ['chat','step','line','goal'].includes(s.kind)
            && (s.contexts === undefined || this.validContexts(s.contexts, s.mode))
            && Number.isSafeInteger(s.goalRevision) && s.goalRevision >= 0 && (!b || typeof b.path === 'string' && b.path.length <= 1024
                && typeof b.text === 'string' && b.text.length <= 32000 && Number.isSafeInteger(b.version) && b.version > 0 && Number.isSafeInteger(b.line) && b.line > 0);
    }
    private validContexts(contexts: TutorContext[], mode: TutorMode): boolean { try { validateTutorContexts(contexts, mode); return true; } catch { return false; } }
    create(project: string, mode: TutorMode): TutorConversation {
        return { schema: 1, id: crypto.randomUUID(), project, mode, owner: this.owner, title: '新对话', updatedAt: Date.now(), messages: [], draft: '' };
    }
    private stored(id: string): TutorConversation | undefined {
        const raw = this.storage?.getItem(PREFIX + id);
        if (!raw || bytes(raw) > LIMIT) { return; }
        try { const value: unknown = JSON.parse(raw); if (this.valid(value) && value.id === id) { return value; } }
        catch { /* Corrupt records are never a source for writes or model requests. */ }
    }
    private metadata(record: TutorConversation): ConversationMetadata { return { customTitle: record.customTitle, archived: record.archived }; }
    private mergePending(record: TutorConversation, latest: TutorConversation | undefined, pending: PendingConversationWrite): TutorConversation {
        if (!latest) { return clone(record); }
        // A metadata retry must not roll back newer content from its owning window.
        // A content retry must not roll back metadata managed in another window.
        return { ...(pending.content ? record : latest), ...this.metadata(latest), ...pending.metadata };
    }
    private record(id: string, project: string, mode: TutorMode): TutorConversation | undefined {
        const memory = this.memory.get(id), pending = this.dirty.get(id);
        let latest: TutorConversation | undefined;
        try { latest = this.stored(id); }
        catch { latest = memory; /* Unavailable storage falls back to this window. */ }
        if (!this.storage) { latest = memory; }
        if (latest && (latest.project !== project || latest.mode !== mode)) { return; }
        const c = pending && memory?.project === project && memory.mode === mode ? this.mergePending(memory, latest, pending) : latest;
        return c && c.project === project && c.mode === mode ? clone(c) : undefined;
    }
    read(id: string, project: string, mode: TutorMode): TutorConversation | undefined {
        const copy = this.record(id, project, mode);
        if (copy) { for (const m of copy.messages) { if (m.status === 'pending') { m.status = 'stopped'; m.note = '回复未完成'; } } }
        return copy;
    }
    list(project: string, mode: TutorMode, includeArchived = false): TutorConversationSummary[] {
        const ids = new Set(this.memory.keys());
        try { for (let i = 0; i < (this.storage?.length ?? 0); ++i) { const key = this.storage!.key(i); if (key?.startsWith(PREFIX)) { ids.add(key.slice(PREFIX.length)); } } } catch { /* memory fallback */ }
        return [...ids].map(id => this.read(id, project, mode)).filter((c): c is TutorConversation => !!c && (includeArchived || !c.archived))
            .sort((a,b) => b.updatedAt - a.updatedAt).map(({id,title,updatedAt,archived}) => ({id,title,updatedAt,archived}));
    }
    history(project: string): TutorHistoryEntry[] {
        return (['ask', 'teach'] as const).flatMap(mode => this.list(project, mode, true).flatMap(summary => {
            const c = this.read(summary.id, project, mode);
            if (!c) { return []; }
            const preview = c.draft.trim() || [...c.messages].reverse().find(m => m.text.trim())?.text || c.contexts?.map(contextName).join(' · ') || '';
            return [{ ...summary, mode, title: conversationDisplayTitle(c), preview: redactChatSecrets(preview).replace(/\s+/g, ' ').trim().slice(0, 120).trim(),
                hasDraft: !!c.draft.trim(), status: [...c.messages].reverse().find(m => m.role === 'assistant')?.status, empty: emptyConversation(c) }];
        })).sort((a, b) => b.updatedAt - a.updatedAt);
    }
    rename(id: string, project: string, mode: TutorMode, title: string): TutorConversation {
        if (typeof title !== 'string' || !cleanTitle(title)) { throw new Error('对话名称不能为空'); }
        if (titleLength(title.trim()) > 60) { throw new Error('对话名称不能超过 60 个字符'); }
        const customTitle = safeTitle(title);
        if (titleLength(customTitle) > 60) { throw new Error('对话名称不能超过 60 个字符'); }
        return this.updateMetadata(id, project, mode, { customTitle });
    }
    setArchived(id: string, project: string, mode: TutorMode, archived: boolean): TutorConversation {
        if (typeof archived !== 'boolean') { throw new Error('归档状态无效'); }
        return this.updateMetadata(id, project, mode, { archived });
    }
    private updateMetadata(id: string, project: string, mode: TutorMode, metadata: ConversationMetadata): TutorConversation {
        // Do not use read(): recovery of pending replies is display-only, not a metadata edit.
        const previous = this.record(id, project, mode);
        if (!previous) { throw new Error('对话不存在、记录无效或不属于当前项目和模式'); }
        const updated = { ...previous, ...metadata };
        if (!this.valid(updated) || bytes(JSON.stringify(updated)) > LIMIT) { throw new Error('对话内容过大，未覆盖已保存历史'); }
        if (this.semantic(previous) !== this.semantic(updated)) { this.remember(updated, false, metadata); }
        this.flush();
        return this.record(id, project, mode) ?? updated;
    }
    private remember(record: TutorConversation, content: boolean, metadata: ConversationMetadata = {}): void {
        if (!this.memory.has(record.id) && this.memory.size >= 40) {
            const clean = [...this.memory.keys()].find(id => !this.dirty.has(id));
            if (clean) { this.memory.delete(clean); }
            else { throw new Error('未保存对话已达上限，请先重试保存'); }
        }
        const pending = this.dirty.get(record.id);
        this.memory.set(record.id, clone(record));
        this.dirty.set(record.id, { content: content || !!pending?.content, metadata: { ...pending?.metadata, ...metadata } });
    }
    /** At most 40 already-validated records; no network activity or replay of conversation requests. */
    flush(): void {
        if (!this.storage) { return; }
        for (const [id, pending] of [...this.dirty]) {
            const record = this.memory.get(id);
            if (!record) { this.dirty.delete(id); continue; }
            try {
                const latest = this.stored(id);
                if (latest && (latest.project !== record.project || latest.mode !== record.mode || latest.owner !== record.owner)) { break; }
                const merged = this.mergePending(record, latest, pending);
                if (!this.valid(merged) || bytes(JSON.stringify(merged)) > LIMIT) { break; }
                this.storage.setItem(PREFIX + id, JSON.stringify(merged));
                this.memory.set(id, clone(merged)); this.dirty.delete(id);
            } catch { break; }
        }
    }
    private semantic(record: TutorConversation): string {
        const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)])) : value;
        return JSON.stringify(stable({ draft: record.draft, contexts: record.contexts ?? [], includeCode: record.includeCode ?? true,
            customTitle: record.customTitle ?? '', archived: record.archived ?? false,
            messages: record.messages.map(m => ({ ...m, status: m.status === 'pending' ? 'stopped' : m.status,
                note: m.status === 'pending' ? '回复未完成' : m.note ?? '', contextRefs: m.contextRefs ?? [] })) }));
    }
    save(input: TutorConversation): TutorConversation {
        const c = clone(input);
        const previous = this.record(c.id, c.project, c.mode);
        // Management fields belong to the record, not a renderer's stale snapshot.
        // Merge before semantic comparison so metadata-only differences never fork.
        if (previous) { Object.assign(c, this.metadata(previous)); }
        else if (typeof c.customTitle === 'string') { c.customTitle = safeTitle(c.customTitle); }
        c.messages = c.messages.slice(-100);
        c.title = safeTitle(c.messages.find(m => m.role === 'user')?.text || '新对话').slice(0, 60) || '新对话';
        const durable = clone(c);
        durable.contexts = durable.contexts?.filter(c => redactChatSecrets(c.text) === c.text);
        durable.title = redactChatSecrets(durable.title); durable.draft = redactChatSecrets(durable.draft).slice(0, 6000);
        for (const m of durable.messages) {
            m.text = redactChatSecrets(m.text); if (m.note) { m.note = redactChatSecrets(m.note); }
            // Keep retry metadata only if no secret was removed from its original snapshot.
            if (m.request && redactChatSecrets(JSON.stringify(m.request)) !== JSON.stringify(m.request)) { delete m.request; }
        }
        while (bytes(JSON.stringify(durable)) > LIMIT && durable.messages.length > 2) { durable.messages.splice(0, 2); }
        if (!this.valid(durable) || bytes(JSON.stringify(durable)) > LIMIT) { throw new Error('对话内容过大，未覆盖已保存历史'); }
        if (previous && this.semantic(previous) === this.semantic(durable)) {
            // Opening, selecting, restoring pending state, and closing are reads. Keep
            // the foreign owner until an actual edit requires an independent branch.
            this.flush();
            return { ...c, ...this.metadata(this.record(c.id, c.project, c.mode) ?? previous), id: previous.id, owner: previous.owner, title: previous.title, updatedAt: previous.updatedAt };
        }
        if (!previous && emptyConversation(durable)) {
            // A blank (including whitespace-only) composer has a window-local active ID.
            this.flush(); return c;
        }
        // Never replace another renderer's changed transcript, even if the caller's
        // stale snapshot claims this window owns it.
        c.owner = previous?.owner ?? c.owner;
        if (c.owner !== this.owner) { c.id = crypto.randomUUID(); c.owner = this.owner; }
        c.updatedAt = Math.max(Date.now(), c.updatedAt + 1, (previous?.updatedAt ?? 0) + 1);
        durable.id = c.id; durable.owner = c.owner; durable.updatedAt = c.updatedAt;
        this.remember(durable, true);
        this.flush();
        Object.assign(c, this.metadata(this.record(c.id, c.project, c.mode) ?? durable));
        try {
            const entries: { key: string; size: number; time: number }[] = [];
            for (let i = 0; i < (this.storage?.length ?? 0); ++i) {
                const key = this.storage!.key(i); if (!key?.startsWith(PREFIX)) { continue; }
                const raw = this.storage!.getItem(key); if (!raw) { continue; }
                let time = 0; try { time = JSON.parse(raw).updatedAt || 0; } catch { /* evict corrupt */ }
                entries.push({key,size:bytes(raw),time});
            }
            entries.sort((a,b) => b.time - a.time);
            let total = 0;
            for (let i = 0; i < entries.length; ++i) { total += entries[i].size; if (entries[i].key !== PREFIX + c.id && (i >= 40 || total > TOTAL)) { const id = entries[i].key.slice(PREFIX.length); if (!this.dirty.has(id)) { this.storage!.removeItem(entries[i].key); this.memory.delete(id); } } }
        } catch { /* Quota/private mode preserves this window's bounded memory record. */ }
        return c;
    }
}
