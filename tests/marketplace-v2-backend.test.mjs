import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {Wallet,ContractFactory,JsonRpcProvider} from 'ethers';
import {compileMarketplaceV2} from '../scripts/compile-marketplace-v2.mjs';
import {hash,taskView,artifactKey,MarketplaceError} from '../lib/marketplace-core.mjs';
import {V3_POLICY as DEFAULT_POLICY,policyHash} from '../lib/marketplace-policy.mjs';
import {registerMetadata,uploadArtifact,evaluateTask,prepareWinner,deliverArtifact} from '../lib/marketplace-service.mjs';
import {signUploadReceipt,signReviewDecision} from '../lib/marketplace-attestation.mjs';

let chain,provider,owner,requester,worker1,worker2,treasury,registry,token,escrow,config;
const evaluator=Wallet.createRandom();
const send=async p=>(await p).wait();
const addr=s=>s.getAddress();
const artifact=n=>JSON.parse(fs.readFileSync(new URL('../artifacts/marketplace-v2/'+n+'.json',import.meta.url)));
class MemoryStore{
  m=new Map();reservations=new Map();
  async get(k){return this.m.get(k)||null;}
  async retain(k){return this.m.has(k);}
  async putArtifact(k,v,{maxParticipants,maxTotalBytes,id,worker,ttl}){if(this.m.has(k))return false;const records=[...this.m.entries()].filter(([key])=>key.startsWith('artifact:'+id+':')).map(([,value])=>value);if(records.length>=maxParticipants||records.reduce((n,r)=>n+r.size,0)+v.size>maxTotalBytes)throw new MarketplaceError('Capacity',409,'ADMISSION_LIMIT');return this.put(k,v,{nx:true,ttl});}
  async put(k,v,{nx=false}={}){if(nx&&this.m.has(k))return false;this.m.set(k,structuredClone(v));return true;}
  async release(k,owner){if(this.m.get(k)!==owner)return false;return this.m.delete(k);}
  async expireIfValue(k,owner){return this.m.get(k)===owner;}
  async admitArtifact(id,who,bytes,{maxParticipants,maxTotalBytes}){const key=id+':'+who.toLowerCase();if(this.reservations.has(key))return true;const entries=[...this.reservations.entries()].filter(([k])=>k.startsWith(id+':'));assert.ok(entries.length<maxParticipants);assert.ok(entries.reduce((n,[,v])=>n+v,0)+bytes<=maxTotalBytes);this.reservations.set(key,bytes);return true;}
}
before(async()=>{
  process.env.MARKETPLACE_ENCRYPTION_KEY=randomBytes(32).toString('base64');
  process.env.MARKETPLACE_AUTH_SECRET=randomBytes(32).toString('hex');
process.env.MARKETPLACE_DECISION_KEY_ID='test-current';
process.env.MARKETPLACE_DECISION_KEY=randomBytes(32).toString('hex');
  process.env.MARKETPLACE_ATTESTATION_KEY=evaluator.privateKey;
  compileMarketplaceV2({writeAbi:false});
  const resolve=createRequire(new URL('../scripts/test-chain/package.json',import.meta.url)).resolve;
  const arch=process.arch==='x64'?'amd64':process.arch,binary=process.platform==='win32'?'anvil.exe':'anvil';
  const exe=resolve(`@foundry-rs/anvil-${process.platform}-${arch}/bin/${binary}`);
  // Keep the synthetic chain behind wall time so real helper expiry timestamps
  // remain valid after evm_increaseTime. No production clock or secrets change.
  chain=spawn(exe,['--host','127.0.0.1','--port','0','--chain-id','56','--hardfork','cancun','--timestamp',String(Math.floor(Date.now()/1000)-5000)],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  const lines=createInterface({input:chain.stdout});
  const endpoint=await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error('Anvil unavailable')),15000);chain.once('error',e=>{clearTimeout(timer);rej(e)});lines.on('line',line=>{const m=line.match(/Listening on (127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);res('http://'+m[1]);}})});
  provider=new JsonRpcProvider(endpoint,56,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20});
  [owner,requester,worker1,worker2,treasury]=await Promise.all([0,1,2,3,4].map(i=>provider.getSigner(i)));
  const reg=artifact('MockAgentID');registry=await new ContractFactory(reg.abi,reg.bytecode,owner).deploy();await registry.waitForDeployment();
  const tok=artifact('MockERC20');token=await new ContractFactory(tok.abi,tok.bytecode,owner).deploy('USDC','USDC',18);await token.waitForDeployment();
  const esc=artifact('OneRubMarketplaceEscrowV2');escrow=await new ContractFactory(esc.abi,esc.bytecode,owner).deploy(await registry.getAddress(),await addr(treasury),await token.getAddress(),evaluator.address);await escrow.waitForDeployment();
  config={chainId:56,address:await escrow.getAddress(),evaluator:evaluator.address,version:2,protocolRevision:3};
  for(const signer of [requester,worker1,worker2])await send(registry.set(await addr(signer),1));
});
after(async()=>{provider?.destroy();if(chain?.pid&&chain.exitCode===null&&chain.signalCode===null){const stopped=once(chain,'exit');chain.kill();await stopped;}});

