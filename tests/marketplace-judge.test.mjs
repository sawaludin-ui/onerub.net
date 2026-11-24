import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'ethers';
import {artifactKey,encryptArtifact,hash,MarketplaceError} from '../lib/marketplace-core.mjs';
import {DEFAULT_POLICY,V3_POLICY,LEGACY_POLICY,policyHash,normalizePolicy} from '../lib/marketplace-policy.mjs';
import {judgeRubric,deterministicChecks,parseJudgeScore,decisionView} from '../lib/marketplace-judge.mjs';
import {evaluateTask,runEvaluator} from '../lib/marketplace-service.mjs';
process.env.MARKETPLACE_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
process.env.MARKETPLACE_DECISION_KEY_ID='judge-fixture';
process.env.MARKETPLACE_DECISION_KEY='synthetic-decision-key-not-used-in-production-2026';
const address=n=>'0x'+n.toString(16).padStart(40,'0');
class Memory{
 data=new Map();async get(k){return structuredClone(this.data.get(k)??null);}
 async put(k,v,{nx=false}={}){if(nx&&this.data.has(k))return false;this.data.set(k,structuredClone(v));return true;}
 async release(k,v){if(this.data.get(k)===v)return this.data.delete(k);return false;}
 async limit(){}
}
const score=(rubric,n=91)=>({criteria:rubric.criteria.map(c=>({id:c.id,score:n,reasonCode:n===100?'SATISFIED':'PARTIAL'}))});
function fixture(count=2,policy=DEFAULT_POLICY,number=99){
 const storage=new Memory(),id=String(number),requester=address(99999),workers=Array.from({length:count},(_,i)=>address(count-i));
 const metadata={title:'Synthetic judge fixture',description:'Synthetic isolated input only.',category:'Review',rubric:'Assess correctness, coverage and evidence.'};
 const task={id,requester,phase:'Review',criteriaHash:hash(metadata),policyHash:policyHash(policy),readBlock:100,reviewDeadline:Math.floor(Date.now()/1000)+21600};
 storage.data.set('metadata:'+id,{metadata});storage.data.set('policy:'+task.policyHash.toLowerCase(),{policy});
 for(const worker of workers){const bytes=Buffer.from('Synthetic fixture report, no participant data.'),encrypted=encryptArtifact(bytes,artifactKey(id,worker));storage.data.set(artifactKey(id,worker),{worker,encrypted,size:bytes.length,contentHash:hash(encrypted),artifactPtrHash:hash(worker),plaintextHash:keccak256(bytes)});}
 const calls=new Map();const options={storage,readTask:async()=>task,getWorkers:async()=>workers,readSubmission:async(i,w)=>({...await storage.get(artifactKey(i,w)),exists:true}),model:'synthetic-model',evaluator:async(t,r,m)=>{const w=r[0].worker;calls.set(w,(calls.get(w)||0)+1);return policy.version===4?score(judgeRubric(m)):({winner:w,score:91,acceptable:true});}};
 return {storage,id,requester,workers,metadata,task,calls,options};
}
async function complete(f){for(let i=0;i<100;i++){const d=await evaluateTask(f.id,f.requester,f.options);if(d.outcome!=='pending')return d;}throw Error('Incomplete fixture');}
test('v4 is new default while exact historical v3 policy and address tie remain immutable',async()=>{
 assert.equal(DEFAULT_POLICY.version,4);assert.equal(DEFAULT_POLICY.minReviewWindowSeconds,21600);assert.equal(V3_POLICY.minReviewWindowSeconds,3600);assert.equal(LEGACY_POLICY.minReviewWindowSeconds,3600);
 assert.equal(policyHash(V3_POLICY),'0xf6e5ad07a9cdd43c85c82f08e6291dc35edb81d2599d8582559a9dc9ce359a71');
 assert.deepEqual(normalizePolicy(V3_POLICY),V3_POLICY);assert.throws(()=>normalizePolicy({version:99}));
 const f=fixture(2,V3_POLICY),d=await complete(f);assert.equal(d.winner,f.workers[1]);assert.equal(d.evaluatorVersion,'onerub-review-v2');assert.equal(d.commitments[0].criteria,undefined);
});
test('basis points distinguish same displayed integer and exact ties use chain append order not wallet grinding',async()=>{
 const f=fixture(3);f.options.evaluator=async(t,r,m)=>{const out=score(judgeRubric(m),90);if(r[0].worker===f.workers[0])out.criteria[1].score=91;return out;};
 const d=await complete(f);assert.equal(d.winner,f.workers[0]);assert.equal(d.score,90);assert.equal(d.scoreBasisPoints,9030);assert.equal(d.commitments[0].submissionOrder.ordinal,0);
 const tied=fixture(2),td=await complete(tied);assert.equal(td.winner,tied.workers[0]);assert.notEqual(td.winner,tied.workers[1]);
});
test('data-only public assertions compare exact UTF8 or own JSON paths, never execute code',()=>{
 const spec={protocol:'onerub-rubric-v1',criteria:[{id:'accuracy',weight:100,description:'Correct answer.'}],assertions:[{id:'answer',path:['answer'],equals:42}]};
 const rubric=judgeRubric({rubric:JSON.stringify(spec)});
 const checks=deterministicChecks(Buffer.from(JSON.stringify({answer:41})),rubric);
 assert.deepEqual(checks,[{id:'answer',passed:false}]);assert.equal(parseJudgeScore(JSON.stringify(score(rubric,100)),rubric,{assertions:checks}).acceptable,false);
 assert.deepEqual(deterministicChecks(Buffer.from(JSON.stringify({answer:42})),rubric),[{id:'answer',passed:true}]);
 for(const extra of [{code:'return true'},{path:['__proto__'],equals:1}])assert.throws(()=>judgeRubric({rubric:JSON.stringify({...spec,assertions:[{id:'x',path:[],equals:1,...extra}]})}),e=>e.code==='RUBRIC_INVALID');
 const exact=judgeRubric({rubric:JSON.stringify({...spec,assertions:[{id:'text',path:'$text',equals:'yes'}]})});assert.equal(deterministicChecks(Buffer.from('yes'+String.fromCharCode(10)),exact)[0].passed,false);
});
test('unknown, partial, floating, report-leaking or injection model output fails closed without quoting input',()=>{
 const rubric=judgeRubric({rubric:'plain'}),valid=score(rubric);
 for(const bad of [null,{},[],{...valid,report:'PRIVATE_SENTINEL'},{criteria:valid.criteria.slice(1)},{criteria:valid.criteria.map(c=>({...c,reasonCode:'PRIVATE_SENTINEL'}))},{criteria:valid.criteria.map(c=>({...c,score:90.5}))}])assert.throws(()=>parseJudgeScore(JSON.stringify(bad),rubric),e=>e.code==='EVALUATOR_INVALID'&&!e.message.includes('PRIVATE_SENTINEL'));
});
test('requester retains diagnostics while committed worker receives no candidate breakdown or authenticated material',async()=>{
 const f=fixture(),d=await complete(f);assert.equal(decisionView(d,f.requester,f.task),d);const worker=decisionView(d,f.workers[0],f.task);
 for(const k of ['commitments','excluded','attestation','decisionHash','scoreBasisPoints','criteria','assertions'])assert.equal(worker[k],undefined);assert.equal(worker.winner,d.winner);
});
for(const count of [14,32,64])test('synthetic capacity '+count+' candidates across ten tasks covers each exactly once before MAC',async()=>{
 const fixtures=Array.from({length:10},(_,i)=>fixture(count,DEFAULT_POLICY,1000+i));
 const decisions=await Promise.all(fixtures.map(complete));
 for(let i=0;i<10;i++){const d=decisions[i],f=fixtures[i];assert.equal(d.coverage.complete,true);assert.equal(d.commitments.length,count);assert.equal(d.winner,f.workers[0]);assert.equal(f.calls.size,count);assert.ok([...f.calls.values()].every(n=>n===1));}
});
test('429, timeout, Redis failure, checkpoint key rotation and revoked signer never finalize partial coverage',async()=>{
 for(const code of ['EVALUATOR_RATE_LIMIT','EVALUATOR_UNAVAILABLE']){const f=fixture(14);await evaluateTask(f.id,f.requester,f.options);f.options.evaluator=async()=>{throw new MarketplaceError('Synthetic bounded failure',503,code);};try{await evaluateTask(f.id,f.requester,f.options);}catch(e){assert.equal(e.code,code);}assert.equal(await f.storage.get('decision:'+f.id),null);assert.equal((await f.storage.get('evaluation-job:'+f.id)).processed,1);}
 const stalled=fixture();await evaluateTask(stalled.id,stalled.requester,stalled.options);const get=stalled.storage.get.bind(stalled.storage);stalled.storage.get=async k=>{if(k.startsWith('metadata:'))throw Error('Synthetic Redis unavailable');return get(k);};await assert.rejects(complete(stalled));assert.equal(await get('decision:'+stalled.id),null);
 const rotated=fixture();await evaluateTask(rotated.id,rotated.requester,rotated.options);const key=process.env.MARKETPLACE_DECISION_KEY_ID;try{process.env.MARKETPLACE_DECISION_KEY_ID='rotated-fixture';await assert.rejects(complete(rotated),e=>e.code==='EVALUATION_CHECKPOINT_INVALID');}finally{process.env.MARKETPLACE_DECISION_KEY_ID=key;}assert.equal(await rotated.storage.get('decision:'+rotated.id),null);
 rotated.task.evaluatorRevoked=true;await assert.rejects(complete(rotated),e=>e.code==='EVALUATOR_REVOKED');
});
test('duplicate pages, short coverage, changed model or copied checkpoint are rejected',async()=>{
 const duplicate=fixture();duplicate.workers[1]=duplicate.workers[0];await assert.rejects(complete(duplicate),e=>e.code==='COVERAGE_INCOMPLETE');
 const f=fixture();await evaluateTask(f.id,f.requester,f.options);f.options.model='changed';await assert.rejects(complete(f),e=>e.code==='EVALUATION_CONFIGURATION_CHANGED');assert.equal(await f.storage.get('decision:'+f.id),null);
 const short=fixture();delete short.options.getWorkers;short.options.getPage=async()=>({workers:[short.workers[0]],total:2,nextCursor:null,snapshotBlock:100});await assert.rejects(complete(short),e=>e.code==='COVERAGE_INCOMPLETE');assert.equal(await short.storage.get('decision:'+short.id),null);
 const copy=fixture(2,DEFAULT_POLICY,100);copy.storage.data.set('evaluation-job:'+copy.id,await f.storage.get('evaluation-job:'+f.id));await assert.rejects(complete(copy),e=>e.code==='EVALUATION_CONFIGURATION_CHANGED');
});
