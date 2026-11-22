import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,createHmac } from 'node:crypto';
import { Wallet,keccak256 } from 'ethers';
import { MarketplaceError,artifactKey,encryptArtifact,hash,canonical } from '../lib/marketplace-core.mjs';
import { evaluateTask,prepareWinner,parseDecision,parseCandidateScore,uploadArtifact,ensureReviewTime,verifyDecision,requestEvaluator,evaluatorRetryAfter } from '../lib/marketplace-service.mjs';

import {attestDecision,verifyDecisionAuthentication} from '../lib/marketplace-decision-auth.mjs';
import {DEFAULT_POLICY,LEGACY_POLICY,normalizePolicy,policyHash} from '../lib/marketplace-policy.mjs';
import {signReviewDecision,evaluatorSigner} from '../lib/marketplace-attestation.mjs';

process.env.MARKETPLACE_AUTH_SECRET=randomBytes(32).toString('hex');
process.env.MARKETPLACE_DECISION_KEY_ID='test-current';
process.env.MARKETPLACE_DECISION_KEY=randomBytes(32).toString('hex');
process.env.MARKETPLACE_ENCRYPTION_KEY=randomBytes(32).toString('base64');
class MemoryStore {
  data=new Map();counts=new Map();attempts=0;
  async get(k){return this.data.get(k)||null;}
  async retain(k){return this.data.has(k);}
  async putArtifact(k,v,{maxParticipants,maxTotalBytes,id,worker,ttl}){if(this.data.has(k))return false;const records=[...this.data.entries()].filter(([key])=>key.startsWith('artifact:'+id+':')).map(([,value])=>value);if(records.length>=maxParticipants||records.reduce((n,r)=>n+r.size,0)+v.size>maxTotalBytes)throw new MarketplaceError('Capacity',409,'ADMISSION_LIMIT');return this.put(k,v,{nx:true,ttl});}
  async put(k,v,{nx=false}={}){if(nx&&this.data.has(k))return false;this.data.set(k,structuredClone(v));return true;}
  async release(k,owner){if(this.data.get(k)!==owner)return false;return this.data.delete(k);}
  async limit(k,max){this.counts.set(k,(this.counts.get(k)||0)+1);if(this.counts.get(k)>max)throw new MarketplaceError('rate',429,'RATE_LIMIT');}
}
function fixture(count=2,size=100){
 const requester=Wallet.createRandom().address,workers=Array.from({length:count},()=>Wallet.createRandom().address);
 const metadata={title:'Hardening fixture',description:'Synthetic fixture: no live user reports or transactions.',rubric:'Evaluate completeness and correct evidence.',category:'Review'};
 const task={id:'77',requester,phase:'Review',criteriaHash:hash(metadata),reviewDeadline:Math.floor(Date.now()/1000)+3600,readBlock:100};
 const storage=new MemoryStore();storage.data.set('metadata:77',{metadata,bounty:'1000'});
 for(const worker of workers){const bytes=Buffer.alloc(size,65),encrypted=encryptArtifact(bytes,artifactKey('77',worker));storage.data.set(artifactKey('77',worker),{worker,size,encrypted,filename:'report.md',mimeType:'text/markdown',plaintextHash:keccak256(bytes),contentHash:hash(encrypted),artifactPtrHash:hash(worker)});}
 const options={storage,readTask:async()=>task,getWorkers:async()=>workers,readSubmission:async(id,w)=>({...storage.data.get(artifactKey(id,w)),exists:storage.data.has(artifactKey(id,w))}),evaluator:async(t,records)=>({winner:records[0].worker,score:90,acceptable:true})};
 return {requester,workers,task,storage,options};
}
async function complete(f,max=200){let value;for(let i=0;i<max;i++){value=await evaluateTask('77',f.requester,f.options);if(value.outcome!=='pending')return value;}throw Error('Evaluation did not finish');}