test('V2 full private workflow: receipt-gated commits, complete resumable review, signed90/10 payout, confirmed delivery and all-fail refund',async()=>{
 const storage=new MemoryStore(),metadata={title:'Review a synthetic calculation',description:'Return independently checkable arithmetic with reasoning.',rubric:'Correct arithmetic and reproducible reasoning; fabricated or unrelated work fails.',category:'Research'};
 const policy=structuredClone(DEFAULT_POLICY),pHash=policyHash(policy);await storage.put('policy:'+pHash,{policy});
 const units=10n**18n;await send(token.mint(await addr(requester),10n*units));await send(token.connect(requester).approve(await escrow.getAddress(),10n*units));
 const fixtures=[];
 for(let i=0;i<2;i++){
   const stamp=BigInt((await provider.getBlock('latest')).timestamp),id=String(await escrow.nextTaskId());
   await send(escrow.connect(requester).createAndFund(await token.getAddress(),5n*units,hash(metadata),stamp+3600n,stamp+7200n,pHash));
   const readTask=async(taskId,{confirmations=0}={})=>{const block=await provider.getBlockNumber()-confirmations;const t=await escrow.getTask(taskId,{blockTag:block});return {...taskView(taskId,t,await escrow.phaseOf(taskId,{blockTag:block})),evaluatorSigner:t.evaluatorSigner,evaluatorRevoked:await escrow.revokedEvaluator(t.evaluatorSigner,{blockTag:block}),readBlock:block};};
   const readSubmission=(taskId,w)=>escrow.getSubmission(taskId,w);
   const getPage=async(taskId,{cursor=0,limit=8,snapshotBlock}={})=>{const block=snapshotBlock??await provider.getBlockNumber();const workers=Array.from(await escrow.getSubmittersPage(taskId,cursor,limit,{blockTag:block}));const total=Number(await escrow.submissionCount(taskId,{blockTag:block}));return {workers,total,snapshotBlock:block,nextCursor:cursor+workers.length<total?cursor+workers.length:null};};
   await registerMetadata(id,await addr(requester),{metadata},{storage,readTask});
   for(const [n,worker]of [worker1,worker2].entries()){
     const report=`Synthetic task ${i+1}, worker ${n+1}: calculation and a complete explanation.`;
     const receipt=await uploadArtifact(id,await addr(worker),{filename:'report.md',mimeType:'text/markdown',contentBase64:Buffer.from(report).toString('base64')},{storage,readTask});
     assert.equal(JSON.stringify(await storage.get(artifactKey(id,await addr(worker)))).includes(report),false);
     const signed=await signUploadReceipt(await readTask(id),await addr(worker),{storage,config});
     assert.equal(signed.contentHash,receipt.contentHash);
     await send(escrow.connect(worker).submitCommitment(id,signed.contentHash,signed.artifactPtrHash,signed.size,signed.expiresAt,signed.signature));
   }
   fixtures.push({id,readTask,readSubmission,getPage});
 }
 await provider.send('evm_increaseTime',[3605]);await provider.send('evm_mine',[]);
 const [win,fail]=fixtures;let requests=0;
 const options={storage,config,readTask:win.readTask,readSubmission:win.readSubmission,getPage:win.getPage,evaluator:async(task,records)=>{requests++;return {winner:records[0].worker,score:records[0].worker===(await addr(worker2))?96:40,acceptable:records[0].worker===(await addr(worker2))};}};
 const first=await evaluateTask(win.id,await addr(requester),options);assert.equal(first.outcome,'pending');assert.equal(first.processed,1);
 const decision=await evaluateTask(win.id,await addr(requester),options);assert.equal(decision.outcome,'winner');assert.equal(decision.winner,await addr(worker2));assert.equal(decision.coverage.accepted,2);assert.equal(requests,2);
 assert.equal(decision.candidatesHash,(await escrow.getTask(win.id)).candidatesHash);
 await assert.rejects(deliverArtifact(win.id,await addr(requester),{storage,config,readTask:win.readTask,readSubmission:win.readSubmission}),e=>e.code==='NOT_SETTLED');
 const prepared=await prepareWinner(win.id,{storage,config,readTask:win.readTask,readSubmission:win.readSubmission});
 const signedDecision=await signReviewDecision(await win.readTask(win.id),prepared,{storage,config});
 await send(escrow.connect(requester).selectWinner(win.id,signedDecision.winner,signedDecision.expiresAt,signedDecision.signature));
 assert.equal(await token.balanceOf(await addr(worker2)),45n*10n**17n);assert.equal(await token.balanceOf(await addr(worker1)),0n);assert.equal(await token.balanceOf(await addr(treasury)),5n*10n**17n);
 for(let i=0;i<3;i++)await provider.send('evm_mine',[]);
 const delivery=await deliverArtifact(win.id,await addr(requester),{storage,config,readTask:win.readTask,readSubmission:win.readSubmission});
 assert.equal(Buffer.from(delivery.contentBase64,'base64').toString(),'Synthetic task 1, worker 2: calculation and a complete explanation.');
 await assert.rejects(deliverArtifact(win.id,await addr(worker1),{storage,config,readTask:win.readTask,readSubmission:win.readSubmission}),e=>e.code==='FORBIDDEN');
 const failureOptions={storage,config,readTask:fail.readTask,readSubmission:fail.readSubmission,getPage:fail.getPage,evaluator:async(task,records)=>({winner:records[0].worker,score:10,acceptable:false})};
 assert.equal((await evaluateTask(fail.id,await addr(requester),failureOptions)).outcome,'pending');
 const rejected=await evaluateTask(fail.id,await addr(requester),failureOptions);assert.equal(rejected.outcome,'no_acceptable_submission');assert.equal(rejected.winner,null);assert.equal(rejected.candidatesHash,(await escrow.getTask(fail.id)).candidatesHash);
 await assert.rejects(prepareWinner(fail.id,{storage,config,readTask:fail.readTask,readSubmission:fail.readSubmission}),e=>e.code==='NO_ACCEPTABLE_SUBMISSION');
 const signedRejection=await signReviewDecision(await fail.readTask(fail.id),rejected,{storage,config});
 await send(escrow.rejectAll(fail.id,signedRejection.expiresAt,signedRejection.signature));
 assert.equal((await escrow.getTask(fail.id)).status,3n);assert.equal(await token.balanceOf(await addr(requester)),5n*units);assert.equal(await token.balanceOf(await escrow.getAddress()),0n);
 await assert.rejects(deliverArtifact(fail.id,await addr(requester),{storage,config,readTask:fail.readTask,readSubmission:fail.readSubmission}),e=>e.code==='NOT_SETTLED');
});

