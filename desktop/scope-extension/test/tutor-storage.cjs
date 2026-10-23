// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { TutorCourseRepository } = require('../lib/node/tutor/tutor-course-repository');
const { TutorProgressStore } = require('../lib/node/tutor/tutor-progress-store');
const { TutorStorageServer } = require('../lib/node/tutor/tutor-storage-server');
const { canonicalCourseContent, migrateLegacyCourse } = require('../lib/common/tutor/tutor-course');
const { emptyLearningProgress, applyLearningAction, validateLearningProgress } = require('../lib/common/tutor/tutor-learning-state');
const digest = text => createHash('sha256').update(text).digest('hex');
const target = { mcu: 'STM32F103C8T6', sdkId: 'fixture', sdkDigest: 'a'.repeat(64) };
const legacy = () => ({ schema: 1, id: 'lesson', version: 1, title: '串口', goal: '输出', board: 'old', sdk: 'old', source: 'course', rules: [], steps: [
    ...['A', 'B'].map((id, i) => ({ id, kind: 'implement', title: id, goal: '目标', why: '原因', dependsOn: i ? ['A'] : [], anchor: { file: 'main.c' },
        hints: { intent: '初始化', api: 'init', skeleton: 'void init(void)', reference: 'void init(void) {}' }, contract: [{ type: 'compiles', text: '编译通过' }] })),
    { id: 'D', kind: 'decide', title: '方案', goal: '目标', why: '原因', dependsOn: [], options: [{ id: 'poll', label: '轮询', available: true }] },
] });
const course = () => {
    const result = migrateLegacyCourse(legacy(), target);
    assert.ok(result.draft, result.errors.join());
    return { ...result.draft, contentHash: digest(canonicalCourseContent(result.draft)) };
};
async function fixture(t, schema = 2) {
    const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nodu-tutor-storage-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const root = join(base, 'project');
    const data = join(base, 'app-data');
    await fs.mkdir(join(root, '.nodu-tutor'), { recursive: true });
    const planPath = join(root, '.nodu-tutor', 'plan.json');
    const plan = schema === 1 ? legacy() : course();
    const source = JSON.stringify(plan, null, 2) + '\n';
    await fs.writeFile(planPath, source);
    const key = await TutorProgressStore.projectKey(root);
    return { root, base, data, key, path: planPath, source, course: plan, store: new TutorProgressStore(data), repository: new TutorCourseRepository(root) };
}
const rejects = (promise, expected) => assert.rejects(promise, error => error.code === expected);
const action = (type, stepId = 'A', extra = {}) => ({ kind: 'action', action: { type, stepId, ...extra } });
const ok = outcome => { assert.equal(outcome.ok, true, JSON.stringify(outcome)); return outcome.value; };

for (const stage of ['journal', 'moved', 'published']) {
    test(`process exit after ${stage} recovers without losing original bytes`, async t => {
        const f = await fixture(t, 1);
        const script = `
          const fs = require('node:fs/promises');
          const {join} = require('node:path');
          const {TutorCourseRepository} = require(${JSON.stringify(resolve(__dirname, '../lib/node/tutor/tutor-course-repository'))});
          (async()=>{
            const repo = new TutorCourseRepository(${JSON.stringify(f.root)});
            const preview = await repo.previewMigration(${JSON.stringify(target)});
            const flush = repo.flushDirectory.bind(repo);
            repo.flushDirectory = async path => {
              await flush(path);
              const dir = join(${JSON.stringify(f.root)},'.nodu-tutor');
              if (!await fs.stat(join(dir,'.migration.json')).catch(()=>undefined)) return;
              const plan = await fs.readFile(join(dir,'plan.json'),'utf8').then(JSON.parse).catch(()=>undefined);
              if ((${JSON.stringify(stage)}==='journal' && plan?.schema===1)
                || (${JSON.stringify(stage)}==='moved' && !plan)
                || (${JSON.stringify(stage)}==='published' && plan?.schema===2)) process.exit(73);
            };
            await repo.acceptMigration(preview.id,preview.sourceDigest);
            process.exit(99);
          })().catch(e=>{console.error(e);process.exit(1)});`;
        const child = spawnSync(process.execPath, ['-e', script], { timeout: 15000, encoding: 'utf8' });
        assert.equal(child.status, 73, child.stderr);
        const loaded = await new TutorCourseRepository(f.root).read();
        assert.equal(loaded.kind, stage === 'published' ? 'course' : 'legacy');
        const original = await fs.readFile(join(f.root, '.nodu-tutor/backups', `schema1-${digest(f.source)}.json`), 'utf8');
        assert.equal(original, f.source);
        await assert.rejects(fs.stat(join(f.root, '.nodu-tutor/.migration.json')), { code: 'ENOENT' });
        assert.deepEqual(await new TutorCourseRepository(f.root).read(), loaded);
    });
}