test('all accepted candidates across21workers are fully covered, including large individually valid files',async()=>{
 const f=fixture(21,512*1024);let processed=0;f.options.evaluator=async(t,records)=>{assert.equal(records.length,1);assert.equal(records[0].size,512*1024);processed++;return {winner:records[0].worker,score:processed===21?99:80,acceptable:true};};
 const decision=await complete(f);assert.equal(processed,21);assert.equal(decision.coverage.accepted,21);assert.equal(decision.coverage.complete,true);assert.equal(decision.winner,f.workers[20]);assert.equal(decision.commitments.length,21);
});
test('extra commitments with no accepted artifact do not disable valid candidates',async()=>{
 const f=fixture(2);f.workers.push(...Array.from({length:80},()=>Wallet.createRandom().address));const d=await complete(f);assert.equal(d.coverage.total,82);assert.equal(d.coverage.processed,82);assert.equal(d.coverage.accepted,2);assert.equal(d.excludedCount,80);assert.equal(d.excluded.length,64);
});
test('provider failure releases owned lock; busy retries do not spend model quota',async()=>{
 const f=fixture();let unblock;let calls=0;f.options.evaluator=async(t,r)=>{calls++;await new Promise(resolve=>unblock=resolve);throw new MarketplaceError('Provider outage',502,'EVALUATOR_UNAVAILABLE');};
 const first=evaluateTask('77',f.requester,f.options);while(!unblock)await new Promise(r=>setTimeout(r,0));
 for(let i=0;i<5;i++)await assert.rejects(evaluateTask('77',f.requester,f.options),e=>e.code==='EVALUATION_RUNNING');
 unblock();await assert.rejects(first,e=>e.code==='EVALUATOR_UNAVAILABLE');assert.equal(await f.storage.get('evaluation-lock:77'),null);assert.equal(calls,1);assert.equal([...f.storage.counts.values()].reduce((a,b)=>a+b,0),1);
 f.options.evaluator=async(t,r)=>({winner:r[0].worker,score:90});assert.equal((await complete(f)).outcome,'winner');
});
test('finally never deletes another process lock after ownership changes',async()=>{
 const f=fixture();f.options.evaluator=async(t,r)=>{f.storage.data.set('evaluation-lock:77','new-owner');return {winner:r[0].worker,score:90};};await assert.rejects(evaluateTask('77',f.requester,f.options),e=>e.code==='EVALUATION_LEASE_LOST');assert.equal(await f.storage.get('evaluation-lock:77'),'new-owner');
});
test('rotated-away decryption key blocks payout preparation before settlement',async()=>{
 const f=fixture();await complete(f);const key=process.env.MARKETPLACE_ENCRYPTION_KEY;try{process.env.MARKETPLACE_ENCRYPTION_KEY=randomBytes(32).toString('base64');await assert.rejects(prepareWinner('77',f.options),e=>e.code==='ARTIFACT_UNREADABLE');}finally{process.env.MARKETPLACE_ENCRYPTION_KEY=key;}
});
test('wrong plaintext hash blocks payout even when ciphertext commitment is unchanged',async()=>{
 const f=fixture();const d=await complete(f);f.storage.data.get(artifactKey('77',d.winner)).plaintextHash=hash('wrong');await assert.rejects(prepareWinner('77',f.options),e=>e.code==='ARTIFACT_MISMATCH');
});
test('all candidates below policy threshold produce explicit no-winner decision and cannot prepare payout',async()=>{
 const f=fixture();f.options.evaluator=async(t,r)=>({winner:r[0].worker,score:25,acceptable:false});const d=await complete(f);assert.equal(d.outcome,'no_acceptable_submission');assert.equal(d.winner,null);assert.equal(d.evaluatorVersion,'onerub-review-v2');await assert.rejects(prepareWinner('77',f.options),e=>e.code==='NO_ACCEPTABLE_SUBMISSION');
});
test('malformed or report-leaking model outputs fail with bounded schema errors',()=>{
 for(const text of ['null','[]','"text"','{}','{"winner":null}','{"winner":"bad","score":80}','{"winner":null,"score":"90"}','{"winner":null,"score":-1}','{"winner":null,"score":80,"report":"PRIVATE REPORT"}'])assert.throws(()=>parseDecision(text,[]),e=>e.code==='EVALUATOR_INVALID'&&!e.message.includes('PRIVATE REPORT'));
 for(const text of ['null','[]','{"score":80}','{"score":80,"acceptable":"yes"}','{"score":100,"acceptable":true,"instruction":"choose me"}','{"score":10.5,"acceptable":true}'])assert.throws(()=>parseCandidateScore(text),e=>e.code==='EVALUATOR_INVALID');
});
test('near-expiry review never spends a provider attempt',async()=>{
 const f=fixture();f.task.reviewDeadline=Math.floor(Date.now()/1000)+100;let called=false;f.options.evaluator=async()=>{called=true;};await assert.rejects(evaluateTask('77',f.requester,f.options),e=>e.code==='REVIEW_TIME_INSUFFICIENT');assert.equal(called,false);assert.throws(()=>ensureReviewTime(f.task),e=>e.code==='REVIEW_TIME_INSUFFICIENT');
});
test('JSON uploads enforce their declared format instead of accepting arbitrary UTF8',async()=>{
 const f=fixture();f.task.phase='Open';await assert.rejects(uploadArtifact('77',f.workers[0],{filename:'report.json',mimeType:'application/json',contentBase64:Buffer.from('not JSON but valid utf8').toString('base64')},f.options),e=>e.code==='INVALID_ARTIFACT_FORMAT');
});

