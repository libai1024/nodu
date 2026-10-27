// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MinimalActionGesture, minimalFanGeometry, MINIMAL_ACTIONS } = require('../lib/browser/nodu-minimal-action-state');

function mountedFanEvents(overrides = {}) {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const vm = require('node:vm');
    const windowEvents = new Map(), documentEvents = new Map(), effects = [], changes = [], focused = [];
    class TestNode {}
    const react = {
        __esModule: true, Fragment: Symbol('Fragment'),
        createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
        useRef(value) { return { current: value }; },
        useState() { return [{ scopeKey: 'project', geometry: minimalFanGeometry(26, 724, 1200, 768) }, value => changes.push(value)]; },
        useCallback(fn) { return fn; }, useId() { return 'test-fan'; },
        useEffect(fn) { effects.push(fn); }, useLayoutEffect() {},
    };
    const window = {
        innerWidth: 1200, innerHeight: 768,
        addEventListener(kind, fn) { windowEvents.set(kind, fn); }, removeEventListener(kind) { windowEvents.delete(kind); },
    };
    const document = {
        body: {}, hidden: false,
        addEventListener(kind, fn) { documentEvents.set(kind, fn); }, removeEventListener(kind) { documentEvents.delete(kind); },
    };
    const filename = resolve(__dirname, '../lib/browser/nodu-minimal-action.js');
    const mod = { exports: {} };
    vm.runInNewContext(readFileSync(filename, 'utf8'), {
        module: mod, exports: mod.exports, window, document, Node: TestNode,
        require(id) {
            if (id === '@theia/core/shared/react') { return react; }
            if (id === 'react-dom') { return { createPortal: tree => tree }; }
            if (id.endsWith('.css')) { return {}; }
            if (id === './nodu-minimal-action-state') { return require('../lib/browser/nodu-minimal-action-state'); }
            throw new Error(`Unexpected import: ${id}`);
        },
    }, { filename });
    const componentProps = { action: 'build', scopeKey: 'project', busy: false, allowSelection: true,
        onSelect() {}, onExecute() {}, onStop() {}, ...overrides };
    const tree = mod.exports.NoduMinimalAction(componentProps);
    const [button, menu] = tree.props.children;
    const trigger = { isConnected: true, disabled: false, focus: options => focused.push(options) };
    button.props.ref.current = trigger;
    const cleanup = effects.map(fn => fn());
    return { trigger, changes, focused, button, menu,
        updateLiveProps(next) { Object.assign(componentProps, next); },
        choose(index) { menu.props.children.flat()[index].props.onClick({ detail: 1 }); },
        clickPrimary(detail = 0) { button.props.onClick({ detail }); },
        closeByEscape() { documentEvents.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); },
        focusMenu() { menu.props.onFocusCapture(); },
        focusOutside() { menu.props.onBlurCapture({ relatedTarget: new TestNode(), currentTarget: { contains: () => false } }); },
        emit(kind) { windowEvents.get(kind)({ type: kind }); },
        hide() { document.hidden = true; documentEvents.get('visibilitychange')(); },
        dispose() { cleanup.forEach(fn => fn?.()); },
    };
}

function clock() {
    let now = 0, nextId = 0;
    const jobs = new Map();
    return {
        set(callback, delay) { const id = ++nextId; jobs.set(id, { callback, due: now + delay }); return id; },
        clear(id) { jobs.delete(id); },
        now: () => now,
        elapse(ms) { now += ms; },
        tick(ms) {
            now += ms;
            for (const [id, job] of [...jobs]) { if (job.due <= now) { jobs.delete(id); job.callback(); } }
        },
        pending: () => jobs.size,
    };
}

function setup() {
    const timer = clock(), calls = [];
    const gesture = new MinimalActionGesture(() => calls.push('open'), 500, timer.set, timer.clear, timer.now);
    const click = () => { if (!gesture.consumeClick()) { calls.push('execute'); } };
    return { timer, calls, gesture, click };
}

test('a short press executes exactly once and never opens choices later', () => {
    const { timer, calls, gesture, click } = setup();
    gesture.begin(1, 20, 400, true);
    timer.tick(499);
    gesture.release(1); click(); timer.tick(1000);
    assert.deepEqual(calls, ['execute']);
    assert.equal(timer.pending(), 0);
});

