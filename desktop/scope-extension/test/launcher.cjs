// SPDX-License-Identifier: MIT
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const util = require('../lib/common/nodu-launcher-util');
const { NoduProjectsServer } = require('../lib/node/nodu-projects-server');
const { resolveLaunchWorkspace } = require('../../scripts/launch.cjs');

test('desktop starts at workbench, explicit paths and browser default are retained', () => {
    assert.equal(resolveLaunchWorkspace('electron', undefined, '/tmp'), undefined);
    assert.equal(resolveLaunchWorkspace('electron', 'my-project', '/tmp'), '/tmp/my-project');
    assert.ok(resolveLaunchWorkspace('browser', undefined, '/tmp').endsWith('examples/green-tracker'));
});
test('launcher URL never becomes a recent project; malformed fragments are rejected', () => {
    assert.equal(util.projectFromWindowUrl('file:///index.html?noduLauncher=1#/tmp/x', 'noduLauncher'), undefined);
    assert.equal(util.projectFromWindowUrl('file:///index.html#!empty', 'noduLauncher'), undefined);
    assert.equal(util.projectFromWindowUrl('file:///index.html#/%ZZ', 'noduLauncher'), undefined);
    assert.equal(util.projectFromWindowUrl('file:///index.html#/tmp/my%20project', 'noduLauncher'), '/tmp/my project');
});
test('recent projects are deduplicated, bounded and moved to front without deleting missing paths', () => {
    assert.deepEqual(util.mergeRecent([{path:'/missing',lastOpened:2}], ['/missing','/existing']), [{path:'/missing',lastOpened:2},{path:'/existing'}]);
    assert.deepEqual(util.touchRecent([{path:'/a'},{path:'/b'}], '/b', 10), [{path:'/b',lastOpened:10},{path:'/a'}]);
    assert.equal(util.mergeRecent([], Array.from({length:60},(_,n)=>'/'+n)).length,50);
    assert.equal(util.pathKey('C:\\Users\\Name\\'), util.pathKey('c:/users/name'));
});
test('startup settings parse comments without corrupting URL strings', () => {
    assert.deepEqual(util.parseJsonc('{"url":"https://host/a,}",/* hi */"nodu.startup.reopenLastProject":true,}'), {url:'https://host/a,}', 'nodu.startup.reopenLastProject':true});
    assert.throws(()=>util.parseJsonc('{bad}'));
});
test('recent store serializes simultaneous windows, handles missing folders and removes Theia recents', async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nodu-recent-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const a=path.join(root,'a'), b=path.join(root,'b');
    await fs.mkdir(a); await fs.writeFile(path.join(a,'nodu.json'),JSON.stringify({kind:'stm32-hal',target:{mcu:'STM32F103C8T6'}}));
    const service=new NoduProjectsServer(); let removed;
    service.env={getConfigDirUri:async()=>pathToFileURL(root).href};
    service.workspaces={getRecentWorkspaces:async()=>[],removeRecentWorkspace:async uri=>{removed=uri;}};
    await Promise.all([service.touch(a),service.touch(b)]);
    const rows=await service.recent();
    assert.equal(rows.length,2);assert.equal(rows[0].missing,true);assert.equal(rows[1].tag,'STM32F103');
    await service.remove(b); assert.equal((await service.recent()).length,1);assert.equal(removed,pathToFileURL(b).href);
    assert.throws(()=>service.touch('../relative'));
});
test('example copies are isolated under concurrent creation and omit symlinks and build state', async t => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nodu-examples-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const examples=path.join(root,'examples'), source=path.join(examples,'hello'), projects=path.join(root,'projects');
    await fs.mkdir(path.join(source,'build'),{recursive:true});await fs.mkdir(projects);
    await fs.writeFile(path.join(source,'main.c'),'int main(void) { return 0; }');
    await fs.writeFile(path.join(source,'build','firmware.bin'),'old');
    await fs.symlink(path.join(source,'main.c'),path.join(source,'linked.c'));
    const service=new NoduProjectsServer();service.examplesDir=async()=>fs.realpath(examples);service.projectsDir=async()=>projects;
    const copies=await Promise.all([service.copyExample(source),service.copyExample(source)]);
    assert.notEqual(copies[0],copies[1]);
    for(const copy of copies) { assert.deepEqual(await fs.readdir(copy),['main.c']); }
    await fs.writeFile(path.join(copies[0],'main.c'),'changed');
    assert.equal(await fs.readFile(path.join(source,'main.c'),'utf8'),'int main(void) { return 0; }');
    await assert.rejects(()=>service.copyExample(root),/只能复制/);
});