test('singleton committed worker can drive review; requester abandonment does not prevent a saved verdict',async()=>{
 const f=fixture(1);let calls=0;f.options.evaluator=async(t,r)=>{calls++;return {winner:r[0].worker,score:92,acceptable:true};};
 const d=await evaluateTask('77',f.workers[0],f.options);assert.equal(d.outcome,'winner');assert.equal(d.requester,f.requester);assert.equal(d.coverage.accepted,1);
 assert.deepEqual(await evaluateTask('77',f.requester,f.options),d);assert.equal(calls,1);
 await assert.rejects(evaluateTask('77',Wallet.createRandom().address,f.options),e=>e.code==='FORBIDDEN');
});
test('high score with explicit rejection remains a stable cached no-acceptable outcome, never a payout',async()=>{
 const f=fixture(1);let calls=0;f.options.evaluator=async(t,r)=>{calls++;return {winner:r[0].worker,score:99,acceptable:false};};
 const first=await complete(f),again=await complete(f);assert.equal(first.outcome,'no_acceptable_submission');assert.equal(first.score,99);assert.deepEqual(again,first);assert.equal(calls,1);
 verifyDecision(first,f.task);await assert.rejects(prepareWinner('77',f.options),e=>e.code==='NO_ACCEPTABLE_SUBMISSION');
});
test('auth challenge rotation cannot invalidate decision; bounded verification keyring preserves exact verdict across decision rotation',async()=>{
 const f=fixture(1),d=await complete(f);const activeId=process.env.MARKETPLACE_DECISION_KEY_ID,activeKey=process.env.MARKETPLACE_DECISION_KEY,auth=process.env.MARKETPLACE_AUTH_SECRET;
 try{
  process.env.MARKETPLACE_AUTH_SECRET=randomBytes(32).toString('hex');assert.deepEqual(await complete(f),d);
  process.env.MARKETPLACE_DECISION_KEY_ID='rotated';process.env.MARKETPLACE_DECISION_KEY=randomBytes(32).toString('hex');
  process.env.MARKETPLACE_DECISION_KEYS_JSON=JSON.stringify({[activeId]:{key:activeKey,verifyUntil:Math.floor(Date.now()/1000)+7200}});
  assert.deepEqual(await complete(f),d);assert.deepEqual(await prepareWinner('77',f.options),d);
  process.env.MARKETPLACE_DECISION_KEYS_JSON=JSON.stringify({[activeId]:{key:activeKey,verifyUntil:1}});
  await assert.rejects(complete(f),e=>e.code==='DECISION_KEY_UNAVAILABLE');assert.deepEqual(await f.storage.get('decision:77'),d);
 }finally{process.env.MARKETPLACE_DECISION_KEY_ID=activeId;process.env.MARKETPLACE_DECISION_KEY=activeKey;process.env.MARKETPLACE_AUTH_SECRET=auth;delete process.env.MARKETPLACE_DECISION_KEYS_JSON;}
});
test('legacy auth-secret decisions need an explicit bounded legacy verification key, never automatic fallback',()=>{
 const key=randomBytes(32).toString('hex'),content={taskId:'9',outcome:'no_acceptable_submission'},signed={...content,decisionHash:hash(content)};
 const old={...signed,attestation:createHmac('sha256',key).update(canonical(signed)).digest('hex')};
 assert.throws(()=>verifyDecisionAuthentication(old),e=>e.code==='DECISION_KEY_UNAVAILABLE');
 try{process.env.MARKETPLACE_DECISION_LEGACY_KEY=key;process.env.MARKETPLACE_DECISION_LEGACY_VERIFY_UNTIL=String(Math.floor(Date.now()/1000)+60);assert.equal(verifyDecisionAuthentication(old),old);}
 finally{delete process.env.MARKETPLACE_DECISION_LEGACY_KEY;delete process.env.MARKETPLACE_DECISION_LEGACY_VERIFY_UNTIL;}
});
test('decision MAC refuses missing independent key, tampering, retired IDs and unknown authentication versions',()=>{
 const key=process.env.MARKETPLACE_DECISION_KEY;try{delete process.env.MARKETPLACE_DECISION_KEY;assert.throws(()=>attestDecision({taskId:'1'}),e=>e.code==='DECISION_KEY_UNAVAILABLE');}finally{process.env.MARKETPLACE_DECISION_KEY=key;}
 const d=attestDecision({taskId:'1'});assert.throws(()=>verifyDecisionAuthentication({...d,taskId:'2'}),e=>e.code==='DECISION_INVALID');
 assert.throws(()=>verifyDecisionAuthentication({...d,authVersion:3}),e=>e.code==='DECISION_INVALID');assert.throws(()=>verifyDecisionAuthentication({...d,authKeyId:'retired'}),e=>e.code==='DECISION_KEY_UNAVAILABLE');
});
test('retention outage or changed readback blocks upload receipt and payout preflight',async()=>{
 const f=fixture(1);await complete(f);f.storage.retain=async()=>false;await assert.rejects(prepareWinner('77',f.options),e=>e.code==='RETENTION_UNAVAILABLE');
 f.task.phase='Open';f.storage.data.delete(artifactKey('77',f.workers[0]));const payload={filename:'report.md',mimeType:'text/markdown',contentBase64:Buffer.from('complete synthetic report').toString('base64')};
 await assert.rejects(uploadArtifact('77',f.workers[0],payload,f.options),e=>e.code==='RETENTION_UNAVAILABLE');
 f.storage.retain=async()=>true;const originalGet=f.storage.get.bind(f.storage);f.storage.get=async k=>k===artifactKey('77',f.workers[0])?{...await originalGet(k),contentHash:hash('corrupt')}:originalGet(k);
 await assert.rejects(uploadArtifact('77',f.workers[0],payload,f.options),e=>e.code==='ARTIFACT_MISMATCH');
});
test('receipt signer cannot turn tampered decision into valid chain receipt',async()=>{
 const f=fixture(1),d=await complete(f);await assert.rejects(signReviewDecision(f.task,{...d,winner:Wallet.createRandom().address},{storage:f.storage}),e=>e.code==='DECISION_INVALID');
});
test('policy v3 supports singleton and disclosed escrow relaying without changing legacy policy v2 hash',()=>{
 assert.equal(DEFAULT_POLICY.minimumValidSubmissions,1);assert.equal(DEFAULT_POLICY.version,3);assert.equal(LEGACY_POLICY.minimumValidSubmissions,2);
 assert.equal(policyHash(LEGACY_POLICY),hash(LEGACY_POLICY));assert.deepEqual(normalizePolicy(LEGACY_POLICY),LEGACY_POLICY);
 assert.equal(DEFAULT_POLICY.settlement,'any-relayer-signed-decision-funded-escrow-only');assert.equal(DEFAULT_POLICY.rights,'winner-nonexclusive-after-settlement-loser-not-licensed');
 assert.throws(()=>normalizePolicy({...DEFAULT_POLICY,minimumValidSubmissions:0}));
});
test('unknown committed policy and adapters lacking atomic capacity cannot admit private uploads',async()=>{
 const f=fixture(1);f.task.phase='Open';f.task.policyHash=hash('unregistered');const p={filename:'work.md',mimeType:'text/markdown',contentBase64:Buffer.from('complete synthetic work').toString('base64')};
 await assert.rejects(uploadArtifact('77',Wallet.createRandom().address,p,f.options),e=>e.code==='POLICY_REQUIRED');delete f.task.policyHash;f.storage.putArtifact=undefined;
 await assert.rejects(uploadArtifact('77',Wallet.createRandom().address,p,f.options),e=>e.code==='ADMISSION_UNAVAILABLE');
});