test('long press only opens choices; releasing and its native click never execute', () => {
    const { timer, calls, gesture, click } = setup();
    gesture.begin(1, 20, 400, true);
    timer.tick(500);
    assert.deepEqual(calls, ['open']);
    gesture.release(1); gesture.lostCapture(1); click(); timer.tick(1000);
    assert.deepEqual(calls, ['open']);
    gesture.begin(2, 20, 400, true); gesture.release(2); click();
    assert.deepEqual(calls, ['open', 'execute']);
});

test('K210 and busy stop never offer choices, including after a long press', () => {
    const { timer, calls, gesture, click } = setup();
    gesture.begin(1, 20, 400, false);
    timer.tick(10000);
    assert.equal(timer.pending(), 0);
    gesture.release(1); click();
    assert.deepEqual(calls, ['execute']);
});

test('an overdue timeout cannot turn a physical long press into an execute on pointer-up', () => {
    const { timer, calls, gesture, click } = setup();
    gesture.begin(1, 20, 400, true);
    timer.elapse(650); // Renderer was occupied; its setTimeout callback has not run yet.
    gesture.release(1); click(); timer.tick(1000);
    assert.deepEqual(calls, ['open']);
    assert.equal(timer.pending(), 0);
});

test('late pointer-up does not reopen an already-opened fan or bypass K210 selection policy', () => {
    const { timer, calls, gesture, click } = setup();
    gesture.begin(1, 20, 400, true); timer.tick(500); timer.elapse(500);
    gesture.release(1); click();
    assert.deepEqual(calls, ['open']);
    gesture.begin(2, 20, 400, false); timer.elapse(650); gesture.release(2); click();
    assert.deepEqual(calls, ['open', 'execute']);
});

test('dragging away cancels a pending press and suppresses its synthetic click', () => {
    const { timer, calls, gesture, click } = setup();
    gesture.begin(1, 20, 400, true);
    gesture.move(1, 100, 400); timer.tick(1000);
    gesture.release(1); click();
    assert.deepEqual(calls, []);
});

test('scope, busy, blur or unmount cancellation invalidates old pointer-up/click', () => {
    for (const elapsed of [200, 600]) {
        const { timer, calls, gesture, click } = setup();
        gesture.begin(1, 20, 400, true); timer.tick(elapsed);
        gesture.cancel(); gesture.release(1); click(); timer.tick(1000);
        assert.deepEqual(calls, elapsed < 500 ? [] : ['open']);
        assert.equal(timer.pending(), 0);
    }
});

test('assistive activation works after mounting or cancellation without permitting a long-press pointer click', () => {
    const { timer, calls, gesture } = setup();
    gesture.cancel(); // The component invalidates old gestures when its scope is mounted/changed.
    assert.equal(gesture.consumeClick(0), false);
    gesture.begin(1, 20, 400, true); timer.tick(500); gesture.release(1);
    assert.equal(gesture.consumeClick(1), true);
    assert.deepEqual(calls, ['open']);
    gesture.cancel();
    assert.equal(gesture.consumeClick(0), false);
});

test('explicit keyboard/AT activation cancels any preceding unfinished long-press timer', () => {
    const { timer, calls, gesture } = setup();
    gesture.begin(1, 20, 400, true); timer.tick(300);
    assert.equal(gesture.consumeClick(0), false);
    timer.tick(1000);
    assert.deepEqual(calls, []);
});

test('unexpected capture loss cancels but normal pointer-up capture loss preserves short click', () => {
    const { timer, calls, gesture, click } = setup();
    gesture.begin(1, 20, 400, true); gesture.lostCapture(1); timer.tick(1000); click();
    assert.deepEqual(calls, []);
    gesture.begin(2, 20, 400, true); gesture.release(2); gesture.lostCapture(2); click();
    assert.deepEqual(calls, ['execute']);
});

test('events for unrelated pointers cannot release or move the active press', () => {
    const { timer, calls, gesture } = setup();
    gesture.begin(1, 20, 400, true);
    gesture.move(2, 100, 100); gesture.release(2); gesture.lostCapture(2); timer.tick(500);
    assert.deepEqual(calls, ['open']);
});

