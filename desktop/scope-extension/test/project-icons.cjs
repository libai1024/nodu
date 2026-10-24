// SPDX-License-Identifier: MIT
// Run after compile: node --test test/project-icons.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { projectIconIdentity } = require('../lib/common/nodu-project-icon');
const { PROJECT_CHIPS } = require('../lib/common/nodu-project-catalog');
const { projectTag } = require('../lib/common/nodu-launcher-util');
const { NoduProjectsServer } = require('../lib/node/nodu-projects-server');

test('every selectable chip has a vendor and a readable short model label', () => {
    for (const chip of PROJECT_CHIPS) {
        const icon = projectIconIdentity(projectTag({ nodu: { target: { mcu: chip.id } } }));
        assert.notEqual(icon.vendor, 'unknown', chip.id);
        assert.ok(icon.model && icon.model.length <= 5, chip.id);
    }
    assert.equal(projectIconIdentity('STM32F103C8Tx').model, 'F103');
    assert.equal(projectIconIdentity('STM32F407ZGTx').model, 'F407');
    assert.equal(projectIconIdentity(' esp32-s3 ').model, 'S3');
    assert.equal(projectIconIdentity('esp32c3').model, 'C3');
    assert.equal(projectIconIdentity().vendor, 'unknown');
    assert.equal(projectIconIdentity('ESP32-UNKNOWN').vendor, 'unknown');
});

test('missing folders retain their last known chip across backend restarts', async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nodu-project-icons-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await fs.mkdir(project);
    await fs.writeFile(join(project, 'nodu.json'), JSON.stringify({ target: { mcu: 'esp32s3' } }));
    const createServer = () => {
        const server = new NoduProjectsServer();
        server.env = { getConfigDirUri: async () => pathToFileURL(root).href };
        server.workspaces = { getRecentWorkspaces: async () => [] };
        return server;
    };
    // Existing history predates saved chip tags. Listing hydrates it without changing order/time.
    await fs.writeFile(join(root, 'nodu-recent-projects.json'), JSON.stringify({ projects: [{ path: project, lastOpened: 123 }] }));
    const server = createServer();
    assert.equal((await server.recent())[0].tag, 'ESP32-S3');
    await fs.rename(project, `${project}-moved`);
    const missing = (await createServer().recent())[0];
    assert.equal(missing.missing, true);
    assert.equal(missing.tag, 'ESP32-S3');
    assert.equal(missing.lastOpened, 123);
    await fs.rename(`${project}-moved`, project);
    await fs.writeFile(join(project, 'nodu.json'), JSON.stringify({ target: { mcu: 'STM32F407ZGTx' } }));
    await server.touch(project);
    await fs.rename(project, `${project}-moved`);
    assert.equal((await createServer().recent())[0].tag, 'STM32F407');
    // A restored ordinary folder must not inherit an obsolete chip identity.
    await fs.mkdir(project);
    assert.equal((await server.recent())[0].tag, undefined);
    await fs.rmdir(project);
    assert.equal((await createServer().recent())[0].tag, undefined);
});

test('unreadable, malformed and missing manifests preserve cached identity until an ordinary folder is confirmed', async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nodu-project-icon-errors-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = join(root, 'project'), file = join(project, 'nodu.json');
    await fs.mkdir(project);
    const server = new NoduProjectsServer();
    server.env = { getConfigDirUri: async () => pathToFileURL(root).href };
    server.workspaces = { getRecentWorkspaces: async () => [] };
    await fs.writeFile(file, JSON.stringify({ target: { mcu: 'STM32F103C8T6' } }));
    await server.touch(project);
    for (const content of ['{broken', ' '.repeat(256 * 1024 + 1)]) {
        await fs.writeFile(file, content); await server.touch(project);
        assert.equal((await server.recent())[0].tag, 'STM32F103');
    }
    await fs.unlink(file); await fs.mkdir(file);
    assert.equal((await server.recent())[0].tag, 'STM32F103');
    await fs.rmdir(file);
    const outside = join(root, 'outside.json');
    await fs.writeFile(outside, JSON.stringify({ target: { mcu: 'STM32F407ZGTx' } }));
    await fs.symlink(outside, file);
    assert.equal((await server.recent())[0].tag, 'STM32F103', 'never follow a manifest symlink');
    await fs.unlink(file); await fs.rename(project, `${project}-moved`);
    await server.touch(project);
    assert.equal((await server.recent())[0].tag, 'STM32F103', 'touching a missing project retains its identity');
    await fs.mkdir(project);
    assert.equal((await server.recent())[0].tag, undefined, 'confirmed ordinary directory clears obsolete identity');
});

