// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parse, stringify } = require('yaml');
const { createSourceProject, parseProjectRequest } = require('../lib/node/nodu-project-generator');
const { arduinoVersionSatisfies, compareArduinoVersions, resolveArduinoLibraries, listArduinoLibraries, changeArduinoLibrary,
  prepareBundledArduinoLibraries, readArduinoLibraryProfile } = require('../lib/node/nodu-arduino-libraries');
const { ARDUINO_BUNDLED_LIBRARIES } = require('../lib/common/nodu-arduino-library-catalog');
const resources = path.resolve(__dirname, '../resources/arduino/libraries');
const entry = (name, version, dependencies = []) => ({ name, version, dependencies, author: 'Maker', sentence: 'A device library', architectures: ['*'] });
async function fixture(t, entries = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-libraries-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createSourceProject(parseProjectRequest({ parent: root, name: 'sketch', chip: 'esp32c3', template: 'empty' }));
  const file = path.join(project.path, 'sketch.yaml'), doc = parse(await fs.readFile(file, 'utf8'));
  doc.profiles.nodu.libraries = []; await fs.writeFile(file, '# preserve me\n'+stringify(doc));
  const home = path.join(root, 'home'); await fs.mkdir(path.join(home, 'data'), { recursive: true });
  await fs.writeFile(path.join(home, 'data/library_index.json'), JSON.stringify({ libraries: entries }));
  const calls = []; let stopped = false;
  const context = { home, resources, run: async args => { calls.push(args); return { code: 0, output: '' }; }, cancelled: () => stopped };
  return { root, project: project.path, file, home, calls, context, stop: () => { stopped = true; },
    change: (name, version, action='add') => changeArduinoLibrary(context, { path: project.path, name, version, action, operationId: 'op' }) };
}
test('Arduino comparison grammar respects precedence, prereleases and unsupported syntax', () => {
  assert.equal(arduinoVersionSatisfies('1.4.0', '(>=1.0.0 && <2.0.0) && !=1.3.0'), true);
  assert.equal(arduinoVersionSatisfies('2.0.0', '=1.0.0 || (=2.0.0 && !(<1.0.0))'), true);
  assert.equal(arduinoVersionSatisfies('1.3.0', '>=1.0.0 && !=1.3.0'), false);
  assert.ok(compareArduinoVersions('1.0.0-beta-a.2', '1.0.0-beta-a.10') < 0);
  assert.ok(compareArduinoVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(compareArduinoVersions('2.72', '2.72.0'), 0);
  assert.equal(arduinoVersionSatisfies('2.72', '>=2.70'), true);
  assert.throws(() => arduinoVersionSatisfies('1.0.0', '^1.0.0'), /不支持/);
});
test('dependency resolution backtracks and preserves compatible existing versions', () => {
  const records = [entry('Parent', '1.0.0', [{ name: 'Shared', version: '>=1.0.0' }]),
    entry('Shared', '2.0.0', [{ name: 'Leaf', version: '=2.0.0' }]), entry('Shared', '1.0.0', [{ name: 'Leaf', version: '=1.0.0' }]), entry('Leaf', '1.0.0')];
  const roots = [{ name: 'Parent', version: '1.0.0', direct: true }];
  const resolved = resolveArduinoLibraries(records, roots);
  assert.equal(resolved.find(x => x.name === 'Shared').version, '1.0.0');
  assert.equal(resolved.find(x => x.name === 'Leaf').direct, false);
  assert.throws(() => resolveArduinoLibraries(records, [...roots, { name: 'Leaf', version: '2.0.0', direct: true }]), /不兼容/);
});
test('bundled files match fixed catalog and each archive checksum; damaged cache is repaired', async t => {
  const f = await fixture(t), manifest = JSON.parse(await fs.readFile(path.join(resources, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.libraries.map(({name,version}) => ({name,version})), ARDUINO_BUNDLED_LIBRARIES.map(({name,version}) => ({name,version})));
  await prepareBundledArduinoLibraries(f.context);
  const archive = path.join(f.home, 'downloads/libraries', manifest.libraries[0].archiveFileName);
  await fs.writeFile(archive, 'broken'); await prepareBundledArduinoLibraries(f.context);
  assert.equal((await fs.stat(archive)).size, manifest.libraries[0].size);
  assert.equal(f.calls.length, 0);
});
test('an older index gains every pinned bundle version without losing other libraries or future versions', async t => {
  const f = await fixture(t, [entry('CustomSensor', '9.0.0'), entry('ArduinoJson', '99.0.0')]);
  const file = path.join(f.home, 'data/library_index.json'); await fs.writeFile(file + '.sig', 'signature of the original index');
  await prepareBundledArduinoLibraries(f.context);
  const index = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const library of ARDUINO_BUNDLED_LIBRARIES) { assert.equal(index.libraries.filter(item => item.name === library.name && item.version === library.version).length, 1); }
  assert.ok(index.libraries.some(item => item.name === 'CustomSensor'));
  assert.ok(index.libraries.some(item => item.name === 'ArduinoJson' && item.version === '99.0.0'));
  await assert.rejects(fs.access(file + '.sig'));
  const before = await fs.stat(file); await prepareBundledArduinoLibraries(f.context); assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});
test('offline list retains bundled/core records and exact project version without network', async t => {
  const f = await fixture(t); await fs.rm(path.join(f.home, 'data/library_index.json'));
  const result = await listArduinoLibraries(f.context, { path: f.project, query: 'arduinojson', filter: 'bundled' });
  assert.equal(result.offline, true); assert.equal(result.total, 1); assert.equal(result.items[0].bundledVersion, '7.4.3');
  assert.equal(result.items[0].installedVersion, undefined); assert.equal(f.calls.length, 0);
  const core = await listArduinoLibraries(f.context, { path: f.project, query: 'WiFi' });
  assert.equal(core.items[0].core, true); assert.equal(core.items[0].installedVersion, '3.3.12');
});
test('failed index refresh still shows local search results', async t => {
  const f = await fixture(t, [entry('TestSensor', '1.0.0')]); f.context.run = async () => { throw new Error('network down'); };
  const result = await listArduinoLibraries(f.context, { path: f.project, query: 'TestSensor', refresh: true });
  assert.equal(result.items[0].name, 'TestSensor'); assert.equal(result.offline, true); assert.match(result.error, /更新失败/);
});
test('add and upgrade pin dependency closure, preserve comments and other profiles', async t => {
  const f = await fixture(t, [entry('Parent', '1.0.0', [{ name: 'Child', version: '=1.0.0' }]), entry('Parent', '2.0.0', [{ name: 'Child', version: '=2.0.0' }]), entry('Child', '1.0.0'), entry('Child', '2.0.0')]);
  await fs.appendFile(f.file, '\n# trailing note\n');
  assert.equal((await f.change('Parent', '1.0.0')).ok, true);
  let profile = await readArduinoLibraryProfile(f.project);
  assert.deepEqual(profile.libraries, [{name:'Parent',version:'1.0.0',direct:true},{name:'Child',version:'1.0.0',direct:false}]);
  assert.match(await fs.readFile(f.file,'utf8'), /preserve me/);
  assert.equal((await f.change('Parent', '2.0.0', 'update')).ok, true);
  profile = await readArduinoLibraryProfile(f.project); assert.equal(profile.libraries.find(x=>x.name==='Child').version, '2.0.0');
  const listing = await listArduinoLibraries(f.context,{path:f.project,filter:'installed',query:'Parent'});
  assert.equal(listing.items[0].installedVersion,'2.0.0'); assert.equal(listing.items[0].updateAvailable,false);
});
test('network failure, cancellation and concurrent edit never publish a replacement profile', async t => {
  const f = await fixture(t, [entry('Sensor', '1.0.0')]), original = await fs.readFile(f.file,'utf8');
  f.context.run = async () => ({code:1,output:'offline'});
  assert.equal((await f.change('Sensor','1.0.0')).ok,false); assert.equal(await fs.readFile(f.file,'utf8'),original);
  f.context.run = async () => { await fs.appendFile(f.file,'\n# external edit\n'); return {code:0,output:''}; };
  const concurrent = await f.change('Sensor','1.0.0'); assert.equal(concurrent.ok,false); assert.match(concurrent.error,/已被修改/);
  assert.equal(await fs.readFile(f.file,'utf8'),original+'\n# external edit\n');
  f.context.run = async () => { f.stop(); return {code:0,output:''}; };
  const result = await f.change('Sensor','1.0.0'); assert.equal(result.cancelled,true);
  assert.equal(await fs.readFile(f.file,'utf8'),original+'\n# external edit\n');
  assert.deepEqual((await fs.readdir(f.project)).filter(x=>x.endsWith('.tmp')),[]);
});
test('library edits retain unchanged entries, version comments, local paths and other profiles', async t => {
  const f = await fixture(t, [entry('Parent','1.0.0',[{name:'Child',version:'=1.0.0'}]),
    entry('Parent','2.0.0',[{name:'Child',version:'=2.0.0'}]), entry('Child','1.0.0'), entry('Child','2.0.0'),
    entry('Keep','1.0.0'), entry('Added','1.0.0')]);
  const source = (await fs.readFile(f.file,'utf8')).replace('libraries: []', `libraries: # dependencies\n      # parent purpose\n      - 'Parent (1.0.0)' # parent version\n      - dependency: Child (1.0.0) # child version\n      - Keep (1.0.0) # untouched MQTT equivalent\n      - dir: ./local # local path\n        custom: retained`);
  await fs.writeFile(f.file, source + '\n# another project\nprofiles_extra: { libraries: [Elsewhere (1.0.0)] }\n');
  assert.equal((await f.change('Parent','2.0.0','update')).ok,true);
  assert.equal((await f.change('Added','1.0.0')).ok,true);
  assert.equal((await f.change('Added',undefined,'remove')).ok,true);
  const updated = await fs.readFile(f.file,'utf8');
  for (const comment of ['dependencies','parent purpose','parent version','child version','untouched MQTT equivalent','local path','another project']) {
    assert.ok(updated.includes('# '+comment), comment);
  }
  assert.match(updated, /'Parent \(2\.0\.0\)' # parent version/);
  assert.match(updated, /dependency: Child \(2\.0\.0\) # child version/);
  const parsed = parse(updated);
  assert.deepEqual(parsed.profiles.nodu.libraries.at(-1), {dir:'./local',custom:'retained'});
  assert.deepEqual(parsed.profiles_extra, {libraries:['Elsewhere (1.0.0)']});
  // Promoting a shared dependency to a direct dependency retains its comment too.
  assert.equal((await f.change('Child','2.0.0')).ok,true);
  assert.match(await fs.readFile(f.file,'utf8'), /Child \(2\.0\.0\) # child version/);
});
test('changing a shared YAML anchor cannot silently alter another profile or leave a dangling alias', async t => {
  const f = await fixture(t, [entry('Parent','1.0.0'),entry('Parent','2.0.0')]);
  const source = (await fs.readFile(f.file,'utf8')).replace('libraries: []', 'libraries:\n      - &shared Parent (1.0.0)') + '\nother_configuration: *shared\n';
  await fs.writeFile(f.file, source);
  for (const action of ['update','remove']) {
    const result = await f.change('Parent','2.0.0',action);
    assert.equal(result.ok,false); assert.match(result.error,/YAML 引用/);
    assert.equal(await fs.readFile(f.file,'utf8'),source);
  }
});
test('remove refuses shared dependency, prunes unneeded children, and cannot remove core', async t => {
  const f = await fixture(t,[entry('Parent','1.0.0',[{name:'Child'}]),entry('Child','1.0.0')]);
  await f.change('Parent','1.0.0'); const before = await fs.readFile(f.file,'utf8');
  assert.equal((await f.change('Child',undefined,'remove')).ok,false); assert.equal(await fs.readFile(f.file,'utf8'),before);
  assert.equal((await f.change('Parent',undefined,'remove')).ok,true);
  assert.deepEqual((await readArduinoLibraryProfile(f.project)).libraries,[]);
  assert.equal((await f.change('WiFi',undefined,'remove')).ok,false);
});
test('incompatible architecture and malformed versions cannot modify project', async t => {
  const f = await fixture(t,[{...entry('AvrOnly','1.0.0'),architectures:['avr']}]); const original = await fs.readFile(f.file,'utf8');
  assert.equal((await f.change('AvrOnly','1.0.0')).ok,false);
  assert.equal((await f.change('ArduinoJson','latest')).ok,false);
  assert.equal((await f.change('Bad;Command','1.0.0')).ok,false);
  assert.equal(await fs.readFile(f.file,'utf8'),original);
});
test('a corrupt bundled archive fails before touching project or publishing cache', async t => {
  const f = await fixture(t); const custom = path.join(f.root,'broken-bundle'); await fs.mkdir(custom);
  const manifest=JSON.parse(await fs.readFile(path.join(resources,'manifest.json'),'utf8'));
  await fs.writeFile(path.join(custom,'manifest.json'),JSON.stringify({libraries:[manifest.libraries[0]]}));
  await fs.writeFile(path.join(custom,manifest.libraries[0].archiveFileName),'corrupted');
  await assert.rejects(prepareBundledArduinoLibraries({...f.context,resources:custom}),/校验失败/);
  assert.equal((await fs.readdir(path.join(f.home,'downloads/libraries'))).length,0);
});

test('C3 exposes SPI SD while only S3 exposes the supported SDMMC Core API', async t => {
  const f = await fixture(t);
  const c3 = await listArduinoLibraries(f.context, { path: f.project, query: 'SD' });
  assert.ok(c3.items.some(item => item.name === 'SD' && item.core));
  assert.equal(c3.items.some(item => item.name === 'SD_MMC'), false);
  const s3 = await createSourceProject(parseProjectRequest({ parent: f.root, name: 's3', chip: 'esp32s3', template: 'empty' }));
  const supported = await listArduinoLibraries(f.context, { path: s3.path, query: 'SD_MMC' });
  assert.equal(supported.items[0].name, 'SD_MMC'); assert.equal(supported.items[0].core, true);
});