test('a new pointer start clears stale suppression and cancels the preceding timer', () => {
    const { timer, calls, gesture, click } = setup();
    gesture.begin(1, 20, 400, true); timer.tick(300);
    gesture.begin(2, 20, 400, true); timer.tick(300);
    gesture.release(2); click(); timer.tick(1000);
    assert.deepEqual(calls, ['execute']);
    assert.equal(timer.pending(), 0);
});

test('three independent circles share the trigger centre, preserve order and never overlap', () => {
    const center = { x: 26, y: 724 };
    const geometry = minimalFanGeometry(center.x, center.y, 1200, 768);
    assert.equal(geometry.left + 22, center.x);
    assert.equal(geometry.top + geometry.radius + 22, center.y);
    assert.equal(geometry.radius, 76);
    assert.deepEqual(geometry.items.map(s => s.action), MINIMAL_ACTIONS);
    assert.deepEqual(geometry.items.map(s => s.action), ['build', 'flash', 'build-flash']);
    for (const item of geometry.items) {
        assert.ok(item.left >= 0 && item.left + 44 <= geometry.size);
        assert.ok(item.top >= 0 && item.top + 44 <= geometry.size);
        assert.ok(geometry.left + item.left >= 4);
        assert.ok(geometry.top + item.top >= 4);
        assert.ok(geometry.top + item.top + 44 <= center.y + 22);
        assert.ok(Math.abs(Math.hypot(item.left, item.top - geometry.radius) - geometry.radius) < .001);
        assert.ok(Math.hypot(item.left, item.top - geometry.radius) > 44);
    }
    for (let index = 1; index < geometry.items.length; index++) {
        const a = geometry.items[index - 1], b = geometry.items[index];
        assert.ok(Math.hypot(a.left - b.left, a.top - b.top) > 48);
    }
    const subpixel = minimalFanGeometry(25.5, center.y, 1200, 768);
    assert.ok(subpixel);
    assert.equal(subpixel.left, 3.5);
    assert.equal(subpixel.left + 22, 25.5);
    for (const item of subpixel.items) {
        assert.ok(subpixel.left + item.left >= 0);
        assert.ok(subpixel.left + item.left + 44 <= 1200);
    }
});

test('small viewports shrink the arc radius while preserving 44px targets and viewport bounds', () => {
    const small = minimalFanGeometry(26, 94, 200, 140);
    assert.equal(small.radius, 68);
    assert.equal(small.left, 4);
    assert.equal(small.top, 4);
    assert.ok(small.left + small.size <= 196);
    assert.ok(small.top + small.size <= 136);
    for (let index = 1; index < small.items.length; index++) {
        const a = small.items[index - 1], b = small.items[index];
        assert.ok(Math.hypot(a.left - b.left, a.top - b.top) > 48);
    }
    assert.equal(minimalFanGeometry(26, 80, 200, 140), undefined);
    assert.equal(minimalFanGeometry(100, 700, 180, 768), undefined);
    assert.equal(minimalFanGeometry(20, 700, 1200, 768), undefined);
    assert.equal(minimalFanGeometry(26, 800, 1200, 768), undefined);
    assert.equal(minimalFanGeometry(NaN, 700, 1200, 768), undefined);
});

test('production resize handler restores an open fan focus to its available trigger', () => {
    const mounted = mountedFanEvents();
    try {
        mounted.focusMenu(); mounted.emit('resize');
        assert.equal(mounted.changes.at(-1), undefined);
        assert.equal(mounted.focused.length, 1);
        assert.equal(mounted.focused[0].preventScroll, true);
    } finally { mounted.dispose(); }
});

test('production blur, hidden window, outside focus and disabled trigger never steal focus', () => {
    for (const kind of ['blur', 'hidden', 'outside', 'disabled']) {
        const mounted = mountedFanEvents();
        try {
            mounted.focusMenu();
            if (kind === 'outside') { mounted.focusOutside(); }
            if (kind === 'disabled') { mounted.trigger.disabled = true; }
            if (kind === 'hidden') { mounted.hide(); }
            else { mounted.emit(kind === 'blur' ? 'blur' : 'resize'); }
            assert.equal(mounted.changes.at(-1), undefined);
            assert.equal(mounted.focused.length, 0, kind);
        } finally { mounted.dispose(); }
    }
});