test('one worker triggers complete review and relays preauthorized escrow payout without requester cooperation',async()=>{
 const storage=new MemoryStore(),metadata={title:'Singleton synthetic task',description:'Produce one independently checkable result.',rubric:'Valid reproducible arithmetic required.',category:'Research'};
 const policy=structuredClone(DEFAULT_POLICY),pHash=policyHash(policy);await storage.put('policy:'+pHash,{policy});
 const bounty=1001n,stamp=BigInt((await provider.getBlock('latest')).timestamp),id=String(await escrow.nextTaskId());
 await send(token.mint(await addr(requester),bounty));await send(token.connect(requester).approve(await escrow.getAddress(),bounty));await send(escrow.connect(requester).createAndFund(await token.getAddress(),bounty,hash(metadata),stamp+180n,stamp+3780n,pHash));
 const readTask=async(taskId,{confirmations=0}={})=>{const block=await provider.getBlockNumber()-confirmations,t=await escrow.getTask(taskId,{blockTag:block});return {...taskView(taskId,t,await escrow.phaseOf(taskId,{blockTag:block})),evaluatorSigner:t.evaluatorSigner,evaluatorRevoked:await escrow.revokedEvaluator(t.evaluatorSigner,{blockTag:block}),readBlock:block};};
 const readSubmission=(taskId,w)=>escrow.getSubmission(taskId,w),options={storage,config,readTask,readSubmission,getWorkers:async()=>[await addr(worker1)],evaluator:async(t,r)=>({winner:r[0].worker,score:91,acceptable:true})};
 await registerMetadata(id,await addr(requester),{metadata},{storage,readTask});await uploadArtifact(id,await addr(worker1),{filename:'singleton.md',mimeType:'text/markdown',contentBase64:Buffer.from('Synthetic singleton: 2 + 2 = 4, verified by explicit arithmetic.').toString('base64')},{storage,readTask});
 const upload=await signUploadReceipt(await readTask(id),await addr(worker1),{storage,config});await send(escrow.connect(worker1).submitCommitment(id,upload.contentHash,upload.artifactPtrHash,upload.size,upload.expiresAt,upload.signature));
 await provider.send('evm_increaseTime',[181]);await provider.send('evm_mine',[]);
 const d=await evaluateTask(id,await addr(worker1),options);assert.equal(d.outcome,'winner');assert.equal(d.coverage.accepted,1);assert.equal(d.requester,await addr(requester));
 const prepared=await prepareWinner(id,options),signed=await signReviewDecision(await readTask(id),prepared,{storage,config}),balance=await token.balanceOf(await addr(worker1)),requesterBalance=await token.balanceOf(await addr(requester));
 await send(escrow.connect(worker2).selectWinner(id,signed.winner,signed.expiresAt,signed.signature));assert.equal(await token.balanceOf(await addr(worker1)),balance+901n);assert.equal(await token.balanceOf(await addr(requester)),requesterBalance);
 for(let i=0;i<3;i++)await provider.send('evm_mine',[]);const delivered=await deliverArtifact(id,await addr(worker1),{storage,readTask,readSubmission});assert.equal(delivered.plaintextHash,(await storage.get(artifactKey(id,await addr(worker1)))).plaintextHash);
});
