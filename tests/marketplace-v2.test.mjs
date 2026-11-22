import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {AbiCoder,ContractFactory,JsonRpcProvider,Wallet,TypedDataEncoder,ZeroAddress,ZeroHash,keccak256} from 'ethers';
import {compileMarketplaceV2} from '../scripts/compile-marketplace-v2.mjs';
let chain,provider,registry,token,escrow,owner,requester,worker1,worker2,outsider,treasury,otherTreasury,all;
const evaluator=Wallet.createRandom(),wrongEvaluator=Wallet.createRandom();
const H=n=>'0x'+n.toString(16).padStart(2,'0').repeat(32);
const receiptTypes={UploadReceipt:[{name:'taskId',type:'uint256'},{name:'worker',type:'address'},{name:'contentHash',type:'bytes32'},{name:'artifactPtrHash',type:'bytes32'},{name:'size',type:'uint32'},{name:'expiresAt',type:'uint64'}]};
const reviewTypes={ReviewDecision:[{name:'taskId',type:'uint256'},{name:'winner',type:'address'},{name:'contentHash',type:'bytes32'},{name:'artifactPtrHash',type:'bytes32'},{name:'candidatesHash',type:'bytes32'},{name:'criteriaHash',type:'bytes32'},{name:'policyHash',type:'bytes32'},{name:'expiresAt',type:'uint64'},{name:'accepted',type:'bool'}]};
const send=async p=>(await p).wait();
const addr=s=>s.getAddress();
const now=async()=>BigInt((await provider.getBlock('latest')).timestamp);
const artifact=n=>JSON.parse(fs.readFileSync(new URL('../artifacts/marketplace-v2/'+n+'.json',import.meta.url)));
const warp=async secs=>{await provider.send('evm_increaseTime',[Number(secs)]);await provider.send('evm_mine',[]);};
const domain=async()=>({name:'ONERUB Marketplace Escrow',version:'2',chainId:56,verifyingContract:await escrow.getAddress()});
async function create({bounty=10n**18n,subIn=3600n,reviewIn=7200n}={}){
  const stamp=await now();await send(token.mint(await addr(requester),bounty));await send(token.connect(requester).approve(await escrow.getAddress(),bounty));
  const id=await escrow.nextTaskId();await send(escrow.connect(requester).createAndFund(await token.getAddress(),bounty,H(1),stamp+subIn,stamp+reviewIn,H(2)));return id;
}
async function receipt(id,worker,{signer=evaluator,overrides={},domainOverride={}}={}){
  const t=await escrow.getTask(id);const value={taskId:id,worker:await addr(worker),contentHash:H(10),artifactPtrHash:H(11),size:100,expiresAt:t.submissionDeadline,...overrides};
  return {...value,signature:await signer.signTypedData({...await domain(),...domainOverride},receiptTypes,value)};
}
const submit=(r,worker)=>send(escrow.connect(worker).submitCommitment(r.taskId,r.contentHash,r.artifactPtrHash,r.size,r.expiresAt,r.signature));
async function pair(id){const r1=await receipt(id,worker1),r2=await receipt(id,worker2,{overrides:{contentHash:H(12),artifactPtrHash:H(13)}});await submit(r1,worker1);await submit(r2,worker2);return [r1,r2];}
async function decision(id,winner,{signer=evaluator,accepted=true,overrides={},domainOverride={}}={}){
  const t=await escrow.getTask(id);const worker=accepted?await addr(winner):ZeroAddress;
  const s=await escrow.getSubmission(id,worker);
  const value={taskId:id,winner:worker,contentHash:accepted?s.contentHash:ZeroHash,artifactPtrHash:accepted?s.artifactPtrHash:ZeroHash,candidatesHash:t.candidatesHash,criteriaHash:t.criteriaHash,policyHash:t.policyHash,expiresAt:t.reviewDeadline,accepted,...overrides};
  return {...value,signature:await signer.signTypedData({...await domain(),...domainOverride},reviewTypes,value)};
}
const select=d=>send(escrow.connect(requester).selectWinner(d.taskId,d.winner,d.expiresAt,d.signature));

