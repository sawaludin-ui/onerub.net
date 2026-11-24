// Isolated synthetic keys, mock Redis semantics, and local Anvil only. No live RPC.
import {test} from 'node:test';
import {prepareTests} from '../scripts/prepare-tests.mjs';
prepareTests();
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {Wallet,Transaction,keccak256,ContractFactory,JsonRpcProvider} from 'ethers';
import {createSettlementRelayer,RELAYER_LUA} from '../lib/marketplace-relayer.mjs';
import {marketplaceInterface,hash,taskView} from '../lib/marketplace-core.mjs';
// Receipt/nonce regression deliberately exercises the immutable v3 judge protocol.
import {V3_POLICY as DEFAULT_POLICY,policyHash} from '../lib/marketplace-policy.mjs';
import {signUploadReceipt} from '../lib/marketplace-attestation.mjs';
import {registerMetadata,uploadArtifact,evaluateTask} from '../lib/marketplace-service.mjs';

// Atomic deterministic model of RELAYER_LUA; deliberately not a Redis integration claim.
class MemoryRedis {
 m=new Map();leases=new Map();clock=100000000;used=0;count=0;day=1;events=[];
 failPersist=false;losePersistReply=false;
 async get(k){return this.m.get(k)||null;}
 async put(k,v,{nx=false}={}){if(nx&&this.m.has(k))return false;this.m.set(k,structuredClone(v));return true;}
 async retain(k){return this.m.has(k);}
 async putArtifact(k,v,opts){return this.put(k,v,{nx:true});}
 async admitArtifact(){return true;}
 async release(k,owner){if(this.m.get(k)!==owner)return false;return this.m.delete(k);}
 async expireIfValue(k,owner){return this.m.get(k)===owner;}
 async command(cmd,script,n,...args){
  if(cmd==='GET')return this.m.get(script)||null;
  assert.equal(cmd,'EVAL');assert.equal(script,RELAYER_LUA);assert.equal(n,'4');
  const [lock,lane,journal,budget,op,owner,...a]=args;
  const held=this.leases.get(lock);if(held&&held.until<=this.clock)this.leases.delete(lock);
  if(op==='claim'){if(this.leases.has(lock))return 0;this.leases.set(lock,{owner,until:this.clock+Number(a[0])});return 1;}
  if(this.leases.get(lock)?.owner!==owner)return -1;
  if(op==='release'){this.leases.delete(lock);return 1;}
  if(op==='check')return 1;
  if(op==='persist'){
   if(this.failPersist)throw Error('isolated storage failure');
   if(this.m.has(lane)||this.m.has(journal))return -2;
   const [raw,cost,cap,countCap]=a;const day=Math.floor(this.clock/86400000);
   if(day!==this.day){this.used=0;this.count=0;this.day=day;}
   if(this.used+Number(cost)>Number(cap)||this.count>=Number(countCap))return -3;
   this.used+=Number(cost);this.count++;this.m.set(lane,raw);this.m.set(journal,raw);this.events.push('persist');
   if(this.losePersistReply){this.losePersistReply=false;throw Error('isolated lost storage reply');}return 1;
  }
  if(op==='finish'){
   if(!this.m.has(lane)||JSON.parse(this.m.get(lane)).hash!==a[1])return -2;
   this.m.set(journal,a[0]);this.m.delete(lane);return 1;
  }
  throw Error('unknown operation');
 }
}
function fixture({env:extraEnv={},...options}={}){
 const key='0x'+'19'.repeat(32),signer=new Wallet(key),winner=new Wallet('0x'+'20'.repeat(32));
 const config={chainId:56,version:2,protocolRevision:3,verified:true,address:'0x'+'31'.repeat(20),runtimeCodeHash:keccak256('0x1234'),evaluator:'0x'+'32'.repeat(20)};
 const storage=new MemoryRedis(),tasks=new Map([['1',{id:'1',phase:'Review',reviewDeadline:5000,requester:'0x'+'33'.repeat(20),evaluatorSigner:config.evaluator}]]);
 const broadcasts=[];let signed=0;
 const p={send:async()=> '0x38',getCode:async()=> '0x1234',getFeeData:async()=>({gasPrice:1000000000n}),estimateGas:async()=>100000n,getBalance:async()=>10n**18n,
 getTransactionCount:async()=>0,getTransactionReceipt:async()=>null,getBlockNumber:async()=>10,
 broadcastTransaction:async raw=>{assert.ok(storage.events.includes('persist'));broadcasts.push(raw);storage.events.push('broadcast');return {hash:keccak256(raw)};},destroy(){}};
 const decision={outcome:'winner',winner:winner.address};
 const opts={storage,config,readTask:async id=>tasks.get(String(id)),now:()=>1000,env:{MARKETPLACE_RELAYER_KEY:key,...extraEnv},providerFactory:()=>p,
 signDecision:async(task,d)=>{signed++;return {taskId:task.id,winner:d.winner,accepted:d.outcome==='winner',expiresAt:4000,signature:'0x'+'11'.repeat(65)};},...options};
 return {storage,p,opts,config,tasks,broadcasts,decision,signer,get signed(){return signed;},relay:createSettlementRelayer(opts)};
}

