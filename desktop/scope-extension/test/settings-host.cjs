// SPDX-License-Identifier: MIT
// Run the production portal and layout hook; Electron covers actual dock geometry.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function setup(initialBars = []) {
    let bars = initialBars, cleanup, nextFrame = 0;
    const frames = new Map(), listeners = new Set(), observers = [];
    const view = {
        requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); }
    };
    const panel = {
        node: { ownerDocument: { defaultView: view }, getBoundingClientRect: () => ({ top: 36, right: 1000 }) },
        tabBars: () => bars.map(node => ({ node })),
        layoutModified: { connect: callback => listeners.add(callback), disconnect: callback => listeners.delete(callback) }
    };
    const React = { __esModule: true,
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useLayoutEffect(callback) { cleanup = callback(); }
    };
    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/browser/nodu-minimal-settings-host.js'), 'utf8'), {
        exports, require: name => name === '@theia/core/shared/react' ? React : { createPortal: (content, target) => ({ content, target }) },
        ResizeObserver: class {
            nodes = new Set();
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe(node) { this.nodes.add(node); }
            disconnect() { this.nodes.clear(); this.disconnected = true; }
        }
    });
    const child = { setting: 'singleton' };
    const portal = exports.NoduMinimalSettingsHost({ panel, children: child });
    return { panel, child, portal, frames, listeners, observers,
        layout(nextBars = bars) { bars = nextBars; listeners.forEach(callback => callback()); },
        flush() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
        unmount() { cleanup(); }
    };
}
function bar(left, top, width, height = 30) {
    const classes = new Set();
    return { classes, classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
        getBoundingClientRect: () => ({ left, right: left + width, top, width, height }) };
}
const reserved = node => node.classes.has('nodu-minimal-settings-tabbar');

test('split editors reserve only the top-right visible tab bar and share one settings portal', () => {
    const left = bar(50, 36, 400), right = bar(450, 36, 550), below = bar(50, 400, 950), hidden = bar(1000, 36, 0);
    const c = setup([below, right, hidden, left]);
    assert.equal(c.portal.target, c.panel.node);
    assert.equal(c.portal.content.props.children.length, 1); assert.equal(c.portal.content.props.children[0], c.child);
    assert.deepEqual([left, right, below, hidden].map(reserved), [false, true, false, false]);
    c.unmount();
});

test('layout changes move the reserved space and an empty editor area keeps the settings entry', () => {
    const left = bar(50, 36, 400), right = bar(450, 36, 550), c = setup([left, right]);
    c.layout([left]); c.flush(); assert.equal(reserved(right), false); assert.equal(reserved(left), true);
    c.layout([]); c.flush(); assert.equal(reserved(left), false);
    assert.equal(c.portal.target, c.panel.node); assert.equal(c.portal.content.props.children[0], c.child);
    const reopened = bar(50, 36, 950); c.layout([reopened]); c.flush(); assert.equal(reserved(reopened), true);
    c.unmount(); assert.equal(reserved(reopened), false);
});

test('repeated geometry notifications are coalesced and disposal cancels pending work and restores tab space', () => {
    const tab = bar(50, 36, 950), c = setup([tab]), observer = c.observers[0];
    assert.ok(observer.nodes.has(c.panel.node)); assert.equal(c.listeners.size, 1);
    c.layout(); c.layout(); observer.callback(); assert.equal(c.frames.size, 1);
    c.unmount();
    assert.equal(c.frames.size, 0); assert.equal(c.listeners.size, 0); assert.equal(observer.disconnected, true);
    assert.equal(reserved(tab), false); c.flush(); assert.equal(reserved(tab), false);
});
