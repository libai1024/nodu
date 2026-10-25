// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import {
    API_FORMATS, TutorApiFormat, TutorModelConfig, TutorProviderConfig, TutorProviderView,
    allowsNoKey, formatTokens, modelDefaults, resolveEndpoint,
} from '../common/tutor/tutor-ai-config';
import type { TutorRemoteModel } from '../common/tutor/tutor-ai-protocol';
import { NoduTutorModel } from './nodu-tutor-model';
import { ChatPopover } from './nodu-tutor-chat-controls';
import '../../style/ai-provider-settings.css';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange(value: boolean): void }): React.ReactElement {
    return <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled}
        className={`nodu-ai-switch${checked ? ' nodu-ai-switch-on' : ''}`} onClick={() => onChange(!checked)}><span/></button>;
}
/** Green: usable. Orange: needs an API key. Grey: disabled. */
function statusOf(p: TutorProviderView): 'ok' | 'warn' | 'off' {
    if (!p.enabled) { return 'off'; }
    return p.hasKey || allowsNoKey(p.baseUrl) ? 'ok' : 'warn';
}

/** Compact provider disclosures keep credentials and models in one settings column. */
export function AISettingsPanel({ tutor, visible = true }: { tutor: NoduTutorModel; visible?: boolean }): React.ReactElement {
    const settings = tutor.settings;
    const id = React.useId();
    // undefined means first load; null means the user deliberately collapsed every provider.
    const [selected, setSelected] = React.useState<string | null>();
    const [error, setError] = React.useState('');
    if (!settings) { return <div className="nodu-ai-empty-settings">正在读取 AI 设置…</div>; }
    const active = selected === undefined ? settings.selection?.providerId ?? settings.providers[0]?.id : selected;
    const addProvider = async (): Promise<void> => {
        const providerId = `custom-${Math.random().toString(36).slice(2, 8)}`;
        try {
            setError('');
            await tutor.saveProvider({ id: providerId, name: '新供应商', kind: 'custom', enabled: true, baseUrl: 'https://api.example.com/v1', apiFormat: 'chat-completions', models: [] });
            setSelected(providerId);
        } catch (e) { setError(message(e)); }
    };
    return <div className="nodu-ai-provider-catalog">
        <div className="nodu-ai-catalog-heading"><h3>AI 服务商</h3><button type="button" className="nodu-ai-catalog-add" onClick={() => void addProvider()}><i className="codicon codicon-add" aria-hidden="true"/>添加供应商</button></div>
        {error && <div className="nodu-ai-form-error" role="alert">{error}</div>}
        {settings.providers.map((provider, index) => {
            const expanded = active === provider.id, status = statusOf(provider);
            return <section key={provider.id} className="nodu-ai-provider-card">
                <button type="button" className="nodu-ai-provider-summary" aria-expanded={expanded} aria-controls={`${id}-provider-${index}`}
                    onClick={() => setSelected(expanded ? null : provider.id)}>
                    <i className={`codicon codicon-${provider.kind === 'builtin' ? 'sparkle' : 'package'}`} aria-hidden="true"/>
                    <span className="nodu-ai-provider-name">{provider.name}</span>
                    <span className="nodu-ai-provider-count">{provider.models.length} 个模型</span>
                    <span className={`nodu-ai-dot nodu-ai-dot-${status}`} aria-label={status === 'ok' ? '已配置' : status === 'warn' ? '缺少 API Key' : '已停用'}/>
                    <i className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden="true"/>
                </button>
                <div id={`${id}-provider-${index}`} hidden={!expanded} className="nodu-ai-provider-content">
                    <ProviderDetail tutor={tutor} provider={provider} visible={visible && expanded} onDeleted={() => setSelected(null)}/>
                </div>
            </section>;
        })}
    </div>;
}

