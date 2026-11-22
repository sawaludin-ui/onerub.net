import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Wallet, Signature } from 'ethers';
import { randomBytes } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as client from '../lib/marketplace-metadata-client.mjs';
import {canonical, hash, issueChallenge, verifyAuthorization, deployment, sanitizeMetadata} from '../lib/marketplace-core.mjs';
import { METADATA_FIELDS } from '../lib/marketplace-action-contract.mjs';

process.env.MARKETPLACE_AUTH_SECRET = randomBytes(32).toString('hex');
const require = createRequire(import.meta.url);
const metadata = {title:'Local test brief',description:'A sufficiently long public description for local tests only.',rubric:'Check the complete factual result against this public rubric.',category:'testing'};
const wallet = Wallet.createRandom();
const task = {id:'42',requester:wallet.address,criteriaHash:client.metadataHash(metadata),metadata};
const result = client.validateOriginalMetadata(JSON.stringify(metadata),task.criteriaHash);
const context = {task,chainId:56,escrowAddress:deployment.address,payloadHash:result.payloadHash};
function challenge() { return issueChallenge({address:wallet.address,action:'metadata',taskId:task.id,payloadHash:result.payloadHash}); }
function providerFor({signer=wallet,chain='0x38',reject=false}={}) {
  const calls = [];
  return {calls,async request({method,params}) {
    calls.push(method);
    if (method==='eth_requestAccounts' || method==='eth_accounts') return [signer.address];
    if (method==='eth_chainId') return chain;
    if (method==='eth_signTypedData_v4') {
      if(reject) throw Object.assign(new Error('private provider detail'),{code:4001});
      assert.equal(params[0],wallet.address);
      const typed = JSON.parse(params[1]);
      return signer.signTypedData(typed.domain,{Authorization:typed.types.Authorization},typed.message);
    }
    throw new Error('Forbidden provider method '+method);
  }};
}
test('canonical metadata and envelope hashes exactly match server canonical implementation',()=>{
  const reverse = Object.fromEntries(Object.entries(metadata).reverse());
  assert.equal(client.canonicalMetadataJSON(reverse),canonical(metadata));
  assert.equal(client.metadataHash(reverse),hash(metadata));
  assert.equal(result.payloadHash,hash({metadata}));
  assert.notEqual(result.payloadHash,result.hash);
  const nested={z:[{z:1,a:'é\n'}],a:null};
  assert.equal(client.canonicalMetadataJSON(nested),canonical(nested));
});
test('only original matching schema is accepted, never guessed or altered brief',()=>{
  for(const [input,code] of [['{','METADATA_JSON'],['null','METADATA_REQUIRED'],[JSON.stringify({...metadata,title:'bad'}),'METADATA_FIELD_INVALID'],[JSON.stringify({...metadata,solution:'never upload'}),'METADATA_FIELDS'],[JSON.stringify({...metadata,description:metadata.description+'changed'}),'CRITERIA_HASH_MISMATCH']]) {
    assert.throws(()=>client.validateOriginalMetadata(input,task.criteriaHash),{code});
  }
});
test('shared field boundaries and whitespace exactly match backend sanitizer without trimming',()=>{
  for (const [key,min,max] of METADATA_FIELDS) {
    for (const length of [min,max]) {
      const original={...metadata,[key]:'x'.repeat(length)};
      const checked=client.validateOriginalMetadata(JSON.stringify(original),hash(original));
      assert.deepEqual(checked.metadata,sanitizeMetadata(original));
    }
    for (const length of [min-1,max+1]) {
      const original={...metadata,[key]:'x'.repeat(length)};
      assert.throws(()=>client.validateOriginalMetadata(JSON.stringify(original),hash(original)),{code:'METADATA_FIELD_INVALID'});
      assert.throws(()=>sanitizeMetadata(original),{code:'METADATA_FIELD_INVALID'});
    }
  }
  const original=Object.fromEntries(Object.entries(metadata).map(([k,v])=>[k,'  '+v+'  ']));
  const checked=client.validateOriginalMetadata(JSON.stringify(original),hash(original));
  assert.deepEqual(checked.metadata,sanitizeMetadata(original));
  assert.equal(checked.metadata.title,'  '+metadata.title+'  ');
  assert.throws(()=>client.validateOriginalMetadata(JSON.stringify(original),hash(metadata)),{code:'CRITERIA_HASH_MISMATCH'});
});
test('request abort fallback works without new AbortSignal APIs and cleans timers/listeners',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const saved=[['timeout',Object.getOwnPropertyDescriptor(AbortSignal,'timeout')],['any',Object.getOwnPropertyDescriptor(AbortSignal,'any')]];
  const oldThrow=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'throwIfAborted');
  for (const [key] of saved) Object.defineProperty(AbortSignal,key,{configurable:true,value:undefined});
  Object.defineProperty(AbortSignal.prototype,'throwIfAborted',{configurable:true,value:undefined});
  try {
    const external=new AbortController(); let added=0,removed=0;
    const add=external.signal.addEventListener.bind(external.signal), remove=external.signal.removeEventListener.bind(external.signal);
    t.mock.method(external.signal,'addEventListener',(...args)=>{added++;return add(...args);});
    t.mock.method(external.signal,'removeEventListener',(...args)=>{removed++;return remove(...args);});
    for (const kind of ['success','http-error','invalid-json','network-error']) {
      let combined;
      const request=client.metadataRequest('/local-only',{signal:external.signal,fetcher:async(_,options)=>{
        combined=options.signal;
        if(kind==='network-error') throw Error('offline');
        if(kind==='http-error') return Response.json({code:'STORAGE_UNAVAILABLE'},{status:503});
        if(kind==='invalid-json') return new Response('not json');
        return Response.json({ok:true});
      }});
      if(kind==='success') assert.deepEqual(await request,{ok:true});
      else await assert.rejects(request,{code:{'http-error':'STORAGE_UNAVAILABLE','invalid-json':'INVALID_RESPONSE','network-error':'NETWORK_UNAVAILABLE'}[kind]});
      t.mock.timers.tick(20000);
      assert.equal(combined.aborted,false,'finished request timer must be cleared: '+kind);
      assert.equal(added,removed,'external abort listener must be removed: '+kind);
    }
    let timedSignal;
    const timeoutRequest=client.metadataRequest('/local-only',{signal:external.signal,fetcher:(_,options)=>{
      timedSignal=options.signal;
      return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true}));
    }});
    const timedRejection=assert.rejects(timeoutRequest,{code:'NETWORK_UNAVAILABLE'});
    t.mock.timers.tick(19999); assert.equal(timedSignal.aborted,false);
    t.mock.timers.tick(1); assert.equal(timedSignal.aborted,true);
    await timedRejection; assert.equal(added,removed);
    let forwardedSignal;
    const abortedRequest=client.metadataRequest('/local-only',{signal:external.signal,fetcher:(_,options)=>{
      forwardedSignal=options.signal;
      return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true}));
    }});
    const abortedRejection=assert.rejects(abortedRequest,{name:'AbortError'});
    external.abort(); assert.equal(forwardedSignal.aborted,true);
    await abortedRejection; assert.equal(added,removed);
  } finally {
    for (const [key,descriptor] of saved) if(descriptor) Object.defineProperty(AbortSignal,key,descriptor); else delete AbortSignal[key];
    if(oldThrow) Object.defineProperty(AbortSignal.prototype,'throwIfAborted',oldThrow); else delete AbortSignal.prototype.throwIfAborted;
    t.mock.timers.reset();
  }
});
test('explicit mock EIP1193 wallet signs real EIP712 accepted by real server verifier',async()=>{
  const provider=providerFor();
  assert.deepEqual(provider.calls,[]);
  assert.equal(await client.connectMetadataWallet(provider,task.requester),wallet.address);
  assert.deepEqual(provider.calls,['eth_requestAccounts','eth_chainId']);
  const c=challenge(); const auth=await client.signMetadataChallenge(provider,c,context);
  assert.equal(auth.typedData,undefined);
  assert.equal(auth.signature.length,132);
  const storage={async put(){return true;}};
  assert.equal(await verifyAuthorization(auth,'metadata',task.id,result.payload,{storage,eligible:async()=>true}),wallet.address);
  assert.deepEqual(provider.calls,['eth_requestAccounts','eth_chainId','eth_accounts','eth_chainId','eth_signTypedData_v4']);
  const compact=Signature.from(auth.signature).compactSerialized;
  assert.equal(client.signedMetadataAuth(c,compact).signature,auth.signature);
  const recoveryByte=Signature.from(auth.signature).yParity.toString(16).padStart(2,'0');
  assert.equal(client.signedMetadataAuth(c,auth.signature.slice(0,-2)+recoveryByte).signature,auth.signature);
});
test('wrong wallet, wrong chain, corrupted challenge, expired auth and rejection never publish',async()=>{
  await assert.rejects(client.connectMetadataWallet(providerFor({signer:Wallet.createRandom()}),wallet.address),{code:'REQUESTER_ONLY'});
  const wrongChain=providerFor({chain:'0x1'});
  await assert.rejects(client.signMetadataChallenge(wrongChain,challenge(),context),{code:'WRONG_CHAIN'});
  assert.ok(!wrongChain.calls.includes('eth_signTypedData_v4'));
  const c=challenge(); c.typedData.message.action='upload';
  const p=providerFor();
  await assert.rejects(client.signMetadataChallenge(p,c,context),{code:'INVALID_CHALLENGE'}); assert.deepEqual(p.calls,[]);
  const expired=challenge(); expired.expiresAt=1;
  assert.throws(()=>client.validateMetadataChallenge(expired,context),{code:'CHALLENGE_EXPIRED'});
  await assert.rejects(client.signMetadataChallenge(providerFor({reject:true}),challenge(),context),{code:4001});
});
test('stale task abort cancels before signing and manual signature must belong to requester',async()=>{
  const controller=new AbortController(); const calls=[];
  const provider={async request({method}) { calls.push(method); controller.abort(); return [wallet.address]; }};
  await assert.rejects(client.signMetadataChallenge(provider,challenge(),{...context,signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(calls,['eth_accounts']);
  const c=challenge(); const other=Wallet.createRandom();
  const signature=await other.signTypedData(c.typedData.domain,{Authorization:c.typedData.types.Authorization},c.typedData.message);
  assert.throws(()=>client.signedMetadataAuth(c,signature),{code:'REQUESTER_ONLY'});
  let fetches=0;
  await assert.rejects(client.metadataRequest('/local-only',{signal:controller.signal,fetcher:async()=>{fetches++;}}),{name:'AbortError'});
  assert.equal(fetches,0);
});
test('publication uses canonical envelope and success requires independent fresh public readback',async()=>{
  const c=challenge(); const auth=await client.signMetadataChallenge(providerFor(),c,context);
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push([url,options]);
    if(options.method==='POST'){
      const body=JSON.parse(options.body);
      assert.deepEqual(body.payload,{metadata}); assert.equal(body.auth.typedData,undefined);
      assert.equal(await verifyAuthorization(body.auth,'metadata',task.id,body.payload,{storage:{async put(){return true;}},eligible:async()=>true}),wallet.address);
      return Response.json({registered:true,criteriaHash:task.criteriaHash});
    }
    return Response.json({task});
  };
  assert.equal((await client.publishMetadataAndReadBack({...context,payload:result.payload,auth,fetcher})).id,task.id);
  assert.equal(calls.length,2); assert.match(calls[1][0],/chainId=56/); assert.equal(calls[1][1].cache,'no-store');
  await assert.rejects(client.publishMetadataAndReadBack({...context,payload:result.payload,auth,fetcher:async(_,o)=>Response.json(o.method==='POST'?{registered:true}:{task:{...task,metadata:null}})}),{code:'METADATA_REQUIRED'});
  await assert.rejects(client.publishMetadataAndReadBack({...context,payload:result.payload,auth,fetcher:async(_,o)=>Response.json(o.method==='POST'?{registered:true}:{task:{...task,metadata:{...metadata,title:'Tampered brief'}}})}),{code:'CRITERIA_HASH_MISMATCH'});
});
test('replay only succeeds after matching readback, upstream errors never auto-retry',async()=>{
  const auth=await client.signMetadataChallenge(providerFor(),challenge(),context);
  let calls=0;
  const read=await client.publishMetadataAndReadBack({...context,payload:result.payload,auth,fetcher:async(_,o)=>{calls++;return o.method==='POST'?Response.json({code:'REPLAY'},{status:409}):Response.json({task});}});
  assert.equal(read.id,task.id); assert.equal(calls,2);
  calls=0;
  await assert.rejects(client.publishMetadataAndReadBack({...context,payload:result.payload,auth,fetcher:async()=>{calls++;return Response.json({code:'STORAGE_UNAVAILABLE',retryable:true},{status:503});}}),{code:'STORAGE_UNAVAILABLE'});
  assert.equal(calls,1);
});
test('errors do not dump provider secrets, raw server messages or arbitrary fields',()=>{
  assert.doesNotMatch(client.safeMetadataError({message:'secret token',field:'secret token',code:'<script>'}),/secret|script/);
  assert.match(client.safeMetadataError({code:'METADATA_FIELD_INVALID',field:'rubric'}),/METADATA_FIELD_INVALID.*rubric/);
  assert.match(client.safeMetadataError({code:4001,message:'private'}),/WALLET_REJECTED/);
});
test('JSX parses and server rendering makes zero wallet/network prompts; JSON is text escaped',async()=>{
  const source=readFileSync(new URL('../app/components/MetadataPublisher.js',import.meta.url),'utf8');
  require('next/dist/compiled/babel/parser').parse(source,{sourceType:'module',plugins:['jsx']});
  const {code}=require('next/dist/build/swc').transformSync(source,{filename:'MetadataPublisher.js',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'automatic'}}},module:{type:'commonjs'}});
  const module={exports:{}};
  const localRequire=name=>name.endsWith('marketplace-metadata-client.mjs')?client:require(name);
  new Function('require','module','exports',code)(localRequire,module,module.exports);
  let calls=0;
  globalThis.window={ethereum:{request(){calls++;throw Error('No render prompts');}}};
  try {
    const html=renderToStaticMarkup(React.createElement(module.exports.default,{task,chainId:56,escrowAddress:deployment.address}));
    assert.match(html,/Sign metadata &amp; publish/); assert.equal(calls,0);
    assert.doesNotMatch(html,/role="alert"/);
    const dangerous={...metadata,description:'<script>alert(1)</script> public text only'};
    const verified=renderToStaticMarkup(React.createElement(module.exports.MetadataIntegrity,{task:{...task,metadata:dangerous,criteriaHash:client.metadataHash(dangerous)}}));
    assert.match(verified,/MATCH — displayed metadata/); assert.doesNotMatch(verified,/<script>/); assert.match(verified,/&lt;script&gt;/);
    const missing=renderToStaticMarkup(React.createElement(module.exports.MetadataIntegrity,{task:{...task,metadata:null,policyVerified:true}}));
    assert.match(missing,/Brief not published/);
    assert.doesNotMatch(source,/eth_sendTransaction|personal_sign|wallet_switchEthereumChain/);
    assert.match(source,/locked.current/); assert.ok(source.includes('active.current?.abort'));
  } finally { delete globalThis.window; }
});
