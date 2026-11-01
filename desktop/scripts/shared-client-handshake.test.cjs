// SPDX-License-Identifier: MIT
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Client}=require('../scope-extension/resources/embedded-core/client.cjs');
test('concurrent first requests wait for the full handshake, not just an open socket',async()=>{
 const client=new Client({}),sent=[];let release;
 client.connectOnce=async()=>{client.socket={destroyed:false};await new Promise(r=>release=r);client.ready=true;};
 client.send=async method=>{sent.push(method);return method;};
 const first=client.request('linkInbox');await new Promise(setImmediate);
 const second=client.request('catalog');await new Promise(setImmediate);
 assert.deepEqual(sent,[]);release();assert.deepEqual(await Promise.all([first,second]),['linkInbox','catalog']);
 assert.deepEqual(sent,['linkInbox','catalog']);
});
test('failed handshake does not replay business operations and a later request starts a fresh connection',async()=>{
 const client=new Client({});let connects=0,sends=0;
 client.connectOnce=async()=>{connects++;if(connects===1)throw Object.assign(new Error('bad handshake'),{code:'versionMismatch'});client.socket={destroyed:false};client.ready=true;};
 client.send=async()=>{sends++;return true;};
 await assert.rejects(client.request('build'),{code:'versionMismatch'});assert.equal(sends,0);
 assert.equal(await client.request('catalog'),true);assert.equal(connects,2);assert.equal(sends,1);
});