function ProviderDetail({ tutor, provider, visible, onDeleted }: { tutor: NoduTutorModel; provider: TutorProviderView; visible: boolean; onDeleted(): void }): React.ReactElement {
    const locked = provider.kind === 'builtin';
    const [name, setName] = React.useState(provider.name);
    const [baseUrl, setBaseUrl] = React.useState(provider.baseUrl);
    const [format, setFormat] = React.useState<TutorApiFormat>(provider.apiFormat);
    const [key, setKey] = React.useState('');
    const [showKey, setShowKey] = React.useState(false);
    const [busy, setBusy] = React.useState('');
    const running = React.useRef(false);
    const [error, setError] = React.useState('');
    const [tests, setTests] = React.useState<Record<string, { ok: boolean; message: string } | 'running'>>({});
    const [editing, setEditing] = React.useState<TutorModelConfig | 'new' | undefined>();
    const [connectionOpen, setConnectionOpen] = React.useState(provider.kind === 'custom' && !provider.models.length);
    const [formatAnchor, setFormatAnchor] = React.useState<HTMLElement>();
    const closeFormat = React.useCallback(() => setFormatAnchor(undefined), []);
    const connectionId = React.useId();
    const [remote, setRemote] = React.useState<TutorRemoteModel[]>([]);
    const savedConnection = React.useRef({ name: provider.name, baseUrl: provider.baseUrl, format: provider.apiFormat });
    React.useEffect(() => { if (!visible || !connectionOpen) { closeFormat(); } }, [visible, connectionOpen, closeFormat]);
    React.useEffect(() => {
        const previous = savedConnection.current;
        // Retain drafts when another provider/page is opened; refresh only untouched fields.
        setName(value => value === previous.name ? provider.name : value);
        setBaseUrl(value => value === previous.baseUrl ? provider.baseUrl : value);
        setFormat(value => value === previous.format ? provider.apiFormat : value);
        savedConnection.current = { name: provider.name, baseUrl: provider.baseUrl, format: provider.apiFormat };
    }, [provider.name, provider.baseUrl, provider.apiFormat]);
    const dirty = name !== provider.name || baseUrl !== provider.baseUrl || format !== provider.apiFormat;
    const selection = tutor.settings?.selection;
    const config = (patch: Partial<TutorProviderConfig> = {}): TutorProviderConfig => ({ id: provider.id, name: provider.name, kind: provider.kind, enabled: provider.enabled,
        baseUrl: provider.baseUrl, apiFormat: provider.apiFormat, models: provider.models, ...patch });
    const run = async (label: string, work: () => Promise<unknown>): Promise<void> => {
        if (running.current) { return; }
        running.current = true;
        setBusy(label); setError('');
        try { await work(); } catch (e) { setError(message(e)); } finally { running.current = false; setBusy(''); }
    };
    const saveKey = (): Promise<void> => {
        const submitted = key;
        return run('key', async () => {
            await tutor.setProviderKey(provider.id, submitted);
            setKey(current => current === submitted ? '' : current);
            setShowKey(false);
        });
    };
    let endpoint = provider.endpoint;
    try { endpoint = resolveEndpoint(baseUrl, format); } catch { /* shown after save */ }
    const saveModels = (models: TutorModelConfig[]) => run('models', () => tutor.saveProvider(config({ models })));
    const test = async (model: TutorModelConfig): Promise<void> => {
        setTests(t => ({ ...t, [model.id]: 'running' }));
        const result = await tutor.testModel(provider.id, model.id).catch(e => ({ ok: false, message: message(e) }));
        setTests(t => ({ ...t, [model.id]: result }));
    };
    const fetchRemote = () => run('remote', async () => { setRemote(await tutor.listRemoteModels(provider.id)); setEditing('new'); });
    return <div className="nodu-ai-provider-form">
        <header className="nodu-ai-provider-controls">
            <span>启用供应商</span><Switch checked={provider.enabled} disabled={!!busy} label={provider.enabled ? '停用供应商' : '启用供应商'} onChange={enabled => void run('enable', () => tutor.saveProvider(config({ enabled })))}/>
            {!locked && <button type="button" className="nodu-ai-icon" aria-label="删除供应商" title="删除供应商" disabled={!!busy}
                onClick={() => void run('remove', async () => { await tutor.removeProvider(provider.id); onDeleted(); })}><i className="codicon codicon-trash" aria-hidden="true"/></button>}
        </header>
        <label className="nodu-ai-field"><span>API Key{provider.hasKey && <span className="nodu-ai-key-status">已设置</span>}</span>
            <div className="nodu-ai-key-row">
                <input type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={key}
                    onChange={e => { setKey(e.target.value); setShowKey(false); }} onKeyDown={e => { if (e.key === 'Enter' && key) { e.preventDefault(); void saveKey(); } }}/>
                {key && <button type="button" className="nodu-ai-icon" aria-label={showKey ? '隐藏' : '显示'} title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey(!showKey)}><i className={`codicon codicon-${showKey ? 'eye-closed' : 'eye'}`} aria-hidden="true"/></button>}
                {key && <button type="button" className="theia-button" disabled={!!busy} onClick={() => void saveKey()}>保存</button>}
                {!key && provider.hasKey && <button type="button" className="nodu-ai-text-action" disabled={!!busy} onClick={() => void run('key', () => tutor.deleteProviderKey(provider.id))}>删除</button>}
            </div></label>
        {error && <div className="nodu-ai-form-error" role="alert">{error}</div>}
        <div className="nodu-ai-models-head">
            <span>模型列表</span>
            <button type="button" className="nodu-ai-text-action" disabled={!!busy} onClick={() => void fetchRemote()}>{busy === 'remote' ? '读取中…' : '获取模型'}</button>
            <button type="button" className="nodu-ai-chip" disabled={!!busy} onClick={() => setEditing('new')}><i className="codicon codicon-add" aria-hidden="true"/>添加模型</button>
        </div>
        <ul className="nodu-ai-models" aria-label="模型列表">
            {provider.models.map((m, index) => {
                const current = selection?.providerId === provider.id && selection.modelId === m.id;
                const result = tests[m.id];
                return <li key={m.id} className={`nodu-ai-model-row${m.enabled ? '' : ' nodu-ai-model-off'}`}>
                    <button type="button" className={`nodu-ai-model-use${current ? ' nodu-ai-model-use-on' : ''}`} disabled={!!busy || !m.enabled || !provider.enabled}
                        aria-label={current ? '当前使用的模型' : '使用此模型'} title={current ? '当前使用的模型' : '使用此模型'}
                        onClick={() => void run('select', () => tutor.selectModel({ providerId: provider.id, modelId: m.id }))}><i className={`codicon codicon-${current ? 'pass-filled' : 'circle-large-outline'}`} aria-hidden="true"/></button>
                    <code className="nodu-ai-model-id" title={m.id}>{m.id}</code>
                    {m.contextWindow && <span className="nodu-ai-badge" title="上下文窗口">{formatTokens(m.contextWindow)}</span>}
                    {provider.apiFormat !== 'anthropic-messages' && m.reasoningLevels.length > 0 && <span className="nodu-ai-badge" title={m.reasoningLevels.join(' / ')}>推理</span>}
                    {result && result !== 'running' && <span className={`nodu-ai-test ${result.ok ? 'nodu-ai-test-ok' : 'nodu-ai-test-fail'}`} title={result.message}>{result.ok ? result.message : '失败'}</span>}
                    <span className="nodu-ai-model-actions">
                        <button type="button" className="nodu-ai-icon" aria-label="测试连接" title={result && result !== 'running' && !result.ok ? result.message : '测试连接'} disabled={result === 'running'} onClick={() => void test(m)}>
                            <i className={`codicon codicon-${result === 'running' ? 'loading codicon-modifier-spin' : 'plug'}`} aria-hidden="true"/></button>
                        <button type="button" className="nodu-ai-icon" aria-label="编辑模型" title="编辑模型" disabled={!!busy} onClick={() => setEditing(m)}><i className="codicon codicon-edit" aria-hidden="true"/></button>
                        <button type="button" className="nodu-ai-icon" aria-label="删除模型" title="删除模型" disabled={!!busy} onClick={() => void saveModels(provider.models.filter((_, i) => i !== index))}><i className="codicon codicon-trash" aria-hidden="true"/></button>
                        <Switch checked={m.enabled} disabled={!!busy} label={m.enabled ? '停用模型' : '启用模型'} onChange={enabled => void saveModels(provider.models.map((x, i) => i === index ? { ...x, enabled } : x))}/>
                    </span>
                </li>;
            })}
        </ul>
        <button type="button" className="nodu-ai-connection-trigger" aria-expanded={connectionOpen} aria-controls={connectionId} onClick={() => setConnectionOpen(!connectionOpen)}>
            <i className={`codicon codicon-chevron-${connectionOpen ? 'down' : 'right'}`} aria-hidden="true"/>连接设置
        </button>
        <div id={connectionId} hidden={!connectionOpen} className="nodu-ai-connection-fields">
            {!locked && <label className="nodu-ai-field"><span>供应商名称</span><input value={name} maxLength={40} onChange={e => setName(e.target.value)}/></label>}
        <label className="nodu-ai-field"><span>Base URL</span>
            <input value={baseUrl} readOnly={locked} spellCheck={false} onChange={e => setBaseUrl(e.target.value)}/></label>
        <label className="nodu-ai-field"><span>API 格式</span>
            <button type="button" className="nodu-ai-format-trigger" value={format} disabled={locked} aria-label="API 格式" aria-haspopup="menu" aria-expanded={!!formatAnchor}
                onClick={e => setFormatAnchor(formatAnchor ? undefined : e.currentTarget)}
                onKeyDown={e => { if (!locked && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); e.stopPropagation(); setFormatAnchor(e.currentTarget); } }}>
                <span>{API_FORMATS.find(f => f.value === format)?.label}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/>
            </button></label>
        {formatAnchor && visible && connectionOpen && !locked && <ChatPopover anchor={formatAnchor} label="API 格式" layer="settings" align="start" close={closeFormat}>
            {API_FORMATS.map(f => <button key={f.value} type="button" role="menuitemradio" aria-checked={format === f.value} value={f.value}
                onClick={() => { setFormat(f.value); closeFormat(); if (formatAnchor.isConnected) { formatAnchor.focus(); } }}>
                <span>{f.label}</span><i className={`codicon ${format === f.value ? 'codicon-check' : ''}`} aria-hidden="true"/>
            </button>)}
        </ChatPopover>}
        <div className="nodu-ai-endpoint" title="实际请求地址">{endpoint}</div>
        {dirty && <div className="nodu-ai-form-actions">
            <button type="button" className="theia-button secondary" onClick={() => { setName(provider.name); setBaseUrl(provider.baseUrl); setFormat(provider.apiFormat); }}>还原</button>
            <button type="button" className="theia-button" disabled={!!busy} onClick={() => void run('save', () => tutor.saveProvider(config({ name, baseUrl, apiFormat: format })))}>保存</button>
        </div>}
        </div>
        {editing && visible && <ModelDialog format={provider.apiFormat} initial={editing === 'new' ? undefined : editing} remote={remote} taken={provider.models.map(m => m.id)}
            onClose={() => setEditing(undefined)}
            onSave={async model => {
                const models = editing === 'new' ? [...provider.models, model] : provider.models.map(m => m.id === editing.id ? model : m);
                await tutor.saveProvider(config({ models }));
                setEditing(undefined);
            }}/>}
    </div>;
}

