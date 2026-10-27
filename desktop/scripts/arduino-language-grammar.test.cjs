// SPDX-License-Identifier: MIT
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const textmate=require('vscode-textmate');
const onig=require('vscode-oniguruma');
test('bundled official C++ grammar tokenizes Arduino directives, types, strings and comments',async()=>{
    const root=path.join(__dirname,'arduino-language-plugin/grammar');
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
    for(const item of manifest.files)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,item.file))).digest('hex'),item.sha256);
    const wasm=fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength));
    const registry=new textmate.Registry({onigLib:Promise.resolve({createOnigScanner:patterns=>new onig.OnigScanner(patterns),createOnigString:text=>new onig.OnigString(text)}),loadGrammar:async scope=>{
        const file=scope==='source.cpp'?'cpp.tmLanguage.json':scope==='source.cpp.embedded.macro'?'cpp.embedded.macro.tmLanguage.json':undefined;
        return file?textmate.parseRawGrammar(fs.readFileSync(path.join(root,'syntaxes',file),'utf8'),file):null;
    }});
    const grammar=await registry.loadGrammar('source.cpp');assert(grammar);
    const examples=[['#include <Arduino.h>','include','keyword.control.directive'],['void setup() {','void','storage.type'],['  Serial.println("hello");','hello','string.quoted'],['// Arduino 注释','Arduino','comment.line']];
    let state=textmate.INITIAL;
    for(const [line,word,scope]of examples){const result=grammar.tokenizeLine(line,state);state=result.ruleStack;const offset=line.indexOf(word);assert(result.tokens.some(t=>t.startIndex<=offset&&t.endIndex>offset&&t.scopes.some(s=>s.startsWith(scope))),JSON.stringify(result.tokens));}
    registry.dispose();
});