test('recovery preserves a newer destination and rejects invalid journal paths', async t => {
    const f = await fixture(t, 1);
    const id = randomUUID();
    const directory = join(f.root, '.nodu-tutor');
    const journal = { schema: 1, id, pid: process.pid, originalDigest: digest(f.source), candidateDigest: 'b'.repeat(64) };
    await fs.writeFile(join(directory, '.migration.json'), JSON.stringify(journal));
    const changed = f.source.replace('串口', '后来的修改');
    await fs.writeFile(f.path, changed);
    assert.equal((await f.repository.read()).plan.title, '后来的修改');
    assert.equal(await fs.readFile(f.path, 'utf8'), changed);
    await fs.writeFile(join(directory, '.migration.json'), JSON.stringify({ ...journal, id: '../elsewhere' }));
    await rejects(f.repository.read(), 'storageUnavailable');
    assert.equal(await fs.readFile(f.path, 'utf8'), changed);
});

test('incomplete recovery is not presented as an ordinary project without a course', async t => {
    const f = await fixture(t, 1);
    await fs.writeFile(join(f.root, '.nodu-tutor/.migration.json'), JSON.stringify({ schema: 1, id: randomUUID(), pid: process.pid, originalDigest: digest(f.source), candidateDigest: 'b'.repeat(64) }));
    await fs.unlink(f.path);
    await rejects(f.repository.read(), 'storageUnavailable');
});

test('manual progress uses required dependencies, preserves references and never verifies code', () => {
    const c = course();
    let p = emptyLearningProgress();
    assert.throws(() => applyLearningAction(c, p, { type: 'manualCheck', stepId: 'B' }, 1), /前置/);
    p = applyLearningAction(c, p, { type: 'manualCheck', stepId: 'A' }, 2);
    p = applyLearningAction(c, p, { type: 'manualCheck', stepId: 'B' }, 3);
    p = applyLearningAction(c, p, { type: 'viewReference', stepId: 'A' }, 4);
    assert.equal(p.steps.A.status, 'self-checked');
    assert.equal(p.levels.A, 3);
    assert.deepEqual(p.references, ['A']);
    p = applyLearningAction(c, p, { type: 'reopen', stepId: 'A' }, 5);
    assert.deepEqual(p.steps, {});
    assert.deepEqual(p.completionOrder, []);
    assert.throws(() => applyLearningAction(c, p, { type: 'setHint', stepId: 'A', level: 3 }, 6), /级别/);
    assert.throws(() => applyLearningAction(c, p, { type: 'manualCheck', stepId: 'D' }, 7), /方案/);
    p = applyLearningAction(c, p, { type: 'decide', stepId: 'D', optionId: 'poll' }, 8);
    assert.equal(p.decisions.D, 'poll');
    assert.equal(p.steps.D.status, 'self-checked');
    const forged = structuredClone(p); forged.steps.D.status = 'verified';
    assert.throws(() => validateLearningProgress(forged, c), /状态/);
    assert.throws(() => applyLearningAction(c, p, { type: 'constructor' }, 9), /操作/);
    assert.throws(() => applyLearningAction(c, p, { type: 'reset', command: 'shell' }, 9), /操作/);
});

