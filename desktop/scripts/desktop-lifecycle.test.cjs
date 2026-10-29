// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict');
const {superviseDesktopParent}=require('../scope-extension/lib/node/nodu-desktop-lifecycle');
function fixture(overrides={}){let tick,cleared=0,stopped=0;const stop=superviseDesktopParent({electron:'fixture',parentPid:42,currentParent:()=>42,probe:()=>{},gracefulStop:()=>stopped++,schedule:callback=>{tick=callback;return{unref(){}}},clear:()=>cleared++,...overrides});return{stop,tick:()=>tick?.(),state:()=>({cleared,stopped})};}
test('browser backends are not tied to an Electron parent',()=>{const f=fixture({electron:''});f.tick();assert.equal(f.state().stopped,0);});
test('a living desktop parent keeps its backend available',()=>{const f=fixture();f.tick();assert.equal(f.state().stopped,0);f.stop();f.tick();assert.equal(f.state().stopped,0);});
test('parent reaping requests graceful cleanup exactly once',()=>{const f=fixture({currentParent:()=>1});f.tick();f.tick();assert.deepEqual(f.state(),{cleared:1,stopped:1});});
test('a vanished Windows parent requests cleanup',()=>{const f=fixture({probe:()=>{throw Object.assign(Error('gone'),{code:'ESRCH'})}});f.tick();assert.equal(f.state().stopped,1);});
test('permission uncertainty is not mistaken for an exited parent',()=>{const f=fixture({probe:()=>{throw Object.assign(Error('denied'),{code:'EPERM'})}});f.tick();assert.equal(f.state().stopped,0);});
test('an Electron backend already orphaned at startup is retired',()=>{const f=fixture({parentPid:1});assert.equal(f.state().stopped,1);});
