// Node.js/local-only audit: synthetic in-memory artifacts, no network, wallet signing or production writes.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { keccak256 } from 'ethers';
import * as core from '../lib/marketplace-core.mjs';
import * as service from '../lib/marketplace-service.mjs';
import { V3_POLICY as DEFAULT_POLICY, policyHash } from '../lib/marketplace-policy.mjs';

process.env.MARKETPLACE_ENCRYPTION_KEY=randomBytes(32).toString('base64');
process.env.MARKETPLACE_DECISION_KEY_ID='audit-round2-synthetic';
process.env.MARKETPLACE_DECISION_KEY=randomBytes(32).toString('hex');
const requester='0x1111111111111111111111111111111111111111';
const workers=['0x2222222222222222222222222222222222222222','0x3333333333333333333333333333333333333333'];
class MemoryStore {
 data=new Map();
 async get(k){return this.data.has(k)?structuredClone(this.data.get(k)):null;}
 async put(k,v,{nx=false}={}){if(nx&&this.data.has(k))return false;this.data.set(k,structuredClone(v));return true;}
 async release(k,v){if(this.data.get(k)!==v)return false;return this.data.delete(k);}
 async expireIfValue(k,v){return this.data.get(k)===v;}
 async retain(k){return this.data.has(k);}
 async limit(){}
}
function fixture(){
 const storage=new MemoryStore();
 const metadata={title:'Isolated audit task',description:'Synthetic private local reports only; never external input.',rubric:'Assess substantive evidence.',category:'Audit'};
 const task={id:'913',phase:'Review',requester,criteriaHash:core.hash(metadata),policyHash:policyHash(DEFAULT_POLICY),reviewDeadline:Math.floor(Date.now()/1000)+7200,readBlock:100,candidatesHash:core.hash('synthetic-candidates')};
 storage.data.set('metadata:913',{metadata,bounty:'1000'});
 storage.data.set('policy:'+task.policyHash,{policy:DEFAULT_POLICY});
 const texts=['Synthetic private decision: option A.','Synthetic private decision: option B.'];
 for(let i=0;i<workers.length;i++){
  const worker=workers[i], bytes=Buffer.from(texts[i]),encrypted=core.encryptArtifact(bytes,core.artifactKey(task.id,worker));
  storage.data.set(core.artifactKey(task.id,worker),{worker,size:bytes.length,encrypted,filename:'report.txt',mimeType:'text/plain',contentHash:core.hash(encrypted),artifactPtrHash:core.hash('synthetic-pointer-'+i),plaintextHash:keccak256(bytes)});
 }
 let calls=0;
 const options={storage,readTask:async()=>task,getWorkers:async()=>workers,readSubmission:async(id,w)=>{const r=await storage.get(core.artifactKey(id,w));return r?{exists:true,contentHash:r.contentHash,artifactPtrHash:r.artifactPtrHash,size:r.size}:{exists:false};},evaluator:async(t,records)=>{calls++;return {winner:records[0].worker,score:records[0].worker===workers[0]?20:90,acceptable:records[0].worker!==workers[0]};}};
 return {storage,task,options,texts,get calls(){return calls;}};
}
async function finish(f,who=requester){for(let i=0;i<4;i++){const result=await service.evaluateTask('913',who,f.options);if(result.outcome!=='pending')return result;}throw Error('Local fixture failed to complete');}

test('internal decision still binds each candidate plaintext digest for integrity checks',async()=>{
 const f=fixture();const d=await finish(f,workers[0]);
 assert.equal(f.task.phase,'Review');assert.equal(d.winner,workers[1]);
 const other=d.commitments.find(c=>c.worker===workers[1]);
 assert.equal(other.plaintextHash,keccak256(Buffer.from(f.texts[1])));
 assert.notEqual(other.plaintextHash,other.contentHash);
 assert.equal((await service.evaluateTask('913',workers[0],f.options)).commitments.length,2);
});

test('fixed: datastore-only score alteration is discarded and cannot become a verdict',async()=>{
 const f=fixture();assert.equal((await service.evaluateTask('913',requester,f.options)).outcome,'pending');
 const job=await f.storage.get('evaluation-job:913');assert.equal(job.scores[0].score,20);assert.equal(job.scores[0].acceptable,false);
 assert.match(job.checkpointAuth.mac,/^[a-f0-9]{64}$/);
 job.scores[0].score=100;job.scores[0].acceptable=true;delete job.checkpointAuth;
 await f.storage.put('evaluation-job:913',job);
 const d=await finish(f);assert.equal(d.winner,workers[1]);assert.equal(d.score,90);assert.notEqual(d.winner,workers[0]);
 assert.equal(service.verifyDecision(d,f.task),d);
});

test('fixed: forged cursor cannot skip an unreviewed candidate',async()=>{
 const f=fixture();await service.evaluateTask('913',requester,f.options);
 const job=await f.storage.get('evaluation-job:913');job.cursor=2;job.processed=2;job.scores=[];delete job.checkpointAuth;
 await f.storage.put('evaluation-job:913',job);
 const d=await finish(f);assert.equal(d.coverage.processed,2);assert.equal(d.coverage.total,2);assert.equal(d.coverage.complete,true);assert.equal(d.coverage.accepted,2);assert.equal(d.outcome,'winner');
 service.verifyDecision(d,f.task);
});

test('fixed HTTP boundary: privateAction withholds candidate digests and decision MAC', {skip:typeof mock.module!=='function'?'Run with --experimental-test-module-mocks for boundary proof':false},async()=>{
 const f=fixture();const d=await finish(f);
 const coreMock=mock.module('../lib/marketplace-core.mjs',{namedExports:{...core,capabilities:()=>({privateStorage:true}),verifyAuthorization:async()=>workers[0],store:f.storage}});
 const serviceMock=mock.module('../lib/marketplace-service.mjs',{namedExports:{...service,evaluateTask:(id,who)=>service.evaluateTask(id,who,f.options)}});
 try{
  const http=await import('../lib/marketplace-http.mjs?audit-round2-boundary');
  const req=new Request('https://example.invalid/api/marketplace/tasks/913/evaluate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auth:{synthetic:true},payload:{}})});
  const response=await http.handle(()=>http.privateAction(req,'913','evaluate'));assert.equal(response.status,200);
  const body=await response.json();
  // A non-requester caller now gets an allowlisted coarse view: no commitments at all, so no digests or MAC can leak.
  assert.equal(body.commitments,undefined);for(const key of ['attestation','decisionHash','criteria','excluded'])assert.equal(key in body,false);
  assert.ok(['winner','score','outcome','processed','total'].some(k=>k in body));
  assert.equal('plaintextHash' in JSON.parse(JSON.stringify(body)),false);
  assert.equal(d.commitments.find(c=>c.worker===workers[1]).plaintextHash,keccak256(Buffer.from(f.texts[1])));
 }finally{serviceMock.restore();coreMock.restore();}
});