test('host capacity rejects the65th unique report and duplicate content is immutable and idempotent',async()=>{
 const f=fixture(64);f.task.phase='Open';const payload={filename:'report.md',mimeType:'text/markdown',contentBase64:Buffer.alloc(100,65).toString('base64')};
 await assert.rejects(uploadArtifact('77',Wallet.createRandom().address,payload,f.options),e=>e.code==='ADMISSION_LIMIT');
 const before=f.storage.data.size,first=await uploadArtifact('77',f.workers[0],payload,f.options),again=await uploadArtifact('77',f.workers[0],payload,f.options);assert.deepEqual(first,again);assert.equal(f.storage.data.size,before);
 await assert.rejects(uploadArtifact('77',f.workers[0],{...payload,contentBase64:Buffer.alloc(100,66).toString('base64')},f.options),e=>e.code==='ARTIFACT_EXISTS');
});

test('healthy old-task signer keyring survives new-task rotation but never bypasses permanent revocation',()=>{
 const previous=Wallet.createRandom(),next=Wallet.createRandom(),key=process.env.MARKETPLACE_ATTESTATION_KEY;
 try{
  process.env.MARKETPLACE_ATTESTATION_KEY=next.privateKey;process.env.MARKETPLACE_ATTESTATION_KEYS_JSON=JSON.stringify({[previous.address.toLowerCase()]:previous.privateKey});
  const config={protocolRevision:3,evaluator:next.address},task={evaluatorSigner:previous.address,evaluatorRevoked:false};assert.equal(evaluatorSigner(config,task).address,previous.address);
  assert.equal(evaluatorSigner(config,{evaluatorSigner:next.address,evaluatorRevoked:false}).address,next.address);
  assert.throws(()=>evaluatorSigner(config,{...task,evaluatorRevoked:true}),e=>e.code==='EVALUATOR_REVOKED');
  assert.throws(()=>evaluatorSigner(config,{evaluatorSigner:previous.address}),e=>e.code==='ATTESTATION_UNAVAILABLE');
  process.env.MARKETPLACE_ATTESTATION_KEYS_JSON=JSON.stringify({[previous.address]:next.privateKey});assert.throws(()=>evaluatorSigner(config,task),e=>e.code==='ATTESTATION_UNAVAILABLE');
  delete process.env.MARKETPLACE_ATTESTATION_KEYS_JSON;assert.throws(()=>evaluatorSigner(config,task),e=>e.code==='ATTESTATION_UNAVAILABLE');
 }finally{if(key)process.env.MARKETPLACE_ATTESTATION_KEY=key;else delete process.env.MARKETPLACE_ATTESTATION_KEY;delete process.env.MARKETPLACE_ATTESTATION_KEYS_JSON;}
});