test('progress survives a new store instance and stays outside the project', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    const saved = await f.store.apply(f.key, f.course, start.sequence, start.planHash, 'request-0001', action('manualCheck'));
    const next = await new TutorProgressStore(f.data).getSnapshot(f.key, f.course, start.sequence);
    assert.deepEqual(next.snapshot, saved);
    assert.equal(next.events.length, 1);
    assert.equal(next.events[0].kind, 'action');
    assert.equal(saved.progress.steps.A.status, 'self-checked');
    assert.deepEqual(await fs.readdir(join(f.root, '.nodu-tutor')), ['plan.json']);
    assert.equal(await fs.readFile(f.path, 'utf8'), f.source);
});

test('two stores serialize the same local project and reject stale writes', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    const other = new TutorProgressStore(f.data);
    const results = await Promise.allSettled([
        f.store.apply(f.key, f.course, start.sequence, start.planHash, 'window-a-001', action('manualCheck')),
        other.apply(f.key, f.course, start.sequence, start.planHash, 'window-b-001', action('select')),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'revisionConflict');
    assert.equal((await f.store.getSnapshot(f.key, f.course)).snapshot.sequence, start.sequence + 1);
});

test('retries are idempotent and changed request bodies are refused', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    const saved = await f.store.apply(f.key, f.course, start.sequence, start.planHash, 'retry-000001', action('manualCheck'));
    const again = await new TutorProgressStore(f.data).apply(f.key, f.course, start.sequence, start.planHash, 'retry-000001', action('manualCheck'));
    assert.deepEqual(again, saved);
    await rejects(f.store.apply(f.key, f.course, start.sequence, start.planHash, 'retry-000001', action('select')), 'revisionConflict');
    assert.equal(saved.progress.log.length, 1);
});

test('a partial log tail is discarded, recorded and checkpointed; full corrupt rows are not skipped', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    const saved = await f.store.apply(f.key, f.course, start.sequence, start.planHash, 'tail-0000001', action('manualCheck'));
    const log = join(f.data, f.key, 'events.jsonl');
    await fs.appendFile(log, '{"schema":1,"sequence":');
    const recovered = await new TutorProgressStore(f.data).getSnapshot(f.key, f.course, saved.sequence);
    assert.deepEqual(recovered.snapshot.progress, saved.progress);
    assert.equal(recovered.snapshot.sequence, saved.sequence + 1);
    assert.equal(recovered.events[0].kind, 'recovered');
    assert.equal((await fs.readFile(log, 'utf8')).endsWith('\n'), true);
    await fs.appendFile(log, '{bad json}\n');
    const corrupt = await fs.readFile(log);
    await rejects(f.store.getSnapshot(f.key, f.course), 'storageUnavailable');
    assert.deepEqual(await fs.readFile(log), corrupt);
});

test('checkpoint failure keeps the durably committed journal and restores on reopen', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    f.store.checkpoint = async () => { throw new Error('injected checkpoint failure'); };
    const saved = await f.store.apply(f.key, f.course, start.sequence, start.planHash, 'cache-000001', action('manualCheck'));
    const recovered = await new TutorProgressStore(f.data).getSnapshot(f.key, f.course);
    assert.deepEqual(recovered.snapshot, saved);
    assert.equal(JSON.parse(await fs.readFile(join(f.data, f.key, 'state.json'), 'utf8')).sequence, saved.sequence);
});

test('a journal write failure reports failure, sends no success event and preserves progress', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    const events = [];
    f.store.onChange((key, seq) => events.push(seq));
    f.store.append = async () => { throw new Error('injected disk full'); };
    await rejects(f.store.apply(f.key, f.course, start.sequence, start.planHash, 'failed-00001', action('manualCheck')), 'storageUnavailable');
    assert.deepEqual(events, []);
    assert.deepEqual((await new TutorProgressStore(f.data).getSnapshot(f.key, f.course)).snapshot, start);
});

