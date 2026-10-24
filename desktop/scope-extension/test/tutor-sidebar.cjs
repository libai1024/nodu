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
        workspaceId: 'project', mode: 'teach', busy: undefined, error: undefined,
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
test('empty sidebar has one composer prompt with mode before model and no canned suggestions', () => {
    const html = render(tutor());
    assert.equal((html.match(/想实现什么功能/g) ?? []).length, 1);
    assert.doesNotMatch(html, /nodu-ai-empty|nodu-ai-suggestion|nodu-ai-author/);
    assert.ok(html.indexOf('aria-label="对话模式"') < html.indexOf('aria-label="模型"'));
});
test('request failures, stop, reconnect and model setup remain visible', () => {
    const html = render(tutor({ error: '连接断开', busy: { goal: 'check' }, settings: { providers: [] }, configured: false,
        messages: { teach: [{ id: 'failed', role: 'assistant', status: 'failed', text: '', note: '响应中断' }], ask: [] } }));
    for (const text of ['连接断开', '重连', '配置密钥', '响应中断', 'aria-label="停止"', '正在检查片段']) assert.ok(html.includes(text), text);
});
test('standalone courses retain course-specific decisions and manual review', () => {
    const step = { id: 'one', title: '初始化串口', goal: '配置 USART1', why: '', requirements: [], kind: 'code' };
    const html = render(tutor({ plan: { steps: [step] }, currentStep: () => step, available: () => true }));
    for (const text of ['课程步骤', '当前步骤', '自查完成', '重置进度', '定位代码']) assert.ok(html.includes(text), text);
});
