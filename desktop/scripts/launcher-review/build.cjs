// SPDX-License-Identifier: MIT
// Manual visual fixture: production components and styles, no real project services.
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const out = process.argv[2]; if (!out) throw Error('Pass an external output directory');
fs.mkdirSync(out,{recursive:true});
const stubs={
 '@theia/core/lib/browser/dialogs': 'export class DialogProps {}',
 '@theia/core/lib/browser/dialogs/react-dialog': 'export class ReactDialog {}',
 '@theia/filesystem/lib/browser/file-dialog': 'export class FileDialogService {}',
 '@theia/core/lib/common/uri': 'export class URI {}',
 './nodu-embedded-model': 'export class EmbeddedError extends Error {}',
 '../browser/scope-theme': 'export const SCOPE_THEME_ID="scope-dark", SCOPE_LIGHT_THEME_ID="scope-light";'
};
esbuild.build({entryPoints:[path.join(__dirname,'fixture.tsx')],bundle:true,format:'iife',outfile:path.join(out,'fixture.js'),loader:{'.woff2':'file','.ttf':'file','.svg':'file'},define:{'process.env.NODE_ENV':'"development"'},alias:{'@theia/core/shared/react':require.resolve('react')},plugins:[{name:'service-boundaries',setup(build){for(const [name,contents] of Object.entries(stubs)){build.onResolve({filter:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')},()=>({path:name,namespace:'fixture-stub'}));}build.onLoad({filter:/.*/,namespace:'fixture-stub'},args=>({contents:stubs[args.path],loader:'js'}));}}]}).catch(error => { console.error(error); process.exitCode = 1; });

fs.writeFileSync(path.join(out,'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Nodu 工作台验收</title><link rel="stylesheet" href="fixture.css"><style>html,body{margin:0;height:100%}button,input,select{font:inherit}.theia-button{background:var(--theia-button-background);color:var(--theia-button-foreground);border:0;border-radius:4px;padding:6px 14px}.theia-button.secondary{background:var(--theia-button-secondaryBackground);color:var(--theia-button-secondaryForeground)}</style><div id="nodu-launcher"></div><script src="fixture.js"></script></html>`);
