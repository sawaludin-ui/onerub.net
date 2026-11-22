// Synthetic, memory-only audit reproductions. No RPC, provider call, wallet,
// signature or broadcast. Uses random test secrets only inside this process.
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {Wallet,keccak256} from 'ethers';
import {MarketplaceError,artifactKey,encryptArtifact,hash} from '../lib/marketplace-core.mjs';
import {evaluateTask,prepareWinner,deliverArtifact,parseDecision} from '../lib/marketplace-service.mjs';
import {prepare} from '../lib/marketplace-http.mjs';

process.env.MARKETPLACE_ENCRYPTION_KEY=randomBytes(32).toString('base64');
process.env.MARKETPLACE_AUTH_SECRET=randomBytes(32).toString('hex');
class MemoryStore {
  data=new Map();counts=new Map();writes=[];
  async get(k){return this.data.get(k)||null;}
  async put(k,v,{nx=false,ttl}={}){this.writes.push({key:k,ttl:ttl??null});if(nx&&this.data.has(k))return false;this.data.set(k,v);return true;}
  async limit(k,max){const count=(this.counts.get(k)||0)+1;this.counts.set(k,count);if(count>max)throw new MarketplaceError('Request limit reached. Retry later.',429,'RATE_LIMIT');}
}
function fixture(count=2,sizes=[]) {
  const requester=Wallet.createRandom().address,workers=Array.from({length:count},()=>Wallet.createRandom().address);
  const metadata={title:'Synthetic audit verification',description:'No real user information or external calls.',rubric:'Compare complete work to acceptance criteria.',category:'Review'};
  const task={id:'3',requester,phase:'Review',criteriaHash:hash(metadata),reviewDeadline:Math.floor(Date.now()/1000)+3600,readBlock:5000};
  const storage=new MemoryStore();storage.data.set('metadata:3',{metadata,bounty:'1000'});
  for(const [i,size] of sizes.entries()){
    const worker=workers[i],bytes=Buffer.alloc(size,65),encrypted=encryptArtifact(bytes,artifactKey('3',worker));
    storage.data.set(artifactKey('3',worker),{worker,size,encrypted,plaintextHash:keccak256(bytes),contentHash:hash(encrypted),artifactPtrHash:hash('synthetic-pointer-'+i),filename:'synthetic.md',mimeType:'text/markdown'});
  }
  const options={storage,readTask:async()=>task,getWorkers:async()=>workers,readSubmission:async(id,w)=>({...storage.data.get(artifactKey(id,w)),exists:true}),evaluator:async()=>({winner:workers[0],score:80})};
  return {task,storage,workers,requester,options};
}
function errorView(e){return {name:e.constructor.name,code:e.code??null,status:e.status??null,message:e.message};}
async function outcome(fn){try{return {ok:true,value:await fn()};}catch(e){return {ok:false,error:errorView(e)};}}
const probes=[];

{
  const f=fixture(21);
  const result=await outcome(()=>evaluateTask('3',f.requester,f.options));
  probes.push({probe:'21 committed workers',reproduced:!result.ok&&result.error.code==='EVALUATION_LIMIT',result});
}
{
  const f=fixture(2,[512*1024,256*1024]);
  const result=await outcome(()=>evaluateTask('3',f.requester,f.options));
  probes.push({probe:'individually permitted reports exceed combined evaluation budget',sizes:[512*1024,256*1024],combined:768*1024,reproduced:!result.ok&&result.error.status===413,result});
}
{
  const now=Math.floor(Date.now()/1000);
  const body={action:'createAndFund',amount:'1',metadata:{title:'Synthetic deadline probe',description:'Unsigned API preparation only; no blockchain transaction.',rubric:'Compare work against acceptance criteria.',category:'Review'},policyHash:'0x'+'12'.repeat(32),submissionDeadline:now+600,reviewDeadline:now+601};
  const result=await outcome(async()=>{
    const value=await prepare(new Request('https://onerub.net/api/marketplace/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
    return {action:value.action,reviewWindowSeconds:1,signed:false,broadcast:false};
  });
  probes.push({probe:'one second review window accepted',reproduced:result.ok,result});
}
{
  const f=fixture(2,[100,100]);
  f.options.evaluator=async()=>{throw new Error('Synthetic provider failure');};
  const results=[];
  for(let attempt=1;attempt<=4;attempt++)results.push({attempt,...await outcome(()=>evaluateTask('3',f.requester,f.options))});
  const consumed=f.storage.counts.get('evaluation:3');
  probes.push({probe:'failed evaluation retains lock and retries consume quota',reproduced:results[0].error?.message==='Synthetic provider failure'&&results[1].error?.code==='EVALUATION_RUNNING'&&results[2].error?.code==='EVALUATION_RUNNING'&&results[3].error?.code==='RATE_LIMIT',rateCount:consumed,lockStillPresent:!!f.storage.data.get('evaluation-lock:3'),lockTtlSeconds:f.storage.writes.find(x=>x.key==='evaluation-lock:3')?.ttl,results});
}
{
  const result=await outcome(()=>parseDecision('null',[Wallet.createRandom().address]));
  probes.push({probe:'JSON null evaluator response',reproduced:!result.ok&&result.error.name==='TypeError',result});
}
{
  const f=fixture(2,[100,100]);
  await evaluateTask('3',f.requester,f.options);
  process.env.MARKETPLACE_ENCRYPTION_KEY=randomBytes(32).toString('base64');
  const prepared=await outcome(()=>prepareWinner('3',f.options));
  f.task.phase='Settled';f.task.winner=f.workers[0];
  const delivery=await outcome(()=>deliverArtifact('3',f.requester,f.options));
  probes.push({probe:'key rotation after decision permits prepare but breaks delivery',reproduced:prepared.ok&&!delivery.ok,preparePassed:prepared.ok,delivery:delivery.ok?{ok:true}:{ok:false,error:delivery.error}});
}
const summary={dateWib:'2026-11-22',scope:'synthetic in-memory audit; no RPC/provider/wallet/signing/broadcast',secretsIncluded:false,probes,reproducedCount:probes.filter(p=>p.reproduced).length};
const text=JSON.stringify(summary,null,2)+'\n';
fs.mkdirSync(new URL('../.local/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('../.local/audit-repro-2026-11-22.json',import.meta.url),text);
process.stdout.write(text);
