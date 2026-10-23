// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, basename } = require('node:path');
const { createHash } = require('node:crypto');
const { TutorCourseRepository } = require('../lib/node/tutor/tutor-course-repository');
const { canonicalCourseContent } = require('../lib/common/tutor/tutor-course');
const target = { mcu: 'STM32F103C8T6', sdkId: 'test-sdk', sdkDigest: 'a'.repeat(64) };
const digest = source => createHash('sha256').update(source).digest('hex');
const legacy = () => ({ schema: 1, id: 'lesson', version: 1, title: '串口', goal: '输出', board: 'legacy-board', sdk: 'legacy-sdk', source: 'course', rules: [], steps: [
    { id: 'S1', kind: 'implement', title: '初始化', goal: '初始化串口', why: '发送数据', dependsOn: [], anchor: { file: 'src/main.c' },
        hints: { intent: '初始化', api: 'init', skeleton: 'void init(void)', reference: 'void init(void) {}' }, contract: [{ type: 'compiles', text: '编译通过' }] },
] });
async function fixture(t, value = legacy()) {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nodu-course-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = join(root, '.nodu-tutor');
    await fs.mkdir(directory);
    const path = join(directory, 'plan.json');
    const source = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n';
    await fs.writeFile(path, source);
    return { root, directory, path, source, repo: new TutorCourseRepository(root) };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('preview is read-only; accepted course and exact backup are independent from source files', async t => {
    const f = await fixture(t);
    await fs.mkdir(join(f.root, 'src'));
    await fs.writeFile(join(f.root, 'src/main.c'), 'int main(void) {}\n');
    const preview = await f.repo.previewMigration(target);
    assert.equal(await fs.readFile(f.path, 'utf8'), f.source);
    assert.deepEqual(await fs.readdir(f.directory), ['plan.json']);
    assert.deepEqual(preview.course.target, target);
    assert.equal(preview.course.steps[0].requirements[0].type, 'manual');
    assert.equal(preview.course.contentHash, digest(canonicalCourseContent(preview.course)));
    preview.course.title = 'tampered public result';
    const accepted = await f.repo.acceptMigration(preview.id, preview.sourceDigest);
    assert.equal(accepted.kind, 'course');
    assert.equal(accepted.course.title, '串口');
    assert.equal(await fs.readFile(join(f.directory, 'backups', `schema1-${preview.sourceDigest}.json`), 'utf8'), f.source);
    assert.equal(await fs.readFile(join(f.root, 'src/main.c'), 'utf8'), 'int main(void) {}\n');
    assert.deepEqual(await f.repo.read(), accepted);
    await rejects(f.repo.acceptMigration(preview.id, preview.sourceDigest), 'revisionConflict');
});

test('changed source and mismatched preview identity never overwrite the current plan', async t => {
    const f = await fixture(t);
    const preview = await f.repo.previewMigration(target);
    await rejects(f.repo.acceptMigration('other', preview.sourceDigest), 'revisionConflict');
    await rejects(f.repo.acceptMigration(preview.id, 'b'.repeat(64)), 'revisionConflict');
    const changed = f.source.replace('串口', '用户新修改');
    await fs.writeFile(f.path, changed);
    await rejects(f.repo.acceptMigration(preview.id, preview.sourceDigest), 'revisionConflict');
    assert.equal(await fs.readFile(f.path, 'utf8'), changed);
});

test('two windows accept the same source once', async t => {
    const f = await fixture(t);
    const other = new TutorCourseRepository(f.root);
    const [a, b] = await Promise.all([f.repo.previewMigration(target), other.previewMigration(target)]);
    const results = await Promise.allSettled([f.repo.acceptMigration(a.id, a.sourceDigest), other.acceptMigration(b.id, b.sourceDigest)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'revisionConflict');
    assert.equal((await f.repo.read()).kind, 'course');
});

test('malformed JSON, invalid UTF-8 and oversized files are rejected', async t => {
    for (const value of ['{', Buffer.from([0x7b, 0xff, 0x7d]), ' '.repeat(512 * 1024 + 1)]) {
        const f = await fixture(t, value);
        await rejects(f.repo.read(), 'invalidSchema');
        assert.deepEqual(await fs.readFile(f.path), Buffer.from(value));
    }
});

test('schema2 content hash is verified against file contents', async t => {
    const f = await fixture(t);
    const preview = await f.repo.previewMigration(target);
    await fs.writeFile(f.path, JSON.stringify(preview.course));
    assert.equal((await f.repo.read()).kind, 'course');
    preview.course.title = 'modified without hash';
    await fs.writeFile(f.path, JSON.stringify(preview.course));
    await rejects(f.repo.read(), 'invalidSchema');
});

test('migration size limit includes final whitespace', async t => {
    const plan = legacy();
    plan.steps = Array.from({ length: 61 }, (_, i) => ({ ...plan.steps[0], id: `S${i}`, hints: {
        intent: 'i', api: 'a', skeleton: 's'.repeat(4000), reference: 'r'.repeat(4000),
    } }));
    const f = await fixture(t, JSON.stringify(plan));
    assert.ok(Buffer.byteLength(f.source) < 512 * 1024);
    await rejects(f.repo.previewMigration(target), 'invalidSchema');
    assert.equal(await fs.readFile(f.path, 'utf8'), f.source);
    assert.deepEqual(await fs.readdir(f.directory), ['plan.json']);
});

test('symlink plan and backup directories cannot redirect migration', async t => {
    const f = await fixture(t);
    const outside = join(f.root, 'outside.json');
    await fs.writeFile(outside, f.source);
    await fs.unlink(f.path);
    await fs.symlink(outside, f.path);
    await rejects(f.repo.read(), 'outOfScope');
    await fs.unlink(f.path);
    await fs.writeFile(f.path, f.source);
    const preview = await f.repo.previewMigration(target);
    const outsideDir = join(f.root, 'outside');
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, join(f.directory, 'backups'));
    await rejects(f.repo.acceptMigration(preview.id, preview.sourceDigest), 'outOfScope');
    assert.deepEqual(await fs.readdir(outsideDir), []);
    assert.equal(await fs.readFile(outside, 'utf8'), f.source);
    assert.equal(await fs.readFile(f.path, 'utf8'), f.source);
});

test('an inconsistent existing backup is never overwritten', async t => {
    const f = await fixture(t);
    const preview = await f.repo.previewMigration(target);
    const backups = join(f.directory, 'backups');
    await fs.mkdir(backups);
    const path = join(backups, `schema1-${preview.sourceDigest}.json`);
    await fs.writeFile(path, 'partial old backup');
    await rejects(f.repo.acceptMigration(preview.id, preview.sourceDigest), 'storageUnavailable');
    assert.equal(await fs.readFile(path, 'utf8'), 'partial old backup');
    assert.equal(await fs.readFile(f.path, 'utf8'), f.source);
    assert.deepEqual(await fs.readdir(backups), [basename(path)]);
});

test('interrupted backup writes leave the old plan and permit retry', async t => {
    const f = await fixture(t);
    const preview = await f.repo.previewMigration(target);
    const realWrite = f.repo.writeNew.bind(f.repo);
    f.repo.writeNew = async (path, source) => {
        if (basename(path).startsWith('.backup-')) { await fs.writeFile(path, source.slice(0, 10)); throw new Error('injected disk failure'); }
        return realWrite(path, source);
    };
    await rejects(f.repo.acceptMigration(preview.id, preview.sourceDigest), 'storageUnavailable');
    assert.equal(await fs.readFile(f.path, 'utf8'), f.source);
    assert.deepEqual(await fs.readdir(join(f.directory, 'backups')), []);
    f.repo.writeNew = realWrite;
    assert.equal((await f.repo.acceptMigration(preview.id, preview.sourceDigest)).kind, 'course');
});

test('backup publication is flushed before the active plan is moved', async t => {
    const f = await fixture(t);
    const preview = await f.repo.previewMigration(target);
    const events = [];
    const realFlush = f.repo.flushDirectory.bind(f.repo);
    f.repo.flushDirectory = async path => { events.push({ path, source: await fs.readFile(f.path, 'utf8').catch(() => undefined) }); return realFlush(path); };
    await f.repo.acceptMigration(preview.id, preview.sourceDigest);
    assert.equal(events[0].path, join(f.directory, 'backups'));
    assert.equal(events[1].path, f.directory);
    assert.equal(events[1].source, f.source);
});

test('a late external save in the read-to-move gap is restored and preserved', async t => {
    const f = await fixture(t);
    const preview = await f.repo.previewMigration(target);
    const changed = f.source.replace('串口', '最后一刻保存');
    const realRead = f.repo.readSource.bind(f.repo);
    let reads = 0;
    f.repo.readSource = async () => {
        const source = await realRead();
        if (++reads === 2) { await fs.writeFile(f.path, changed); }
        return source;
    };
    await rejects(f.repo.acceptMigration(preview.id, preview.sourceDigest), 'revisionConflict');
    assert.equal(await fs.readFile(f.path, 'utf8'), changed);
    const recoveries = (await fs.readdir(join(f.directory, 'backups'))).filter(name => name.startsWith('recovery-'));
    assert.equal(recoveries.length, 1);
    assert.equal(await fs.readFile(join(f.directory, 'backups', recoveries[0]), 'utf8'), changed);
});

test('external recreation after source move is not overwritten by publication', async t => {
    const f = await fixture(t);
    const preview = await f.repo.previewMigration(target);
    const changed = f.source.replace('串口', '移动后保存');
    const realRead = f.repo.readFile.bind(f.repo);
    f.repo.readFile = async path => {
        const source = await realRead(path);
        if (basename(path).startsWith('recovery-')) { await fs.writeFile(f.path, changed); }
        return source;
    };
    await rejects(f.repo.acceptMigration(preview.id, preview.sourceDigest), 'revisionConflict');
    assert.equal(await fs.readFile(f.path, 'utf8'), changed);
    assert.ok(!(await fs.readdir(f.directory)).some(name => name.endsWith('.tmp')));
});

test('an editor holding the old file open writes to recovery, not the new course or immutable backup', async t => {
    const f = await fixture(t);
    const preview = await f.repo.previewMigration(target);
    const handle = await fs.open(f.path, 'r+');
    try {
        await f.repo.acceptMigration(preview.id, preview.sourceDigest);
        const changed = f.source.replace('串口', '旧句柄保存');
        await handle.truncate(0);
        await handle.writeFile(changed, 'utf8');
        await handle.sync();
        assert.equal((await f.repo.read()).kind, 'course');
        const backups = join(f.directory, 'backups');
        const recovery = (await fs.readdir(backups)).find(name => name.startsWith('recovery-'));
        assert.equal(await fs.readFile(join(backups, recovery), 'utf8'), changed);
        assert.equal(await fs.readFile(join(backups, `schema1-${preview.sourceDigest}.json`), 'utf8'), f.source);
    } finally { await handle.close(); }
});