test('unconfigured dedicated key does not touch RPC, storage, or fallback attestation keys',async()=>{
 const f=fixture({env:{MARKETPLACE_RELAYER_KEY:'',MARKETPLACE_ATTESTATION_KEY:'0x'+'19'.repeat(32)}});
 f.opts.providerFactory=()=>{throw Error('must not run');};
 assert.deepEqual(await createSettlementRelayer(f.opts).settleTask('1'),{status:'blocked',code:'RELAYER_UNCONFIGURED',address:null,retryAt:1015,retryAfterSeconds:15});
 assert.equal(f.storage.m.size,0);assert.equal(f.broadcasts.length,0);
});
test('dedicated key must differ from active/retained evaluator and requester',async()=>{
 for(const variant of ['evaluator','ring','requester']){
  const f=fixture();if(variant==='evaluator')f.opts.env.MARKETPLACE_ATTESTATION_KEY=f.opts.env.MARKETPLACE_RELAYER_KEY;
  if(variant==='ring')f.opts.env.MARKETPLACE_ATTESTATION_KEYS_JSON=JSON.stringify({[f.signer.address]:f.opts.env.MARKETPLACE_RELAYER_KEY});
  if(variant==='requester')f.tasks.get('1').requester=f.signer.address;
  assert.equal((await f.relay.settleTask('1',f.decision)).code,'RELAYER_KEY_NOT_DEDICATED');assert.equal(f.broadcasts.length,0);
 }
});
test('raw signed transaction persisted before broadcast with exact destination, calldata, value, chain and nonce',async()=>{
 const f=fixture();const r=await f.relay.settleTask('1',f.decision);assert.equal(r.code,'RELAYER_BROADCAST');
 const tx=Transaction.from(f.broadcasts[0]);assert.equal(tx.chainId,56n);assert.equal(tx.to.toLowerCase(),f.config.address);assert.equal(tx.value,0n);assert.equal(tx.from,f.signer.address);assert.equal(tx.nonce,0);
 const call=marketplaceInterface.parseTransaction({data:tx.data});assert.equal(call.name,'selectWinner');assert.equal(String(call.args[0]),'1');assert.equal(call.args[1],f.decision.winner);
 assert.deepEqual(f.storage.events,['persist','broadcast']);assert.equal(f.storage.count,1);
});
test('network unknown outcome retries identical bytes and charges daily budget only once',async()=>{
 const f=fixture();f.p.broadcastTransaction=async raw=>{f.broadcasts.push(raw);throw Error('ambiguous timeout after acceptance');};
 assert.equal((await f.relay.settleTask('1',f.decision)).code,'RELAYER_BROADCAST_UNKNOWN');
 const restarted=createSettlementRelayer(f.opts);assert.equal((await restarted.settleTask('1',f.decision)).code,'RELAYER_BROADCAST_UNKNOWN');
 assert.equal(f.broadcasts.length,2);assert.equal(f.broadcasts[0],f.broadcasts[1]);assert.equal(f.signed,1);assert.equal(f.storage.count,1);
 f.tasks.set('2',{...f.tasks.get('1'),id:'2'});
 assert.equal((await restarted.settleTask('2',f.decision)).code,'RELAYER_NONCE_BUSY');assert.equal(f.signed,1);
});
test('persist failure never broadcasts; lost successful persist reply recovers journal without resigning',async()=>{
 const f=fixture();f.storage.failPersist=true;assert.equal((await f.relay.settleTask('1',f.decision)).code,'RELAYER_UNAVAILABLE');assert.equal(f.broadcasts.length,0);
 f.storage.failPersist=false;f.storage.losePersistReply=true;await f.relay.settleTask('1',f.decision);assert.equal(f.broadcasts.length,0);
 const signed=f.signed;assert.equal((await createSettlementRelayer(f.opts).settleTask('1',f.decision)).code,'RELAYER_BROADCAST');assert.equal(f.signed,signed);
});
test('two instances claim serial nonce lane; expiry fences old worker before persist/broadcast',async()=>{
 const f=fixture();let resume;let entered;const enteredP=new Promise(r=>entered=r);const pause=new Promise(r=>resume=r);
 const first=createSettlementRelayer({...f.opts,signDecision:async(...args)=>{entered();await pause;return f.opts.signDecision(...args);}});
 const run=first.settleTask('1',f.decision);await enteredP;
 assert.equal((await f.relay.settleTask('1',f.decision)).code,'RELAYER_BUSY');
 f.storage.clock+=31000;
 assert.equal((await f.relay.settleTask('1',f.decision)).code,'RELAYER_BROADCAST');resume();assert.equal((await run).code,'RELAYER_LEASE_LOST');
 assert.equal(f.broadcasts.length,1);assert.equal(f.storage.count,1);
});
test('confirmed payout is idempotent and revert never advances lane',async()=>{
 const f=fixture();await f.relay.settleTask('1',f.decision);
 f.p.getTransactionReceipt=async()=>({status:1,blockNumber:9});assert.equal((await f.relay.settleTask('1')).code,'RELAYER_CONFIRMING');
 f.p.getBlockNumber=async()=>11;f.tasks.get('1').phase='Settled';assert.equal((await f.relay.settleTask('1')).code,'RELAYER_CONFIRMED');
 assert.equal((await f.relay.settleTask('1')).status,'settled');assert.equal(f.broadcasts.length,1);assert.equal(f.signed,1);
 const g=fixture();await g.relay.settleTask('1',g.decision);g.p.getTransactionReceipt=async()=>({status:0,blockNumber:1});assert.equal((await g.relay.settleTask('1')).code,'RELAYER_TX_REVERTED');assert.ok([...g.storage.m.keys()].some(k=>k.endsWith(':lane')));
});
test('gas balance/price/limit/cost, external nonce and daily budgets fail closed',async()=>{
 const cases=[['RELAYER_GAS_BALANCE',f=>f.p.getBalance=async()=>0n],['RELAYER_GAS_PRICE_CAP',f=>f.p.getFeeData=async()=>({gasPrice:1000000001n})],
 ['RELAYER_GAS_LIMIT_CAP',f=>f.p.estimateGas=async()=>500000n],['RELAYER_TX_COST_CAP',f=>f.opts.env.MARKETPLACE_RELAYER_MAX_TX_COST_WEI='1'],
 ['RELAYER_EXTERNAL_NONCE_PENDING',f=>f.p.getTransactionCount=async(a,tag)=>tag==='pending'?1:0],['RELAYER_DAILY_BUDGET',f=>f.opts.env.MARKETPLACE_RELAYER_DAILY_COST_WEI='1']];
 for(const [code,mutate]of cases){const f=fixture();mutate(f);assert.equal((await f.relay.settleTask('1',f.decision)).code,code);assert.equal(f.broadcasts.length,0);assert.equal(f.storage.count,0);}
});
test('wrong chain/code/deployment, unknown decision and short review never sign a transaction',async()=>{
 for(const [code,mutate]of [['RELAYER_CHAIN_MISMATCH',f=>f.p.send=async()=> '0x1'],['RELAYER_CODE_MISMATCH',f=>f.p.getCode=async()=> '0xabcd'],
 ['RELAYER_DEPLOYMENT_INVALID',f=>f.config.version=1],['REVIEW_WINDOW_TOO_SHORT',f=>f.tasks.get('1').reviewDeadline=1100],['RELAYER_NOT_REVIEW',f=>f.tasks.get('1').phase='Open']]){
  const f=fixture();mutate(f);assert.equal((await f.relay.settleTask('1',f.decision)).code,code);assert.equal(f.broadcasts.length,0);assert.equal(f.signed,0);
 }
 const f=fixture();assert.equal((await f.relay.settleTask('1',{outcome:'pending'})).code,'DECISION_INVALID');
});
test('signed rejectAll receipt only, terminal task needs no transaction, no automatic refunds on expiry',async()=>{
 const f=fixture();const r=await f.relay.settleTask('1',{outcome:'no_acceptable_submission'});assert.equal(r.status,'pending');assert.equal(marketplaceInterface.parseTransaction({data:Transaction.from(f.broadcasts[0]).data}).name,'rejectAll');
 for(const phase of ['Settled','Refunded','Cancelled','Expired']){const g=fixture();g.tasks.get('1').phase=phase;const r=await g.relay.settleTask('1',g.decision);assert.equal(r.status,phase==='Expired'?'blocked':'settled');assert.equal(g.broadcasts.length,0);}
});
test('corrupted durable journal cannot turn replay into arbitrary transfer',async()=>{
 const f=fixture();await f.relay.settleTask('1',f.decision);const lane=[...f.storage.m.keys()].find(k=>k.endsWith(':lane'));
 const j=JSON.parse(f.storage.m.get(lane));j.raw=await f.signer.signTransaction({chainId:56,nonce:0,to:f.config.address,value:1n,gasLimit:21000,gasPrice:1});j.hash=keccak256(j.raw);f.storage.m.set(lane,JSON.stringify(j));
 assert.equal((await f.relay.settleTask('1')).code,'RELAYER_JOURNAL_INVALID');assert.equal(f.broadcasts.length,1);
});

