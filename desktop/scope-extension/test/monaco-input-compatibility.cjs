// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const exportsObject={};
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/browser/nodu-monaco-editor-provider.ts'),'utf8'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true}
}).outputText;
class Provider { toOptionName(name,prefixes){const prefix=prefixes.find(p=>name.startsWith(p));return prefix?name.slice(prefix.length):name;} }
vm.runInNewContext(source,{exports:exportsObject,require:name=>name.includes('inversify')?{injectable:()=>x=>x}:{MonacoEditorProvider:Provider}});
test('the existing EditContext preference maps to the current Monaco option for creation and updates',()=>{
 const provider=new exportsObject.NoduMonacoEditorProvider();
 assert.equal(provider.toOptionName('editor.experimentalEditContextEnabled',['editor.']),'editContext');
 assert.equal(provider.toOptionName('editor.fontSize',['editor.']),'fontSize');
 assert.equal(provider.toOptionName('diffEditor.renderSideBySide',['editor.','diffEditor.']),'renderSideBySide');
});