before(async()=>{
  compileMarketplaceV2({writeAbi:false});
  const resolve=createRequire(new URL('../scripts/test-chain/package.json',import.meta.url)).resolve;
  const arch=process.arch==='x64'?'amd64':process.arch,binary=process.platform==='win32'?'anvil.exe':'anvil';
  const exe=resolve(`@foundry-rs/anvil-${process.platform}-${arch}/bin/${binary}`);
  chain=spawn(exe,['--host','127.0.0.1','--port','0','--chain-id','56','--hardfork','cancun','--accounts','72'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  const lines=createInterface({input:chain.stdout});
  const endpoint=await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error('Anvil unavailable')),15000);chain.once('error',e=>{clearTimeout(timer);rej(e)});lines.on('line',line=>{const m=line.match(/Listening on (127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);res('http://'+m[1]);}})});
  provider=new JsonRpcProvider(endpoint,56,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20});
  all=await Promise.all(Array.from({length:72},(_,i)=>provider.getSigner(i)));
  [owner,requester,worker1,worker2,outsider,treasury,otherTreasury]=all;
  const reg=artifact('MockAgentID');registry=await new ContractFactory(reg.abi,reg.bytecode,owner).deploy();await registry.waitForDeployment();
  const tok=artifact('MockERC20');token=await new ContractFactory(tok.abi,tok.bytecode,owner).deploy('USDC','USDC',18);await token.waitForDeployment();
  const esc=artifact('OneRubMarketplaceEscrowV2');escrow=await new ContractFactory(esc.abi,esc.bytecode,owner).deploy(await registry.getAddress(),await addr(treasury),await token.getAddress(),evaluator.address);await escrow.waitForDeployment();
  for(const s of [requester,worker1,worker2])await send(registry.set(await addr(s),1));
});
after(async()=>{provider?.destroy();if(chain?.pid&&chain.exitCode===null&&chain.signalCode===null){const stopped=once(chain,'exit');chain.kill();await stopped;}});

test('V2 wires per-task signer, minimum review, caps and exact safe fee quote',async()=>{
  assert.equal(await escrow.evaluator(),evaluator.address);assert.equal(await escrow.MIN_REVIEW_WINDOW(),3600n);
  assert.equal(await escrow.MAX_PARTICIPANTS(),64n);assert.equal(await escrow.MAX_ARTIFACT_BYTES(),524288n);assert.equal(await escrow.MAX_TOTAL_BYTES(),33554432n);
  const max=2n**256n-1n;const [fee,payout]=await escrow.quote(max);assert.equal(fee,max/10n);assert.equal(fee+payout,max);
  await assert.rejects(create({subIn:60n,reviewIn:3600n}),/submission deadline too soon/);
  await assert.rejects(create({subIn:3600n,reviewIn:4499n}),/review window too short/);
  const stamp=await now();await assert.rejects(escrow.connect(outsider).createAndFund(await token.getAddress(),100n,H(1),stamp+3600n,stamp+7200n,H(2)),/Agent ID required/);
});

test('admission requires signature bound to worker, task, hashes, size, expiry, chain and contract',async()=>{
  const id=await create(),second=await create();
  await assert.rejects(submit(await receipt(id,worker1,{signer:wrongEvaluator}),worker1),/invalid upload receipt/);
  const valid=await receipt(id,worker1);
  await assert.rejects(submit(valid,worker2),/invalid upload receipt/);
  await assert.rejects(submit({...valid,taskId:second},worker1),/invalid upload receipt/);
  await assert.rejects(submit({...valid,contentHash:H(99)},worker1),/invalid upload receipt/);
  await assert.rejects(submit({...valid,size:101},worker1),/invalid upload receipt/);
  await assert.rejects(submit(await receipt(id,worker1,{domainOverride:{chainId:1}}),worker1),/invalid upload receipt/);
  await assert.rejects(submit(await receipt(id,worker1,{domainOverride:{verifyingContract:await token.getAddress()}}),worker1),/invalid upload receipt/);
  await assert.rejects(submit({...valid,signature:'0x'},worker1));
  await assert.rejects(submit(await receipt(id,worker1,{overrides:{expiresAt:1}}),worker1),/receipt expired/);
  await assert.rejects(submit(await receipt(id,worker1,{overrides:{size:524289}}),worker1),/artifact size outside/);
  await assert.rejects(submit(await receipt(id,worker1,{overrides:{artifactPtrHash:ZeroHash}}),worker1),/empty commitment/);
  await submit(valid,worker1);await assert.rejects(submit(valid,worker1),/already submitted/);
});

test('ordered candidate commitment is computed on-chain and pagination is bounded',async()=>{
  const id=await create();const rs=await pair(id);let root=ZeroHash;const coder=AbiCoder.defaultAbiCoder();
  for(const r of rs)root=keccak256(coder.encode(['bytes32','address','bytes32','bytes32','uint32'],[root,r.worker,r.contentHash,r.artifactPtrHash,r.size]));
  assert.equal(await escrow.candidatesHash(id),root);assert.equal((await escrow.getTask(id)).candidatesHash,root);
  assert.equal((await escrow.getTask(id)).totalBytes,200n);
  assert.deepEqual(Array.from(await escrow.getSubmittersPage(id,1,1)),[await addr(worker2)]);
  assert.equal((await escrow.getSubmittersPage(id,9,1)).length,0);await assert.rejects(escrow.getSubmittersPage(id,0,65),/invalid page limit/);
});