test('missing committed log entries do not reset the student record', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    await f.store.apply(f.key, f.course, start.sequence, start.planHash, 'missing-0001', action('manualCheck'));
    const log = join(f.data, f.key, 'events.jsonl');
    const first = (await fs.readFile(log, 'utf8')).split('\n')[0] + '\n';
    await fs.writeFile(log, first);
    await rejects(f.store.getSnapshot(f.key, f.course), 'storageUnavailable');
    assert.equal(await fs.readFile(log, 'utf8'), first);
});

test('changing the plan starts a new projection and keeps old plan evidence', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    const done = await f.store.apply(f.key, f.course, start.sequence, start.planHash, 'old-plan-001', action('manualCheck'));
    const revised = { ...f.course, revision: 2, title: '新课程' };
    revised.contentHash = digest(canonicalCourseContent(revised));
    const updated = (await f.store.getSnapshot(f.key, revised)).snapshot;
    assert.deepEqual(updated.progress.steps, {});
    assert.ok(updated.sequence > done.sequence);
    assert.equal((await fs.readdir(join(f.data, f.key, 'plans'))).filter(n => n.endsWith('.json')).length, 2);
    await rejects(f.store.apply(f.key, revised, done.sequence, done.planHash, 'old-plan-002', action('manualCheck')), 'revisionConflict');
});

test('legacy import is one-time, self-checked, retryable and rejects malformed input', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    await rejects(f.store.apply(f.key, f.course, start.sequence, start.planHash, 'bad-import-1', { kind: 'legacyImport', progress: 'garbage' }), 'invalidSchema');
    const old = { completed: ['A'], current: 'B', levels: { A: 3 }, references: ['A'], decisions: {}, log: [] };
    const saved = await f.store.apply(f.key, f.course, start.sequence, start.planHash, 'import-00001', { kind: 'legacyImport', progress: old });
    assert.equal(saved.legacyImported, true);
    assert.equal(saved.progress.steps.A.status, 'self-checked');
    assert.deepEqual(saved.progress.references, ['A']);
    assert.deepEqual(old.completed, ['A']);
    await rejects(f.store.apply(f.key, f.course, saved.sequence, saved.planHash, 'import-00002', { kind: 'legacyImport', progress: old }), 'revisionConflict');
    assert.deepEqual(await f.store.apply(f.key, f.course, start.sequence, start.planHash, 'import-00001', { kind: 'legacyImport', progress: old }), saved);
});

test('copied projects have separate keys; paths and symlink storage cannot redirect writes', async t => {
    const f = await fixture(t);
    const other = join(f.base, 'copy');
    await fs.mkdir(other);
    assert.notEqual(await TutorProgressStore.projectKey(other), f.key);
    await rejects(f.store.getSnapshot('../outside', f.course), 'outOfScope');
    await fs.mkdir(f.data);
    await fs.symlink(other, join(f.data, f.key));
    await rejects(f.store.getSnapshot(f.key, f.course), 'outOfScope');
    assert.deepEqual(await fs.readdir(other), []);
});