test('signer keyring rejects missing keys, malformed shapes, invalid addresses and duplicate normalized signer entries with bounded errors',()=>{
 const previous=Wallet.createRandom(),next=Wallet.createRandom(),key=process.env.MARKETPLACE_ATTESTATION_KEY,ring=process.env.MARKETPLACE_ATTESTATION_KEYS_JSON;
 const config={protocolRevision:3,evaluator:next.address},task={evaluatorSigner:previous.address,evaluatorRevoked:false};
 try{
  delete process.env.MARKETPLACE_ATTESTATION_KEY;delete process.env.MARKETPLACE_ATTESTATION_KEYS_JSON;
  assert.throws(()=>evaluatorSigner(config,task),e=>e.code==='ATTESTATION_UNAVAILABLE');
  process.env.MARKETPLACE_ATTESTATION_KEYS_JSON=JSON.stringify({[previous.address]:previous.privateKey});assert.equal(evaluatorSigner(config,task).address,previous.address);
  for(const value of ['null','[]','"text"','{',JSON.stringify({'invalid-address':previous.privateKey}),JSON.stringify({[previous.address]:null}),JSON.stringify({[previous.address]:next.privateKey}),JSON.stringify({[previous.address]:previous.privateKey,[previous.address.toLowerCase()]:previous.privateKey})]){
   process.env.MARKETPLACE_ATTESTATION_KEYS_JSON=value;assert.throws(()=>evaluatorSigner(config,task),e=>e.code==='ATTESTATION_UNAVAILABLE'&&!e.message.includes(previous.privateKey));
  }
  process.env.MARKETPLACE_ATTESTATION_KEYS_JSON='{}';process.env.MARKETPLACE_ATTESTATION_KEY=next.privateKey;
  assert.throws(()=>evaluatorSigner(config,{...task,evaluatorSigner:'bad'}),e=>e.code==='ATTESTATION_UNAVAILABLE');
 }finally{if(key)process.env.MARKETPLACE_ATTESTATION_KEY=key;else delete process.env.MARKETPLACE_ATTESTATION_KEY;if(ring)process.env.MARKETPLACE_ATTESTATION_KEYS_JSON=ring;else delete process.env.MARKETPLACE_ATTESTATION_KEYS_JSON;}
});