// Exercise the actual window-routing methods without connecting to a desktop session.
function applicationMethods(names, dependencies={}) {
    const ts=require('typescript'), fsSync=require('node:fs');
    const file=path.join(__dirname,'../src/electron-main/nodu-electron-main-application.ts');
    const source=ts.createSourceFile(file,fsSync.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    const cls=source.statements.find(node=>ts.isClassDeclaration(node)&&node.name.text==='NoduElectronMainApplication');
    const members=cls.members.filter(m=>names.includes(m.name?.getText(source))).map(m=>m.getText(source)).join('\n');
    const js=ts.transpile(`class Subject extends Base { ${members} }`,{target:ts.ScriptTarget.ES2022});
    return new Function('Base',...Object.keys(dependencies),js+';return Subject;')(class {},...Object.values(dependencies));
}
test('concurrent welcome requests create one window', async () => {
    const App=applicationMethods(['showLauncher']);const app=new App();let created=0,revealed=0;
    const window={}; app.firstLauncher=()=>undefined;
    app.createLauncherWindow=async()=>{created++;await new Promise(resolve=>setImmediate(resolve));return window;};
    app.reveal=w=>{assert.equal(w,window);revealed++;};
    await Promise.all([app.showLauncher(),app.showLauncher(),app.showLauncher()]);
    assert.equal(created,1);assert.equal(revealed,3);assert.equal(app.pendingLauncher,undefined);
});
test('project routing focuses an existing window and waits before closing the welcome window', async () => {
    const events=[];const App=applicationMethods(['openProjectWindow'],{whenShown:async()=>events.push('shown')});
    const app=new App();app.launcherIds=new Set([1]);app.projectWindow=()=>({id:2});
    app.reveal=()=>events.push('focus');app.openWindowWithWorkspace=()=>{throw Error('must not duplicate');};
    app.closeWindowById=id=>events.push('close:'+id);
    await app.openProjectWindow('/existing');assert.deepEqual(events,['focus','shown','close:1']);
    events.length=0;await app.openProjectWindow('/existing',{keepLauncher:true});assert.deepEqual(events,['focus']);
});
test('failed project opening leaves the welcome window available', async () => {
    const App=applicationMethods(['openProjectWindow'],{whenShown:async()=>{throw Error('window failed');}});
    const app=new App();let closed=false;app.launcherIds=new Set([1]);app.projectWindow=()=>undefined;
    app.openWindowWithWorkspace=async()=>({id:2});app.closeWindowById=()=>{closed=true;};
    await assert.rejects(()=>app.openProjectWindow('/existing'),/window failed/);assert.equal(closed,false);
});

test('packaged courses are filtered, fingerprinted and found through the resource seam', async t => {
    const {copyCourseExamples,courseExamplesStamp}=require('../../scripts/course-examples.cjs');
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nodu-course-package-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const source=path.join(root,'source'),extension=path.join(root,'app/node_modules/@scope/studio-extension'),dest=path.join(extension,'resources/project-examples');
    await fs.mkdir(source,{recursive:true});
    await fs.cp(path.join(__dirname,'../../examples/stm32f103-uart-tutor'),path.join(source,'examples/stm32f103-uart-tutor'),{recursive:true,filter:p=>!['build','.nodu'].includes(path.basename(p))});
    await fs.cp(path.join(__dirname,'../../examples/stm32-sht30-tutor'),path.join(source,'examples/stm32-sht30-tutor'),{recursive:true,filter:p=>!['build','.nodu'].includes(path.basename(p))});
    const before=courseExamplesStamp(source),course=path.join(source,'examples/stm32f103-uart-tutor');
    await fs.mkdir(path.join(course,'.nodu'),{recursive:true});await fs.writeFile(path.join(course,'.nodu/private.json'),'private');
    await fs.writeFile(path.join(course,'firmware.bin'),'binary');assert.equal(courseExamplesStamp(source),before);
    copyCourseExamples(source,dest);assert.equal(await fs.stat(path.join(dest,'stm32f103-uart-tutor/firmware.bin')).catch(()=>undefined),undefined);
    assert.equal(await fs.stat(path.join(dest,'stm32f103-uart-tutor/.nodu')).catch(()=>undefined),undefined);
    const service=new NoduProjectsServer();service.extensionDirectory=()=>extension;
    assert.equal((await service.examples()).length,2);
    await fs.appendFile(path.join(course,'README.md'),'changed');assert.notEqual(courseExamplesStamp(source),before);
    await fs.symlink(path.join(course,'README.md'),path.join(course,'escape.md'));assert.throws(()=>courseExamplesStamp(source),/symlink/);
});