test('session facade has no path grants or prototype methods and isolates clients', async t => {
    const f = await fixture(t);
    const server = new TutorStorageServer(f.store);
    const seenA = [], seenB = [];
    const a = server.connect({ onDidChange: e => seenA.push(e) });
    const b = server.connect({ onDidChange: e => seenB.push(e) });
    t.after(() => { a.dispose(); b.dispose(); });
    assert.equal(Object.getPrototypeOf(a.service), null);
    assert.equal(a.service.authorizeWorkspace, undefined);
    assert.equal(a.service.constructor, undefined);
    assert.equal((await a.service.openSession(f.root)).error.code, 'outOfScope');
    const wa = await a.authorizeWorkspace(f.root);
    const wb = await b.authorizeWorkspace(f.root);
    assert.notEqual(wa, wb);
    const sa = ok(await a.service.openSession(wa));
    const sb = ok(await b.service.openSession(wb));
    assert.equal((await b.service.getSnapshot(sa.sessionId)).error.code, 'outOfScope');
    assert.equal((await b.service.openSession(wa)).error.code, 'outOfScope');
    const state = sa.learning.snapshot;
    const saved = ok(await a.service.recordAction(sa.sessionId, state.sequence, state.planHash, 'service-0001', { type: 'manualCheck', stepId: 'A' }));
    assert.equal(seenA.at(-1).sessionId, sa.sessionId);
    assert.equal(seenB.at(-1).sessionId, sb.sessionId);
    assert.equal(seenB.at(-1).sequence, saved.sequence);
    assert.deepEqual(ok(await b.service.getSnapshot(sb.sessionId, state.sequence)).learning.snapshot, saved);
    a.revokeWorkspace(wa);
    assert.equal((await a.service.getSnapshot(sa.sessionId)).error.code, 'outOfScope');
    b.dispose();
    assert.equal((await b.service.getSnapshot(sb.sessionId)).error.code, 'outOfScope');
    const reconnect = server.connect({ onDidChange() {} }); t.after(() => reconnect.dispose());
    assert.equal((await reconnect.service.getSnapshot(sb.sessionId)).error.code, 'outOfScope');
    const wc = await reconnect.authorizeWorkspace(f.root);
    assert.deepEqual(ok(await reconnect.service.openSession(wc)).learning.snapshot, saved);
});

test('service migration previews are read-only and owned by the originating connection', async t => {
    const f = await fixture(t, 1);
    const server = new TutorStorageServer(f.store);
    const a = server.connect({ onDidChange() {} }); const b = server.connect({ onDidChange() {} });
    t.after(() => { a.dispose(); b.dispose(); });
    const sa = ok(await a.service.openSession(await a.authorizeWorkspace(f.root)));
    const sb = ok(await b.service.openSession(await b.authorizeWorkspace(f.root)));
    const preview = ok(await a.service.previewMigration(sa.sessionId, target));
    assert.equal(await fs.readFile(f.path, 'utf8'), f.source);
    assert.equal((await b.service.acceptMigration(sb.sessionId, preview.id, preview.sourceDigest)).error.code, 'revisionConflict');
    const adopted = ok(await a.service.acceptMigration(sa.sessionId, preview.id, preview.sourceDigest));
    assert.equal(adopted.plan.kind, 'course');
    assert.equal(adopted.learning.snapshot.sequence, 1);
    assert.equal(ok(await b.service.getSnapshot(sb.sessionId)).plan.kind, 'course');
});

test('ordinary project returns no course without creating learning files', async t => {
    const f = await fixture(t);
    await fs.unlink(f.path);
    const server = new TutorStorageServer(f.store);
    const connection = server.connect({ onDidChange() {} }); t.after(() => connection.dispose());
    const state = ok(await connection.service.openSession(await connection.authorizeWorkspace(f.root)));
    assert.equal(state.plan.kind, 'none');
    assert.equal(state.learning, undefined);
    await assert.rejects(fs.stat(f.data), { code: 'ENOENT' });
});