function ModelDialog({ format, initial, remote, taken, onSave, onClose }: { format: TutorApiFormat; initial?: TutorModelConfig; remote: TutorRemoteModel[]; taken: string[];
    onSave(model: TutorModelConfig): Promise<void>; onClose(): void }): React.ReactElement {
    const [model, setModel] = React.useState<TutorModelConfig>(initial ?? modelDefaults(''));
    const [smart, setSmart] = React.useState(!initial);
    const [advanced, setAdvanced] = React.useState(!!initial);
    const [level, setLevel] = React.useState('');
    const [error, setError] = React.useState('');
    const [saving, setSaving] = React.useState(false);
    const [modelAnchor, setModelAnchor] = React.useState<HTMLElement>();
    const [search, setSearch] = React.useState('');
    const closeModels = React.useCallback(() => { setModelAnchor(undefined); setSearch(''); }, []);
    const dialog = React.useRef<HTMLDivElement>(null);
    const [previous] = React.useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    React.useLayoutEffect(() => {
        dialog.current?.querySelector<HTMLElement>('input')?.focus();
        return () => { if (previous?.isConnected) { previous.focus(); } };
    }, []);
    const keyboard = (event: React.KeyboardEvent): void => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== 'Tab') { return; }
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? []);
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); elements.at(-1)?.focus(); }
        else if (!event.shiftKey && (index < 0 || index === elements.length - 1)) { event.preventDefault(); elements[0]?.focus(); }
    };
    const set = (patch: Partial<TutorModelConfig>) => setModel(m => ({ ...m, ...patch }));
    const number = (value: string): number | undefined => value.trim() ? Math.max(0, Math.floor(Number(value))) || undefined : undefined;
    const pickId = (id: string): void => {
        const found = smart ? remote.find(r => r.id === id) : undefined;
        // Smart config fills what the provider reports and leaves the rest to the user.
        set({ id, ...(found?.contextWindow ? { contextWindow: found.contextWindow } : {}) });
    };
    const available = remote.filter(r => !taken.includes(r.id) || r.id === initial?.id);
    const matches = available.filter(r => r.id.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const addLevel = () => { const v = level.trim(); if (v && !model.reasoningLevels.includes(v)) { set({ reasoningLevels: [...model.reasoningLevels, v] }); } setLevel(''); };
    const save = async (): Promise<void> => {
        if (!model.id.trim()) { setError('请输入模型 ID'); return; }
        if (model.id !== initial?.id && taken.includes(model.id.trim())) { setError('该模型 ID 已存在'); return; }
        setSaving(true); setError('');
        try { await onSave({ ...model, id: model.id.trim() }); } catch (e) { setError(message(e)); } finally { setSaving(false); }
    };
    return <div className="nodu-ai-dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) { onClose(); } }}>
        <div ref={dialog} className="nodu-ai-dialog" role="dialog" aria-modal="true" aria-label={initial ? '编辑模型' : '添加模型'} onKeyDown={keyboard}>
            <header><h3>{initial ? '编辑模型' : '添加模型'}</h3><button type="button" className="nodu-ai-icon" aria-label="关闭" onClick={onClose}><i className="codicon codicon-close" aria-hidden="true"/></button></header>
            <div className="nodu-ai-dialog-body">
                <div className="nodu-ai-field-inline"><span>智能配置</span><Switch checked={smart} label="智能配置" onChange={setSmart}/></div>
                <div className="nodu-ai-model-id-field">
                    <label className="nodu-ai-field"><span>模型 ID</span>
                        <input autoFocus value={model.id} spellCheck={false} onChange={e => pickId(e.target.value)}/></label>
                    {available.length > 0 && <button type="button" className="nodu-ai-model-candidates" aria-label="选择模型 ID" aria-haspopup="menu" aria-expanded={!!modelAnchor}
                        onClick={e => { if (modelAnchor) { closeModels(); } else { setModelAnchor(e.currentTarget); } }}
                        onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setModelAnchor(e.currentTarget); } }}>
                        <i className="codicon codicon-chevron-down" aria-hidden="true"/>
                    </button>}
                </div>
                {modelAnchor && <ChatPopover anchor={modelAnchor} label="模型 ID" layer="settings" width={288} close={closeModels}>
                    <input className="nodu-ai-menu-search" aria-label="搜索模型 ID" value={search} onChange={e => setSearch(e.target.value)}/>
                    <div className="nodu-ai-menu-scroll">{matches.map(r => <button key={r.id} type="button" role="menuitemradio" aria-checked={model.id === r.id}
                        onClick={() => { pickId(r.id); closeModels(); if (modelAnchor.isConnected) { modelAnchor.focus(); } }}>
                        <span>{r.id}</span><i className={`codicon ${model.id === r.id ? 'codicon-check' : ''}`} aria-hidden="true"/>
                    </button>)}{!matches.length && <div className="nodu-ai-menu-empty" role="status">没有匹配的模型</div>}</div>
                </ChatPopover>}
                <label className="nodu-ai-field"><span>上下文窗口</span>
                    <input inputMode="numeric" value={model.contextWindow ?? ''} onChange={e => set({ contextWindow: number(e.target.value) })}/></label>
                <label className="nodu-ai-field"><span>最大输出 Tokens</span>
                    <input inputMode="numeric" value={model.maxOutputTokens ?? ''} onChange={e => set({ maxOutputTokens: number(e.target.value) })}/></label>
                {format !== 'anthropic-messages' && <button type="button" className="nodu-ai-disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><i className={`codicon codicon-chevron-${advanced ? 'down' : 'right'}`} aria-hidden="true"/>高级配置</button>}
                {advanced && format !== 'anthropic-messages' && <>
                    <div className="nodu-ai-field"><span>推理等级</span>
                        <div className="nodu-ai-levels">
                            {model.reasoningLevels.map(l => <span key={l} className="nodu-ai-level">{l}<button type="button" aria-label={`移除 ${l}`} onClick={() => set({ reasoningLevels: model.reasoningLevels.filter(x => x !== l) })}><i className="codicon codicon-close" aria-hidden="true"/></button></span>)}
                            <input value={level} aria-label="添加推理等级" onChange={e => setLevel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addLevel(); } }}/>
                            <button type="button" className="nodu-ai-icon" aria-label="添加推理等级" disabled={!level.trim()} onClick={addLevel}><i className="codicon codicon-add" aria-hidden="true"/></button>
                        </div></div>
                </>}
                {error && <div className="nodu-ai-form-error" role="alert">{error}</div>}
            </div>
            <footer><button type="button" className="theia-button secondary" onClick={onClose}>取消</button><button type="button" className="theia-button" disabled={saving} onClick={() => void save()}>{initial ? '保存' : '添加'}</button></footer>
        </div>
    </div>;
}