test('direct selection without evaluator approval fails; signature mutation and stale candidate root fail',async()=>{
  const id=await create();const first=await receipt(id,worker1);await submit(first,worker1);
  const stale=await decision(id,worker1);await submit(await receipt(id,worker2),worker2);await warp(3601);
  await assert.rejects(select({...stale,signature:'0x'}));
  await assert.rejects(select(stale),/invalid review decision/);
  for(const overrides of [{criteriaHash:H(80)},{policyHash:H(81)},{contentHash:H(82)},{artifactPtrHash:H(83)},{accepted:false}]){
    await assert.rejects(select(await decision(id,worker1,{overrides})),/invalid review decision/);
  }
  await assert.rejects(select(await decision(id,worker1,{signer:wrongEvaluator})),/invalid review decision/);
  await assert.rejects(select(await decision(id,worker1,{domainOverride:{chainId:1}})),/invalid review decision/);
  const good=await decision(id,worker1);const digest=TypedDataEncoder.hash(await domain(),reviewTypes,good);
  assert.equal(await escrow.reviewDigest(id,good.winner,good.expiresAt,true),digest);
  await select(good);assert.equal((await escrow.getTask(id)).status,2n);
  await assert.rejects(select(good),/task not active/);
});

test('winner and requester Agent IDs are rechecked at settlement',async()=>{
  const id=await create();await pair(id);await warp(3601);const good=await decision(id,worker2);
  await send(registry.set(await addr(worker2),0));await assert.rejects(select(good),/winner Agent ID required/);await send(registry.set(await addr(worker2),1));
  await send(registry.set(await addr(requester),0));await assert.rejects(select(good),/Agent ID required/);await send(registry.set(await addr(requester),1));await select(good);
});

test('no-acceptable verdict is bound to all candidates and refunds once; cannot be used to pay',async()=>{
  const id=await create();await pair(id);await warp(3601);
  const d=await decision(id,null,{accepted:false});const before=await token.balanceOf(await addr(requester));
  const acceptance=await decision(id,worker1);await assert.rejects(escrow.connect(outsider).rejectAll(id,acceptance.expiresAt,acceptance.signature),/invalid rejection decision/);
  await send(escrow.connect(outsider).rejectAll(id,d.expiresAt,d.signature));assert.equal(await token.balanceOf(await addr(requester)),before+10n**18n);
  assert.equal((await escrow.getTask(id)).status,3n);await assert.rejects(escrow.rejectAll(id,d.expiresAt,d.signature),/task not active/);
});

test('fee recipient is snapshotted and one task cannot consume another escrow',async()=>{
  const id=await create({bounty:1001n}),other=await create({bounty:2000n});const old=await token.balanceOf(await addr(treasury)),updated=await token.balanceOf(await addr(otherTreasury));
  await send(escrow.setTreasury(await addr(otherTreasury)));await pair(id);await warp(3601);const winBefore=await token.balanceOf(await addr(worker1));await select(await decision(id,worker1));
  assert.equal(await token.balanceOf(await addr(treasury)),old+100n);assert.equal(await token.balanceOf(await addr(otherTreasury)),updated);assert.equal(await token.balanceOf(await addr(worker1)),winBefore+901n);
  assert.equal((await escrow.getTask(other)).bounty,2000n);assert.equal((await escrow.getTask(id)).bounty,0n);
});

test('expiry and no-submission escape hatches remain permissionless and pay requester',async()=>{
  const id=await create();await pair(id);const balance=await token.balanceOf(await addr(requester));await warp(7201);await send(escrow.connect(outsider).refund(id));assert.equal(await token.balanceOf(await addr(requester)),balance+10n**18n);
  const empty=await create();await warp(3601);await send(escrow.connect(outsider).refund(empty));assert.equal((await escrow.getTask(empty)).status,3n);
});

test('64 receipt-admitted workers of 512 KiB fit; the65th cannot overflow task capacity',async()=>{
  const id=await create({subIn:10000n,reviewIn:15000n});
  for(const worker of all.slice(7,71)){await send(registry.set(await addr(worker),1));await submit(await receipt(id,worker,{overrides:{size:524288}}),worker);}
  const t=await escrow.getTask(id);assert.equal(t.submissionCount,64n);assert.equal(t.totalBytes,33554432n);
  const extra=all[71];await send(registry.set(await addr(extra),1));await assert.rejects(submit(await receipt(id,extra),extra),/participant limit/);
});