// Uses existing compiled artifacts without invoking a compiler or modifying artifacts.
test('LOCAL ANVIL: real MAC/artifact preflight, receipt payout90/10, ambiguous send, two schedulers, rejection refund',async()=>{
 const names=['MARKETPLACE_ENCRYPTION_KEY','MARKETPLACE_AUTH_SECRET','MARKETPLACE_DECISION_KEY_ID','MARKETPLACE_DECISION_KEY','MARKETPLACE_ATTESTATION_KEY','MARKETPLACE_ATTESTATION_KEYS_JSON'];
 const saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));let chain,provider;
 try{
  const evaluator=Wallet.createRandom(),relayer=Wallet.createRandom(),storage=new MemoryRedis();
  process.env.MARKETPLACE_ENCRYPTION_KEY=randomBytes(32).toString('base64');process.env.MARKETPLACE_AUTH_SECRET=randomBytes(32).toString('hex');
  process.env.MARKETPLACE_DECISION_KEY_ID='relayer-test';process.env.MARKETPLACE_DECISION_KEY=randomBytes(32).toString('hex');
  process.env.MARKETPLACE_ATTESTATION_KEY=evaluator.privateKey;process.env.MARKETPLACE_ATTESTATION_KEYS_JSON='{}';
  const resolve=createRequire(new URL('../scripts/test-chain/package.json',import.meta.url)).resolve;
  const arch=process.arch==='x64'?'amd64':process.arch,binary=process.platform==='win32'?'anvil.exe':'anvil';
  const exe=resolve('@foundry-rs/anvil-'+process.platform+'-'+arch+'/bin/'+binary);
  chain=spawn(exe,['--host','127.0.0.1','--port','0','--chain-id','56','--hardfork','cancun','--gas-price','1000000000','--base-fee','0','--timestamp',String(Math.floor(Date.now()/1000)-5000)],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  const lines=createInterface({input:chain.stdout});
  const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local Anvil unavailable')),15000);chain.once('error',e=>{clearTimeout(timer);reject(e);});lines.on('line',line=>{const m=line.match(/Listening on (127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve('http://'+m[1]);}});});
  provider=new JsonRpcProvider(endpoint,56,{staticNetwork:true,cacheTimeout:-1,pollingInterval:20});
  const [owner,requester,worker,treasury]=await Promise.all([0,1,2,3].map(i=>provider.getSigner(i)));
  const addr=s=>s.getAddress(),send=async p=>(await p).wait();
  const artifact=n=>JSON.parse(readFileSync(new URL('../artifacts/marketplace-v2/'+n+'.json',import.meta.url),'utf8'));
  const deploy=async(n,args)=>{const a=artifact(n);const c=await new ContractFactory(a.abi,a.bytecode,owner).deploy(...args);await c.waitForDeployment();return c;};
  const registry=await deploy('MockAgentID',[]),token=await deploy('MockERC20',['USDC','USDC',18]);
  const escrow=await deploy('OneRubMarketplaceEscrowV2',[await registry.getAddress(),await addr(treasury),await token.getAddress(),evaluator.address]);
  const config={chainId:56,address:await escrow.getAddress(),version:2,protocolRevision:3,verified:true,evaluator:evaluator.address,runtimeCodeHash:keccak256(await provider.getCode(await escrow.getAddress()))};
  await send(registry.set(await addr(requester),1));await send(registry.set(await addr(worker),1));
  // Synthetic gas exists only on isolated localhost Anvil; never a live top-up.
  await provider.send('anvil_setBalance',[relayer.address,'0x16345785d8a0000']);
  assert.equal(await registry.balanceOf(relayer.address),0n);
  const readTask=async id=>{const t=await escrow.getTask(id);return {...taskView(id,t,await escrow.phaseOf(id)),readBlock:await provider.getBlockNumber(),evaluatorRevoked:await escrow.revokedEvaluator(t.evaluatorSigner)};};
  const metadata={title:'Local relayer arithmetic fixture',description:'Explain a checkable arithmetic calculation in detail.',rubric:'Correct arithmetic with reproducible reasoning. Reject unrelated responses.',category:'Research'};
  const pHash=policyHash(DEFAULT_POLICY);await storage.put('policy:'+pHash,{policy:DEFAULT_POLICY});
  const fixtures=[];
  for(let i=0;i<2;i++){
   const stamp=BigInt((await provider.getBlock('latest')).timestamp),id=String(await escrow.nextTaskId());
   await send(token.mint(await addr(requester),10n**18n));await send(token.connect(requester).approve(config.address,10n**18n));
   await send(escrow.connect(requester).createAndFund(await token.getAddress(),10n**18n,hash(metadata),stamp+3600n,stamp+7200n,pHash));
   await registerMetadata(id,await addr(requester),{metadata},{storage,readTask});
   await uploadArtifact(id,await addr(worker),{filename:'report.md',mimeType:'text/markdown',contentBase64:Buffer.from('A complete synthetic report with arithmetic explanation for local tests.').toString('base64')},{storage,readTask});
   const upload=await signUploadReceipt(await readTask(id),await addr(worker),{storage,config});
   await send(escrow.connect(worker).submitCommitment(id,upload.contentHash,upload.artifactPtrHash,upload.size,upload.expiresAt,upload.signature));fixtures.push(id);
  }
  await provider.send('evm_increaseTime',[3605]);await provider.send('evm_mine',[]);
  const decisions=[];
  for(const [i,id]of fixtures.entries())decisions.push(await evaluateTask(id,await addr(requester),{storage,config,readTask,readSubmission:(id,w)=>escrow.getSubmission(id,w),getWorkers:async()=>[await addr(worker)],evaluator:async()=>({winner:await addr(worker),score:i?10:95,acceptable:!i})}));
  assert.equal(decisions[0].outcome,'winner');assert.equal(decisions[1].outcome,'no_acceptable_submission');
  const raws=[];let loseReply=true;
  const transport=new Proxy(provider,{get(target,prop){if(prop==='destroy')return ()=>{};if(prop==='broadcastTransaction')return async raw=>{assert.ok(storage.events.includes('persist'));raws.push(raw);const r=await target.broadcastTransaction(raw);if(loseReply){loseReply=false;throw Error('Synthetic lost accepted-send reply');}return r;};const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;}});
  const options={storage,config,readTask,providerFactory:()=>transport,env:{MARKETPLACE_RELAYER_KEY:relayer.privateKey,MARKETPLACE_ATTESTATION_KEY:evaluator.privateKey},confirmations:3};
  const a=createSettlementRelayer(options),b=createSettlementRelayer(options);
  // A tampered MAC must fail before transaction persistence or broadcast.
  assert.equal((await a.settleTask(fixtures[0],{...decisions[0],score:1})).code,'DECISION_INVALID');assert.equal(raws.length,0);
  const raced=await Promise.all([a.settleTask(fixtures[0],decisions[0]),b.settleTask(fixtures[0],decisions[0])]);
  assert.ok(raced.some(r=>r.code==='RELAYER_BUSY'));assert.ok(raced.some(r=>r.code==='RELAYER_BROADCAST_UNKNOWN'),JSON.stringify(raced));assert.equal(raws.length,1);
  for(let i=0;i<3;i++)await provider.send('evm_mine',[]);
  assert.equal((await b.settleTask(fixtures[0])).code,'RELAYER_CONFIRMED');assert.equal((await a.settleTask(fixtures[0])).status,'settled');
  assert.equal(await token.balanceOf(await addr(worker)),9n*10n**17n);assert.equal(await token.balanceOf(await addr(treasury)),10n**17n);
  const rejection=await a.settleTask(fixtures[1],decisions[1]);assert.equal(rejection.code,'RELAYER_BROADCAST');
  for(let i=0;i<3;i++)await provider.send('evm_mine',[]);
  assert.equal((await b.settleTask(fixtures[1])).code,'RELAYER_CONFIRMED');
  assert.equal((await readTask(fixtures[1])).phase,'Refunded');assert.equal(await token.balanceOf(await addr(requester)),10n**18n);
  assert.equal(await token.balanceOf(config.address),0n);assert.equal(raws.length,2);assert.equal(Transaction.from(raws[1]).nonce,Transaction.from(raws[0]).nonce+1);
 }finally{
  provider?.destroy();if(chain?.pid&&chain.exitCode===null&&chain.signalCode===null){const stopped=once(chain,'exit');chain.kill();await stopped;}
  for(const [n,v]of Object.entries(saved)){if(v===undefined)delete process.env[n];else process.env[n]=v;}
 }
});