test('each production circle selects only its mode and the next rendered primary reflects the new icon and color', () => {
    for (const [index, action] of MINIMAL_ACTIONS.entries()) {
        const selected = [], executed = [];
        const mounted = mountedFanEvents({ action: 'build-flash', onSelect: value => selected.push(value), onExecute: () => executed.push('old') });
        try {
            mounted.choose(index);
            assert.deepEqual(selected, [action]);
            assert.deepEqual(executed, []);
            assert.equal(mounted.changes.at(-1), undefined);
            assert.equal(mounted.focused.length, 1);
        } finally { mounted.dispose(); }
        const updated = mountedFanEvents({ action, onExecute: () => executed.push(action) });
        try {
            assert.equal(updated.button.props['data-action'], action === 'build-flash' ? 'run' : action);
            assert.equal(updated.button.props.children[0].props.action, action);
            updated.closeByEscape();
            updated.clickPrimary();
            assert.deepEqual(executed, [action]);
        } finally { updated.dispose(); }
    }
});

test('a captured production circle callback cannot change modes after busy, disabled or scope changes', () => {
    for (const blocked of [{ busy: true }, { disabled: true }, { allowSelection: false }, { scopeKey: 'next-project' }]) {
        const selected = [];
        const props = { action: 'build', onSelect: value => selected.push(value) };
        const mounted = mountedFanEvents(props);
        try {
            mounted.updateLiveProps(blocked);
            mounted.choose(1);
            assert.deepEqual(selected, []);
            assert.equal(mounted.changes.at(-1), undefined);
        } finally { mounted.dispose(); }
    }
});

test('real React markup exposes only the contextual icon button and keeps busy cancellation enabled', () => {
    const React = require('@theia/core/shared/react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const previous = require.extensions['.css'];
    require.extensions['.css'] = () => {};
    let NoduMinimalAction;
    try { ({ NoduMinimalAction } = require('../lib/browser/nodu-minimal-action')); }
    finally { if (previous) { require.extensions['.css'] = previous; } else { delete require.extensions['.css']; } }
    const base = { action: 'build-flash', scopeKey: 'test-project', busy: false, allowSelection: true,
        onSelect() {}, onExecute() {}, onStop() {} };
    const stm32 = renderToStaticMarkup(React.createElement(NoduMinimalAction, base));
    assert.match(stm32, /aria-haspopup="menu"/);
    assert.match(stm32, /aria-label="运行（编译并烧录）/);
    assert.match(stm32, /<svg/);
    assert.doesNotMatch(stm32, /nodu-minimal-raster-icon|<img/);
    assert.doesNotMatch(stm32, />编译|>运行|>烧写|下载帮助/);
    const k210 = renderToStaticMarkup(React.createElement(NoduMinimalAction, { ...base, allowSelection: false }));
    assert.doesNotMatch(k210, /aria-haspopup|Shift\+F10/);
    assert.match(k210, /aria-label="运行当前代码"/);
    assert.doesNotMatch(k210, /nodu-minimal-raster-icon/);
    const arduino = renderToStaticMarkup(React.createElement(NoduMinimalAction, { ...base, action: 'build', allowSelection: false, fixedAction: true }));
    assert.match(arduino, /aria-label="编译"/);
    assert.match(arduino, /data-action="build"/);
    assert.doesNotMatch(arduino, /aria-haspopup|运行当前代码|长按/);
    const stop = renderToStaticMarkup(React.createElement(NoduMinimalAction, { ...base, busy: true, disabled: true, stopLabel: '取消下载' }));
    assert.match(stop, /aria-label="取消下载"/);
    assert.doesNotMatch(stop, /disabled=""/);
    const unavailableStop = renderToStaticMarkup(React.createElement(NoduMinimalAction, { ...base, busy: true, stopDisabled: true }));
    assert.match(unavailableStop, /disabled=""/);
    assert.match(unavailableStop, /aria-label="操作进行中"/);
});
