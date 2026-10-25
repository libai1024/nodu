// SPDX-License-Identifier: MIT
// Render the real sidebar with its service boundary stubbed. Layout screenshots
// remain Electron acceptance; these tests protect plan and recovery affordances.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = path.join(__dirname, '../lib/browser/nodu-tutor-widget.js');
const actualRequire = createRequire(filename);
require.extensions['.css'] = () => undefined;
const exported = {};
const noDecorator = () => () => undefined;
const stubs = {
    '@theia/core/shared/react': React,
    '@theia/core/shared/inversify': { inject: noDecorator, injectable: noDecorator, postConstruct: noDecorator },
    '@theia/core/lib/common': {},
    '@theia/core/lib/browser': { ReactWidget: class {}, CommonMenus: {} },
    '@theia/core/lib/browser/shell/view-contribution': { AbstractViewContribution: class {} },
    '@theia/core/lib/browser/dialogs': { ConfirmDialog: class {} },
    './nodu-tutor-model': { NoduTutorModel: class {} },
    './nodu-tutor-hints': { TUTOR_COMMANDS: {} },
};
vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\nexports.TutorPanel = TutorPanel; exports.GoalPlan = GoalPlan;`, {
    exports: exported, require: id => id in stubs ? stubs[id] : actualRequire(id),
});
function tutor(overrides = {}) {
    return {
        workspaceId: 'project', mode: 'teach', busy: undefined, error: undefined, pins: [], currentContextIncluded: true, connectionState: 'connected',
        currentStep: () => undefined, messages: { teach: [], ask: [] }, drafts: { teach: '', ask: '' },
        goalState: { status: 'none', steps: [], current: 0 }, progress: { steps: {} },
        ...overrides,
    };
}
const render = state => renderToStaticMarkup(React.createElement(exported.TutorPanel, { tutor: state, run() {} }));
const goal = status => ({ status, title: '串口输出', goal: '发送消息', current: 0, steps: [{ id: 'one', title: '初始化串口', path: 'main.c' }] });
test('accepted, paused and completed goals do not repeat task controls in the conversation', () => {
    for (const status of ['active', 'paused', 'complete']) {
        const html = render(tutor({ goalState: goal(status), plan: { steps: [] } }));
        assert.doesNotMatch(html, /nodu-ai-course|nodu-ai-progress|串口输出|检查片段|显示虚影|暂停|已完成代码跟写/);
        assert.match(html, /aria-label="教学消息"/);
    }
});
test('draft plans retain confirm, revise and cancel without becoming a second progress view', () => {
    const html = render(tutor({ goalState: goal('draft') }));
    assert.match(html, /确认教学计划/);
    assert.match(html, /初始化串口/);
    assert.match(html, /开始跟写/);
    assert.match(html, /修改目标/);
    assert.match(html, /取消/);
    assert.doesNotMatch(html, /nodu-ai-progress/);
    const busy = render(tutor({ goalState: goal('draft'), busy: { goal: 'propose' } }));
    assert.match(busy, /disabled="">开始跟写/);
});
test('empty sidebar has an accessible unprompted composer with mode before model', () => {
    const html = render(tutor());
    assert.match(html, /aria-label="教学消息"/); assert.doesNotMatch(html, /placeholder=|想实现什么功能|想了解什么/);
    assert.doesNotMatch(html, /nodu-ai-empty|nodu-ai-suggestion|nodu-ai-author/);
    assert.ok(html.indexOf('aria-label="对话模式"') < html.indexOf('aria-label="模型"'));
});
test('request failures, stop, reconnect and model setup remain visible', () => {
    const html = render(tutor({ error: '连接断开', connectionState: 'disconnected', busy: { goal: 'check' }, settings: { providers: [] }, configured: false,
        messages: { teach: [{ id: 'failed', role: 'assistant', status: 'failed', text: '', note: '响应中断' }], ask: [] } }));
    for (const text of ['连接已断开', '重连', '配置', '未收到回复', 'aria-label="停止"', '正在检查片段']) assert.ok(html.includes(text), text);
});
test('standalone course controls live only in the floating task window', () => {
    const step = { id: 'one', title: '初始化串口', goal: '配置 USART1', why: '', requirements: [], kind: 'code' };
    const html = render(tutor({ plan: { steps: [step] }, currentStep: () => step, available: () => true }));
    for (const text of ['课程步骤', '当前步骤', '自查完成', '重置进度', '定位代码']) assert.ok(!html.includes(text), text);
});

test('new operation errors remain inspectable after a failed reply', () => {
    const html = render(tutor({ error: '代码已更改', connectionState: 'connected', messages: { teach: [{ id: 'failed', role: 'assistant', status: 'failed', text: '', note: '响应中断' }], ask: [] } }));
    assert.match(html, /查看请求详情/);
    assert.match(html, /代码已更改/);
});
test('backend reconnect stays next to composer and never becomes an alert card', () => {
    const html = render(tutor({ connectionState: 'connecting', canSendChat: false, drafts: { teach: '保留草稿', ask: '' } }));
    assert.match(html, /正在重新连接/);
    assert.ok(html.indexOf('正在重新连接') > html.indexOf('nodu-ai-log'));
    assert.doesNotMatch(html, /role="alert"|codicon-warning|nodu-ai-error/);
    assert.match(html, /aria-label="发送"[^>]*disabled/);
});
test('current file navigation and removal are separate controls', () => {
    const html = render(tutor({ buffer: { path: 'Core/Src/main.c', line: 12, text: 'int main(void) {}', version: 1 }, includeCode: true }));
    assert.match(html, /Core\/Src\/main.c/);
    assert.match(html, /移除 main.c/);
    assert.doesNotMatch(html, /点击移除/);
});
test('local history storage failure offers saving without reconnect or replay', () => {
    const html = render(tutor({ historyStorageError: '对话暂未保存，内容保留在当前窗口' }));
    assert.match(html, /对话暂未保存/);
    assert.match(html, /重试保存/);
    assert.doesNotMatch(html, /重连|role="alert"|codicon-warning/);
});

test('history overlay leaves the transcript and composer visible in the panel', () => {
    const html=render(tutor({historyOpen:true,drafts:{teach:'未发送草稿',ask:''},messages:{teach:[{id:'message',role:'user',status:'done',text:'当前问题'}],ask:[]}}));
    assert.match(html,/当前问题/);assert.match(html,/未发送草稿/);
    assert.doesNotMatch(html,/class="nodu-ai-reading" hidden|<form hidden|nodu-chat-history/);
});

test('history picker uses compact titles and draft content without duplicate preview or mode rows', () => {
    const {ConversationHistory}=actualRequire('./nodu-tutor-history');
    const html=renderToStaticMarkup(React.createElement(ConversationHistory,{tutor:tutor({activeConversationId:'active',historyEntries:[
        {id:'active',title:'串口问题',mode:'teach',updatedAt:Date.now(),preview:'继续分析',hasDraft:true},
        {id:'other',title:'新对话',mode:'ask',updatedAt:Date.now()-86400000,preview:'分析编译失败',hasDraft:true},
    ]})}));
    assert.match(html,/搜索历史对话/);assert.match(html,/今天/);assert.match(html,/昨天/);assert.match(html,/aria-current="true"/);
    assert.match(html,/分析编译失败/);assert.match(html,/aria-label="草稿"/);assert.doesNotMatch(html,/继续分析|新对话|nodu-chat-history-preview|nodu-chat-history-meta|nodu-chat-history-filters/);
    assert.doesNotMatch(html,/placeholder=/);
});