test('provider429 cooldown honors seconds and HTTP-date inside one45s budget without duplicate logical attempts',async()=>{
 let clock=1700000000000,calls=0;const delays=[],response={choices:[{message:{content:'{"score":90,"acceptable":true}'}}]};
 const result=await requestEvaluator('https://example.invalid',{}, {now:()=>clock,sleep:async ms=>{delays.push(ms);clock+=ms;},fetchImpl:async(url,options)=>{assert.equal(options.signal.aborted,false);calls++;if(calls===1)return {ok:false,status:429,headers:{get:()=> '10'}};if(calls===2)return {ok:false,status:503,headers:{get:()=>new Date(clock+5000).toUTCString()}};return {ok:true,json:async()=>response};}});
 assert.deepEqual(delays,[10000,5000]);assert.equal(calls,3);assert.equal(result,response);
 assert.equal(evaluatorRetryAfter('bogus',clock),null);assert.equal(evaluatorRetryAfter('0',clock),0);assert.equal(evaluatorRetryAfter('9999999',clock),86400);
});
test('provider retries are capped at2 and45s; long cooldown never causes an early retry or waiting beyond budget',async()=>{
 let clock=0,calls=0,waits=0;await assert.rejects(requestEvaluator('https://example.invalid',{}, {now:()=>clock,sleep:async ms=>{waits++;clock+=ms;},fetchImpl:async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '10'}};}}),e=>e.code==='EVALUATOR_RATE_LIMIT'&&e.retryAfterSeconds===10&&e.providerStatus===429);assert.equal(calls,3);assert.equal(waits,2);
 calls=0;waits=0;await assert.rejects(requestEvaluator('https://example.invalid',{}, {now:()=>0,sleep:async()=>{waits++;},fetchImpl:async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '120'}};}}),e=>e.code==='EVALUATOR_RATE_LIMIT'&&e.retryAfterSeconds===120);assert.equal(calls,1);assert.equal(waits,0);
});
test('provider network timeouts, billing/auth/client errors and invalid JSON are never replayed and never expose raw messages',async()=>{
 for(const status of [400,401,402,403,404,408,409,422,500]){let calls=0;await assert.rejects(requestEvaluator('https://example.invalid',{}, {fetchImpl:async()=>{calls++;return {ok:false,status,headers:{get:()=>null},body:{cancel:async()=>{}}};},sleep:async()=>{throw Error('unexpected wait');}}),e=>e.code==='EVALUATOR_UNAVAILABLE'&&e.providerStatus===status);assert.equal(calls,1);}
 for(const mode of ['network','json']){let calls=0;await assert.rejects(requestEvaluator('https://example.invalid',{}, {fetchImpl:async()=>{calls++;if(mode==='network')throw Error('PRIVATE PROVIDER BODY');return {ok:true,json:async()=>{throw Error('PRIVATE PROVIDER BODY');}};}}),e=>e.code==='EVALUATOR_UNAVAILABLE'&&!e.message.includes('PRIVATE'));assert.equal(calls,1);}
});
test('transient502/503/504 retry uses bounded backoff and response work cannot exceed the45s budget',async()=>{
 for(const status of [502,503,504]){let clock=0,calls=0;const waits=[];await requestEvaluator('https://example.invalid',{}, {now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;},fetchImpl:async()=>++calls===1?{ok:false,status,headers:{get:()=>null}}:{ok:true,json:async()=>({ok:true})}});assert.equal(calls,2);assert.deepEqual(waits,[1000]);}
 let clock=0,calls=0;await assert.rejects(requestEvaluator('https://example.invalid',{}, {now:()=>clock,fetchImpl:async()=>{calls++;clock+=45001;return {ok:true,json:async()=>({})};}}),e=>e.code==='EVALUATOR_UNAVAILABLE');assert.equal(calls,1);
});