test('singleton accepted report can settle through a non-agent relayer using only funded task escrow',async()=>{
 const id=await create({bounty:1001n}),other=await create({bounty:9999n});await submit(await receipt(id,worker1),worker1);await warp(3601);
 assert.equal(await registry.balanceOf(await addr(outsider)),0n);assert.equal(await escrow.MIN_VALID_SUBMISSIONS(),1n);assert.equal(await escrow.PROTOCOL_REVISION(),3n);
 const d=await decision(id,worker1),before=await token.balanceOf(await addr(worker1)),requesterBefore=await token.balanceOf(await addr(requester)),relayBefore=await token.balanceOf(await addr(outsider));
 await send(escrow.connect(outsider).selectWinner(id,d.winner,d.expiresAt,d.signature));
 assert.equal(await token.balanceOf(await addr(worker1)),before+901n);assert.equal(await token.balanceOf(await addr(requester)),requesterBefore);assert.equal(await token.balanceOf(await addr(outsider)),relayBefore);assert.equal((await escrow.getTask(other)).bounty,9999n);
 await assert.rejects(escrow.connect(outsider).selectWinner(id,d.winner,d.expiresAt,d.signature),/task not active/);
});
test('singleton failed acceptance refunds through signed rejection without any worker payout',async()=>{
 const id=await create();await submit(await receipt(id,worker1),worker1);await warp(3601);const d=await decision(id,null,{accepted:false});
 const before=await token.balanceOf(await addr(worker1));await send(escrow.connect(outsider).rejectAll(id,d.expiresAt,d.signature));assert.equal((await escrow.getTask(id)).status,3n);assert.equal(await token.balanceOf(await addr(worker1)),before);
});
test('signer rotation applies only to new tasks; disclosed permanent revoke blocks active signatures and enables immediate escrow refund',async()=>{
 const active=await create(),pending=await create(),newSigner=Wallet.createRandom();
 await assert.rejects(escrow.connect(outsider).setEvaluator(newSigner.address));await assert.rejects(escrow.connect(outsider).revokeEvaluator(evaluator.address,H(88)));
 await send(escrow.setEvaluator(newSigner.address));assert.equal((await escrow.getTask(active)).evaluatorSigner,evaluator.address);assert.equal((await escrow.getTask(pending)).evaluatorSigner,evaluator.address);
 const fresh=await create();assert.equal((await escrow.getTask(fresh)).evaluatorSigner,newSigner.address);
 await assert.rejects(submit(await receipt(fresh,worker1),worker1),/invalid upload receipt/);await submit(await receipt(fresh,worker1,{signer:newSigner}),worker1);
 await assert.rejects(submit(await receipt(active,worker1,{signer:newSigner}),worker1),/invalid upload receipt/);await submit(await receipt(active,worker1),worker1);await submit(await receipt(pending,worker2),worker2);
 await warp(3601);await select(await decision(active,worker1));assert.equal((await escrow.getTask(active)).status,2n);
 await assert.rejects(escrow.revokeEvaluator(evaluator.address,ZeroHash),/revocation disclosure required/);
 await send(escrow.revokeEvaluator(evaluator.address,H(88)));assert.equal(await escrow.revokedEvaluator(evaluator.address),true);assert.equal((await escrow.getTask(pending)).evaluatorSigner,evaluator.address);
 await assert.rejects(escrow.setEvaluator(evaluator.address),/invalid evaluator/);await assert.rejects(escrow.revokeEvaluator(evaluator.address,H(89)),/already revoked/);
 const pendingDecision=await decision(pending,worker2);await assert.rejects(select(pendingDecision),/evaluator revoked/);assert.ok((await now())<(await escrow.getTask(pending)).reviewDeadline);
 const before=await token.balanceOf(await addr(requester));await send(escrow.connect(outsider).refund(pending));assert.equal((await escrow.getTask(pending)).status,3n);assert.equal(await token.balanceOf(await addr(requester)),before+10n**18n);
 const freshDecision=await decision(fresh,worker1,{signer:newSigner});await send(escrow.connect(outsider).selectWinner(fresh,freshDecision.winner,freshDecision.expiresAt,freshDecision.signature));
 const revokedTask=await create();await submit(await receipt(revokedTask,worker1,{signer:newSigner}),worker1);await warp(3601);const stale=await decision(revokedTask,worker1,{signer:newSigner});await send(escrow.revokeEvaluator(newSigner.address,H(90)));
 await assert.rejects(escrow.connect(outsider).selectWinner(revokedTask,stale.winner,stale.expiresAt,stale.signature),/evaluator revoked/);await assert.rejects(create(),/evaluator revoked/);await send(escrow.connect(outsider).refund(revokedTask));
});
