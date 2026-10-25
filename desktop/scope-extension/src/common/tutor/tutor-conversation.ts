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
        && (ref.kind === 'terminal' ? isTerminalContextName(ref.path) : isSafeCoursePath(ref.path) && /\.(c|h|cpp|hpp|cc|py)$/i.test(ref.path))
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
export interface TutorConversationSummary { id: string; title: string; updatedAt: number; }
export interface TutorHistoryEntry extends TutorConversationSummary { mode: TutorMode; preview: string; hasDraft: boolean; }
export interface TutorConversation extends TutorConversationSummary {
    schema: 1; project: string; mode: TutorMode; owner: string; messages: TutorChatItem[]; draft: string; contexts?: TutorContext[]; includeCode?: boolean;
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
    private readonly dirty = new Set<string>();
    get storageError(): string | undefined { return this.dirty.size ? '对话暂未保存，内容保留在当前窗口' : undefined; }
    constructor(private readonly storage?: TutorHistoryStorage, readonly owner = crypto.randomUUID()) { }
    private valid(value: unknown): value is TutorConversation {
        const c = value as TutorConversation;
        return !!c && c.schema === 1 && /^[\w-]{8,96}$/.test(c.id) && typeof c.owner === 'string' && typeof c.project === 'string' && c.project.length <= 8192
            && ['teach','ask'].includes(c.mode) && typeof c.title === 'string' && c.title.length <= 80 && Number.isFinite(c.updatedAt)
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
    read(id: string, project: string, mode: TutorMode): TutorConversation | undefined {
        let c: TutorConversation | undefined = this.dirty.has(id) ? this.memory.get(id) : undefined;
        try {
            const raw = c ? undefined : this.storage?.getItem(PREFIX + id);
            if (raw && bytes(raw) <= LIMIT) { const value: unknown = JSON.parse(raw); if (this.valid(value)) { c = value; } }
        } catch { /* Corrupt/unavailable storage never becomes a model request. */ }
        c ??= this.memory.get(id);
        if (!c || c.project !== project || c.mode !== mode) { return; }
        const copy = clone(c);
        for (const m of copy.messages) { if (m.status === 'pending') { m.status = 'stopped'; m.note = '回复未完成'; } }
        return copy;
    }
    list(project: string, mode: TutorMode): TutorConversationSummary[] {
        const ids = new Set(this.memory.keys());
        try { for (let i = 0; i < (this.storage?.length ?? 0); ++i) { const key = this.storage!.key(i); if (key?.startsWith(PREFIX)) { ids.add(key.slice(PREFIX.length)); } } } catch { /* memory fallback */ }
        return [...ids].map(id => this.read(id, project, mode)).filter((c): c is TutorConversation => !!c)
            .sort((a,b) => b.updatedAt - a.updatedAt).map(({id,title,updatedAt}) => ({id,title,updatedAt}));
    }
    history(project: string): TutorHistoryEntry[] {
        return (['ask', 'teach'] as const).flatMap(mode => this.list(project, mode).map(summary => {
            const c = this.read(summary.id, project, mode)!;
            return { ...summary, mode, preview: (c.draft || c.messages.at(-1)?.text || c.contexts?.map(item => item.kind === 'terminal' ? terminalContextLabel(item) : item.path.split('/').pop()).join(' · ') || '').replace(/\s+/g, ' ').slice(0, 120), hasDraft: !!c.draft };
        })).sort((a, b) => b.updatedAt - a.updatedAt);
    }
    /** At most 40 already-validated records; no network activity or replay of conversation requests. */
    flush(): void {
        if (!this.storage) { return; }
        for (const id of [...this.dirty]) {
            const record = this.memory.get(id);
            if (!record) { this.dirty.delete(id); continue; }
            try { this.storage.setItem(PREFIX + id, JSON.stringify(record)); this.dirty.delete(id); }
            catch { break; }
        }
    }
    private semantic(record: TutorConversation): string {
        const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)])) : value;
        return JSON.stringify(stable({ draft: record.draft, contexts: record.contexts ?? [], includeCode: record.includeCode ?? true,
            messages: record.messages.map(m => ({ ...m, status: m.status === 'pending' ? 'stopped' : m.status,
                note: m.status === 'pending' ? '回复未完成' : m.note ?? '', contextRefs: m.contextRefs ?? [] })) }));
    }
    save(input: TutorConversation): TutorConversation {
        const c = clone(input);
        c.messages = c.messages.slice(-100);
        c.title = (c.messages.find(m => m.role === 'user')?.text.trim().replace(/\s+/g, ' ') || '新对话').slice(0, 60);
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
        const previous = this.read(c.id, c.project, c.mode);
        if (previous && this.semantic(previous) === this.semantic(durable)) {
            // Opening, selecting, restoring pending state, and closing are reads. Keep
            // the foreign owner until an actual edit requires an independent branch.
            this.flush();
            return { ...c, id: previous.id, owner: previous.owner, title: previous.title, updatedAt: previous.updatedAt };
        }
        if (!previous && !durable.messages.length && !durable.draft && !durable.contexts?.length) {
            // A blank composer has a window-local active ID, not a permanent history entry.
            this.flush(); return c;
        }
        // Never replace another renderer's changed transcript.
        if (c.owner !== this.owner) { c.id = crypto.randomUUID(); c.owner = this.owner; }
        c.updatedAt = Math.max(Date.now(), c.updatedAt + 1);
        durable.id = c.id; durable.owner = c.owner; durable.updatedAt = c.updatedAt;
        // Preserve failed writes until a later explicit/normal save succeeds. Never let
        // an older disk record replace the newer in-window transcript.
        if (!this.memory.has(c.id) && this.memory.size >= 40) {
            const clean = [...this.memory.keys()].find(id => !this.dirty.has(id));
            if (clean) { this.memory.delete(clean); }
            else { throw new Error('未保存对话已达上限，请先重试保存'); }
        }
        this.memory.set(c.id, clone(durable)); this.dirty.add(c.id);
        this.flush();
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