test('optional identity-cache writes cannot prevent recent projects from rendering', async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nodu-project-icon-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = join(root, 'project'); await fs.mkdir(project);
    await fs.writeFile(join(project, 'nodu.json'), JSON.stringify({ target: { mcu: 'STM32F103C8T6' } }));
    await fs.writeFile(join(root, 'nodu-recent-projects.json'), JSON.stringify({ projects: [{ path: project, lastOpened: 5 }] }));
    const server = new NoduProjectsServer();
    server.env = { getConfigDirUri: async () => pathToFileURL(root).href };
    server.workspaces = { getRecentWorkspaces: async () => [] };
    server.update = async () => { throw new Error('Read-only profile'); };
    const rows = await server.recent();
    assert.equal(rows.length, 1); assert.equal(rows[0].tag, 'STM32F103'); assert.equal(rows[0].lastOpened, 5);
});

test('late identity hydration cannot replace a newer touch from another window', async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nodu-project-icon-race-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = join(root, 'project'), store = join(root, 'nodu-recent-projects.json'); await fs.mkdir(project);
    await fs.writeFile(join(project, 'nodu.json'), JSON.stringify({ target: { mcu: 'STM32F103C8T6' } }));
    await fs.writeFile(store, JSON.stringify({ projects: [{ path: project, lastOpened: 5 }] }));
    const server = new NoduProjectsServer();
    server.env = { getConfigDirUri: async () => pathToFileURL(root).href };
    server.workspaces = { getRecentWorkspaces: async () => [] };
    const update = server.update.bind(server);
    server.update = async change => {
        await fs.writeFile(store, JSON.stringify({ projects: [{ path: project, lastOpened: 6, tag: 'K210' }] }));
        return update(change);
    };
    await server.recent();
    const saved = JSON.parse(await fs.readFile(store, 'utf8')).projects[0];
    assert.equal(saved.tag, 'K210'); assert.equal(saved.lastOpened, 6);
});


test('valid nodu identity supersedes a malformed legacy board manifest and persists across restart', async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'nodu-project-icon-priority-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const project = join(root, 'project'); await fs.mkdir(project);
    const createServer = () => {
        const server = new NoduProjectsServer();
        server.env = { getConfigDirUri: async () => pathToFileURL(root).href };
        server.workspaces = { getRecentWorkspaces: async () => [] };
        return server;
    };
    const nodu = join(project, 'nodu.json'), board = join(project, 'board.json');
    await fs.writeFile(nodu, JSON.stringify({ kind: 'stm32-hal', target: { mcu: 'STM32F103C8T6' } }));
    const server = createServer(); await server.touch(project);
    await fs.writeFile(nodu, JSON.stringify({ kind: 'stm32-hal', target: { mcu: 'STM32F407ZGTx' } }));
    await fs.writeFile(board, '{malformed legacy');
    assert.equal((await server.recent())[0].tag, 'STM32F407');
    await fs.rename(project, `${project}-moved`);
    assert.equal((await createServer().recent())[0].tag, 'STM32F407');
    await fs.rename(`${project}-moved`, project);
    await fs.writeFile(nodu, JSON.stringify({ kind: 'k210-maixpy' }));
    await server.touch(project);
    await fs.rename(project, `${project}-moved`);
    assert.equal((await createServer().recent())[0].tag, 'K210');
    await fs.mkdir(project);
    assert.equal((await server.recent())[0].tag, undefined);
    await fs.rmdir(project);
    assert.equal((await createServer().recent())[0].tag, undefined);
});