test('process exit after durable event append replays the committed operation exactly once', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    const script = `
      const {TutorProgressStore} = require(${JSON.stringify(resolve(__dirname, '../lib/node/tutor/tutor-progress-store'))});
      (async()=>{
        const store = new TutorProgressStore(${JSON.stringify(f.data)});
        let writes = 0;
        const checkpoint = store.checkpoint.bind(store);
        store.checkpoint = async (...args) => {
          if (++writes === 2) process.exit(74);
          return checkpoint(...args);
        };
        await store.apply(${JSON.stringify(f.key)},${JSON.stringify(f.course)},${start.sequence},${JSON.stringify(start.planHash)},
          'crash-write-1',{kind:'action',action:{type:'manualCheck',stepId:'A'}});
        process.exit(99);
      })().catch(e=>{console.error(e);process.exit(1)});`;
    const child = spawnSync(process.execPath, ['-e', script], { timeout: 15000, encoding: 'utf8' });
    assert.equal(child.status, 74, child.stderr);
    const resumed = new TutorProgressStore(f.data);
    const saved = (await resumed.getSnapshot(f.key, f.course)).snapshot;
    assert.equal(saved.sequence, start.sequence + 1);
    assert.equal(saved.progress.steps.A.status, 'self-checked');
    assert.deepEqual(await resumed.apply(f.key, f.course, start.sequence, start.planHash, 'crash-write-1', action('manualCheck')), saved);
});

test('event gaps produce a complete snapshot and replay window stays bounded', async t => {
    const f = await fixture(t);
    const initial = await f.store.getSnapshot(f.key, f.course, 0);
    const lines = [initial.events[0]];
    for (let i = 2; i <= 260; i++) {
        const data = { ...lines.at(-1), sequence: i, kind: 'action', requestId: `fixture-${i}`, fingerprint: 'a'.repeat(64), previousHash: lines.at(-1).checksum };
        delete data.checksum;
        const { canonicalLearningJson } = require('../lib/common/tutor/tutor-learning-state');
        lines.push({ ...data, checksum: digest(canonicalLearningJson(data)) });
    }
    await fs.writeFile(join(f.data, f.key, 'events.jsonl'), lines.map(row => JSON.stringify(row) + '\n').join(''));
    const gap = await f.store.getSnapshot(f.key, f.course, 0);
    assert.equal(gap.snapshot.sequence, 260);
    assert.equal(gap.events, undefined);
    const recent = await f.store.getSnapshot(f.key, f.course, 258);
    assert.deepEqual(recent.events.map(event => event.sequence), [259, 260]);
    const caughtUp = await f.store.getSnapshot(f.key, f.course, 260);
    assert.deepEqual(caughtUp.events, []);
});

test('input objects are detached before awaiting queued writes', async t => {
    const f = await fixture(t);
    const start = (await f.store.getSnapshot(f.key, f.course)).snapshot;
    const input = action('manualCheck');
    const pending = f.store.apply(f.key, f.course, start.sequence, start.planHash, 'detached-001', input);
    input.action.type = 'select';
    const saved = await pending;
    assert.equal(saved.progress.steps.A.status, 'self-checked');
    saved.progress.steps.A.status = 'verified';
    assert.equal((await f.store.getSnapshot(f.key, f.course)).snapshot.progress.steps.A.status, 'self-checked');
});

test('revoked ownership stops a pending mutation before commit', async t => {
    const f = await fixture(t);
    const server = new TutorStorageServer(f.store);
    const connection = server.connect({ onDidChange() {} }); t.after(() => connection.dispose());
    const grant = await connection.authorizeWorkspace(f.root);
    const session = ok(await connection.service.openSession(grant));
    const start = session.learning.snapshot;
    const prepare = f.store.prepare.bind(f.store);
    f.store.prepare = async (...args) => {
        const value = await prepare(...args);
        connection.revokeWorkspace(grant);
        return value;
    };
    const result = await connection.service.recordAction(session.sessionId, start.sequence, start.planHash, 'revoked-0001', { type: 'manualCheck', stepId: 'A' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'outOfScope');
    assert.deepEqual((await new TutorProgressStore(f.data).getSnapshot(f.key, f.course)).snapshot, start);
});

test('recreating a directory at the same path does not inherit the removed project session', async t => {
    const f = await fixture(t);
    await fs.rename(f.root, join(f.base, 'previous-project'));
    await fs.mkdir(f.root);
    assert.notEqual(await TutorProgressStore.projectKey(f.root), f.key);
});
