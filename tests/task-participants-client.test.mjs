import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { participantIdentity, normalizeParticipants, participantLabel, participantTime, shortWallet, createParticipantLoader } from '../app/components/task-participants-client.mjs';
const contract='0x0D33DD09131aC17827fA165D70daAAB4DBfC299a';
const input={id:'1',chainId:56,contract,count:2};
const fixture=(id='1')=>({taskId:id,chainId:56,escrowAddress:contract,readBlock:135528474,total:2,order:'on-chain-submission-append-order',identityBasis:'registry-at-read-block-not-historical',participants:[{ordinal:1,wallet:'0x'+'f'.repeat(40),agentId:'first-fixture.ai',identityStatus:'resolved',submittedAt:1795528800},{ordinal:2,wallet:'0x'+'1'.repeat(40),agentId:'second-fixture.ai',identityStatus:'resolved',submittedAt:1795528800}]});
const ok=body=>({ok:true,json:async()=>body});
test('participant identity and count separate caches across task/deployment changes',()=>{
 const key=participantIdentity(input).key;assert.notEqual(participantIdentity({...input,id:'2'}).key,key);assert.notEqual(participantIdentity({...input,count:3}).key,key);assert.equal(participantIdentity({...input,contract:contract.toLowerCase()}).key,key);
 for(const patch of [{id:'0'},{id:'1/../../auth'},{chainId:NaN},{contract:'not-address'},{count:65},{count:-1}])assert.throws(()=>participantIdentity({...input,...patch}));
});
test('normalization preserves append order despite equal timestamps and reversed wallet lexical order',()=>{
 const body=fixture();body.participants[0].contentHash='PRIVATE_HASH';body.participants[0].report='PRIVATE_REPORT';body.participants[0].score=100;const result=normalizeParticipants(body,input);
 assert.equal(result.rows[0].wallet,body.participants[0].wallet);assert.equal(result.rows[1].ordinal,2);assert.equal(result.rows[0].submittedAt,result.rows[1].submittedAt);assert.deepEqual(Object.keys(result.rows[0]),['ordinal','wallet','agentId','identityStatus','submittedAt']);assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(Object.isFrozen(result.rows[0]));
});
test('wrong identities, duplicates, ordinal gaps and fabricated names are rejected',()=>{
 for(const patch of [{taskId:'2'},{chainId:1},{escrowAddress:'0x'+'a'.repeat(40)},{total:3},{order:'alphabetical'},{readBlock:0}])assert.throws(()=>normalizeParticipants({...fixture(),...patch},input));
 for(const change of [b=>b.participants.reverse(),b=>b.participants[1].wallet=b.participants[0].wallet,b=>b.participants[0].ordinal=2,b=>b.participants[0].agentId='<script>.ai',b=>b.participants[0].identityStatus='winner']){const b=fixture();change(b);assert.throws(()=>normalizeParticipants(b,input));}
});
test('unknown registry values fall back to the exact wallet, not example .ai names',()=>{
 const b=fixture();b.participants[0].agentId=null;b.participants[0].identityStatus='unknown';const data=normalizeParticipants(b,input);assert.equal(participantLabel({...data,status:'ready'},0),shortWallet(b.participants[0].wallet));assert.equal(participantLabel({rows:[],status:'loading'},0),'Loading .ai…');assert.equal(participantLabel({rows:[],status:'error'},0),'Participants unavailable');assert.equal(participantLabel({rows:[],status:'ready'},0),'Awaiting confirmation');assert.match(participantTime(1795528800),/21:00:00 WIB/);assert.equal(participantTime(1e15),'Time unavailable');
});
test('all bars share one inflight request and cached result, with TTL and count refresh',async()=>{
 let calls=0,time=0;const loader=createParticipantLoader({now:()=>time,fetcher:async()=>{calls++;return ok(fixture());}});const a=loader.load(input),b=loader.load(input);assert.strictEqual(a,b);await Promise.all([a,b]);assert.equal(calls,1);await loader.load(input);assert.equal(calls,1);time=45001;await loader.load(input);assert.equal(calls,2);await loader.load({...input,count:3});assert.equal(calls,3);
});
test('HTTP errors are sanitized and briefly cached before retry',async()=>{
 let calls=0,time=0;const loader=createParticipantLoader({now:()=>time,fetcher:async()=>{calls++;throw Error('SECRET_PROVIDER_URL');}});await assert.rejects(loader.load(input),e=>!e.message.includes('SECRET'));await assert.rejects(loader.load(input));assert.equal(calls,1);time=4001;await assert.rejects(loader.load(input));assert.equal(calls,2);
});
test('client fanout is bounded while each identity gets its own ordered payload',async()=>{
 let active=0,max=0;const releases=[];const loader=createParticipantLoader({maxConcurrent:2,fetcher:async url=>{active++;max=Math.max(max,active);await new Promise(resolve=>releases.push(resolve));active--;return ok(fixture(url.split('/tasks/')[1].split('/')[0]));}});const jobs=[1,2,3,4].map(id=>loader.load({...input,id:String(id)}));await nextTurn();assert.equal(active,2);
 for(let i=0;i<4;i++){assert.ok(releases.length);releases.shift()();await nextTurn();}const result=await Promise.all(jobs);assert.equal(max,2);assert.equal(result.length,4);
});
test('fetch abort has a finite timeout and never exposes raw transport errors',async()=>{
 const loader=createParticipantLoader({timeoutMs:5,fetcher:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('PRIVATE_RPC')),{once:true}))});await assert.rejects(loader.load(input),e=>!e.message.includes('PRIVATE_RPC'));
});
