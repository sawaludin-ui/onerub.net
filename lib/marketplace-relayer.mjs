// Server-only receipt relayer; no wallet tooling, key generation, or account funding.
import { randomUUID } from 'node:crypto';
import { Wallet, Transaction, FetchRequest, JsonRpcProvider, keccak256, getAddress } from 'ethers';
import { deployment, store, getTask, marketplaceInterface, taskId } from './marketplace-core.mjs';
import { signReviewDecision } from './marketplace-attestation.mjs';
import { MIN_SETTLEMENT_SECONDS } from './marketplace-policy.mjs';

// Redis TIME fences every mutation. Unknown-outcome raw journals never expire.
export const RELAYER_LUA = `
local tm=redis.call('TIME'); local now=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)
local op=ARGV[1]; local token=ARGV[2]
if op=='claim' then
 if redis.call('EXISTS',KEYS[1])==1 then return 0 end
 redis.call('SET',KEYS[1],token,'PX',ARGV[3]); return 1
end
if redis.call('GET',KEYS[1])~=token then return -1 end
if op=='release' then redis.call('DEL',KEYS[1]); return 1 end
if op=='check' then return 1 end
if op=='persist' then
 if redis.call('EXISTS',KEYS[2])==1 or redis.call('EXISTS',KEYS[3])==1 then return -2 end
 local day=math.floor(now/86400000); local oldday=tonumber(redis.call('HGET',KEYS[4],'day') or '-1')
 local used=0; local count=0; if oldday==day then used=tonumber(redis.call('HGET',KEYS[4],'used') or '0'); count=tonumber(redis.call('HGET',KEYS[4],'count') or '0') end
 if used+tonumber(ARGV[4])>tonumber(ARGV[5]) or count>=tonumber(ARGV[6]) then return -3 end
 redis.call('HSET',KEYS[4],'day',day,'used',used+tonumber(ARGV[4]),'count',count+1)
 redis.call('EXPIRE',KEYS[4],172800)
 redis.call('SET',KEYS[2],ARGV[3]); redis.call('SET',KEYS[3],ARGV[3]); return 1
end
if op=='finish' then
 local lane=redis.call('GET',KEYS[2]); if not lane or cjson.decode(lane).hash~=ARGV[4] then return -2 end
 redis.call('SET',KEYS[3],ARGV[3]); redis.call('DEL',KEYS[2]); return 1
end
return -4
`;
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const terminal = t => ['Settled','Refunded','Cancelled'].includes(t.phase);
const error = code => { const e=new Error(code); e.relayerCode=code; throw e; };
const integer = (value,fallback,min,max) => {
 const n=Number(value??fallback); if(!Number.isSafeInteger(n)||n<min||n>max)error('RELAYER_CONFIG_INVALID'); return n;
};
function providerDefault() {
 const req=new FetchRequest(process.env.BSC_RPC_URL||'https://bsc-dataseed.bnbchain.org'); req.timeout=7000;
 return new JsonRpcProvider(req,56,{staticNetwork:true,cacheTimeout:-1});
}
export function createSettlementRelayer({storage=store,config=deployment,readTask=getTask,
 signDecision=signReviewDecision,providerFactory=providerDefault,env=process.env,now=()=>Math.floor(Date.now()/1000),
 leaseMs=30000,confirmations=3}={}) {
 let address=null;
 const result=(status,code,extra={})=>({status,code,address,...(status==='settled'?{}:{retryAt:now()+15,retryAfterSeconds:15}),...extra});
 const keys=(who,id)=>{
  // Signer-global nonce lane, deliberately not partitioned by escrow deployment.
  const base='onerub:relayer:{56:'+who.toLowerCase()+'}:';
  return [base+'lease',base+'lane',base+config.address.toLowerCase()+':task:'+id,base+'budget'];
 };
 const command=(op,token,k,...args)=>storage.command('EVAL',RELAYER_LUA,'4',...k,op,token,...args.map(String));
 const read=async key=>{const s=await storage.command('GET',key);return s?JSON.parse(s):null;};
 function wallet() {
  if(!env.MARKETPLACE_RELAYER_KEY)error('RELAYER_UNCONFIGURED');
  let w;try{w=new Wallet(env.MARKETPLACE_RELAYER_KEY);}catch{error('RELAYER_KEY_INVALID');}
  address=w.address;
  // No fallback to an attestation, deployment, requester, or personal wallet key.
  if([config.evaluator,config.deployer,config.treasury].some(a=>same(a,address)))error('RELAYER_KEY_NOT_DEDICATED');
  try {
   const att=env.MARKETPLACE_ATTESTATION_KEY?new Wallet(env.MARKETPLACE_ATTESTATION_KEY):null;
   const ring=JSON.parse(env.MARKETPLACE_ATTESTATION_KEYS_JSON||'{}');
   if(same(att?.address,address)||Object.entries(ring).some(([a,k])=>same(a,address)||same(new Wallet(k).address,address)))error('RELAYER_KEY_NOT_DEDICATED');
  }catch(e){if(e.relayerCode)throw e;error('RELAYER_KEYRING_INVALID');}
  return w;
 }
 function validateJournal(j,w) {
  let tx;try{tx=Transaction.from(j.raw);}catch{error('RELAYER_JOURNAL_INVALID');}
  if(!tx.isSigned()||!same(tx.from,w.address)||!same(tx.to,config.address)||tx.chainId!==56n||tx.value!==0n||tx.hash!==j.hash||String(tx.nonce)!==String(j.nonce))error('RELAYER_JOURNAL_INVALID');
  let call;try{call=marketplaceInterface.parseTransaction({data:tx.data});}catch{error('RELAYER_JOURNAL_INVALID');}
  if(!['selectWinner','rejectAll'].includes(call?.name)||String(call.args[0])!==j.taskId)error('RELAYER_JOURNAL_INVALID');
  return tx;
 }
 async function reconcile(j,w,p,token,k) {
  validateJournal(j,w);
  const receipt=await p.getTransactionReceipt(j.hash);
  if(receipt){
   if(Number(receipt.status)!==1)return result('blocked','RELAYER_TX_REVERTED',{txHash:j.hash});
   const head=await p.getBlockNumber();
   if(head-Number(receipt.blockNumber)+1<confirmations)return result('pending','RELAYER_CONFIRMING',{txHash:j.hash});
   const task=await readTask(j.taskId);
   if(!terminal(task))return result('blocked','RELAYER_RECEIPT_STATE_MISMATCH',{txHash:j.hash});
   const saved={...j,status:'settled',blockNumber:Number(receipt.blockNumber)};
   if(Number(await command('finish',token,k,JSON.stringify(saved),j.hash))!==1)error('RELAYER_LEASE_LOST');
   return result('settled','RELAYER_CONFIRMED',{txHash:j.hash,taskId:j.taskId});
  }
  // Expiry, insufficient funds, nonce-too-low, timeout, and already-known errors
  // all preserve this EXACT raw transaction. Never replace or advance its nonce.
  if(Number(await command('check',token,k))!==1)error('RELAYER_LEASE_LOST');
  try { await p.broadcastTransaction(j.raw); } catch { return result('pending','RELAYER_BROADCAST_UNKNOWN',{txHash:j.hash,taskId:j.taskId}); }
  return result('pending','RELAYER_BROADCAST',{txHash:j.hash,taskId:j.taskId});
 }
 async function settleTask(taskOrId,decision) {
  let p,token,k;
  try {
   const id=taskId(typeof taskOrId==='object'?taskOrId.id:taskOrId);
   if(config.chainId!==56||config.version!==2||config.protocolRevision!==3||!config.verified||!config.runtimeCodeHash)error('RELAYER_DEPLOYMENT_INVALID');
   const w=wallet(); k=keys(w.address,id); token=randomUUID();
   if(Number(await command('claim',token,k,integer(leaseMs,30000,1000,60000)))!==1)return result('pending','RELAYER_BUSY');
   p=await providerFactory();
   if(Number(BigInt(await p.send('eth_chainId',[])))!==56)error('RELAYER_CHAIN_MISMATCH');
   if(keccak256(await p.getCode(config.address))!==config.runtimeCodeHash)error('RELAYER_CODE_MISMATCH');
   const lane=await read(k[1]);
   if(lane){
    const laneKeys=keys(w.address,lane.taskId);
    const outcome=await reconcile(lane,w,p,token,laneKeys);
    if(lane.taskId===id)return outcome;
    if(outcome.status!=='settled')return result(outcome.status,'RELAYER_NONCE_BUSY',{txHash:lane.hash});
   }
   const existing=await read(k[2]);
   if(existing){validateJournal(existing,w);return result(existing.status==='settled'?'settled':'blocked',existing.status==='settled'?'RELAYER_CONFIRMED':'RELAYER_JOURNAL_PENDING',{txHash:existing.hash});}
   const task=await readTask(id);
   if(terminal(task))return result('settled','RELAYER_ALREADY_TERMINAL');
   if(task.phase!=='Review')return result('blocked','RELAYER_NOT_REVIEW');
   if(Number(task.reviewDeadline)-now()<MIN_SETTLEMENT_SECONDS)return result('blocked','REVIEW_WINDOW_TOO_SHORT');
   if(same(w.address,task.evaluatorSigner)||same(w.address,task.requester))error('RELAYER_KEY_NOT_DEDICATED');
   const d=decision||await storage.get('decision:'+id);
   if(!d)return result('blocked','EVALUATION_REQUIRED');
   if(!['winner','no_acceptable_submission'].includes(d.outcome))error('DECISION_INVALID');
   // This API verifies the decision MAC and current artifact commitments/retention.
   const receipt=await signDecision(task,d,{storage,config});
   const accepted=d.outcome==='winner';
   if(receipt.accepted!==accepted||String(receipt.taskId)!==id||accepted&&!same(receipt.winner,d.winner))error('DECISION_INVALID');
   const data=marketplaceInterface.encodeFunctionData(accepted?'selectWinner':'rejectAll',accepted?[id,d.winner,receipt.expiresAt,receipt.signature]:[id,receipt.expiresAt,receipt.signature]);
   const priceCap=BigInt(integer(env.MARKETPLACE_RELAYER_MAX_GAS_PRICE_WEI,1000000000,1,1000000000));
   const gasCap=BigInt(integer(env.MARKETPLACE_RELAYER_MAX_GAS,500000,21000,500000));
   const costCap=BigInt(integer(env.MARKETPLACE_RELAYER_MAX_TX_COST_WEI,500000000000000,1,500000000000000));
   const dailyCap=integer(env.MARKETPLACE_RELAYER_DAILY_COST_WEI,5000000000000000,1,8000000000000000);
   const dailyCount=integer(env.MARKETPLACE_RELAYER_DAILY_TX_LIMIT,100,1,1000);
   const fees=await p.getFeeData(); const gasPrice=fees.gasPrice;
   if(gasPrice===null||gasPrice<=0n||gasPrice>priceCap)return result('blocked','RELAYER_GAS_PRICE_CAP');
   const request={to:getAddress(config.address),from:w.address,data,value:0n};
   const estimate=await p.estimateGas(request); const gasLimit=(estimate*120n+99n)/100n;
   if(gasLimit>gasCap)return result('blocked','RELAYER_GAS_LIMIT_CAP');
   const cost=gasLimit*gasPrice;if(cost>costCap)return result('blocked','RELAYER_TX_COST_CAP');
   if(await p.getBalance(w.address)<cost)return result('blocked','RELAYER_GAS_BALANCE');
   const latest=await p.getTransactionCount(w.address,'latest');
   const nonce=await p.getTransactionCount(w.address,'pending');
   if(latest!==nonce)return result('blocked','RELAYER_EXTERNAL_NONCE_PENDING');
   const raw=await w.signTransaction({to:request.to,data,value:0n,chainId:56,type:0,nonce,gasLimit,gasPrice});
   const journal={taskId:id,nonce,raw,hash:keccak256(raw),status:'pending'};
   validateJournal(journal,w);
   const persisted=Number(await command('persist',token,k,JSON.stringify(journal),cost,dailyCap,dailyCount));
   if(persisted===-3)return result('blocked','RELAYER_DAILY_BUDGET');
   if(persisted!==1)error('RELAYER_LEASE_LOST');
   // Read-after-write before ANY broadcast, including a storage timeout recovery.
   const saved=await read(k[1]);if(saved?.hash!==journal.hash||saved.raw!==raw)error('RELAYER_PERSISTENCE_UNCONFIRMED');
   return await reconcile(saved,w,p,token,k);
  }catch(e){return result('blocked',e.relayerCode||(['DECISION_INVALID','ARTIFACT_MISMATCH','EVALUATOR_REVOKED','ATTESTATION_UNAVAILABLE','REVIEW_WINDOW_TOO_SHORT','STORAGE_UNAVAILABLE'].includes(e.code)?e.code:'RELAYER_UNAVAILABLE'));}
  finally {
   if(token&&k)try{await command('release',token,k);}catch{/* Redis lease expires; no unguarded writes. */}
   p?.destroy?.();
  }
 }
 return {settleTask,status:()=>{let code;try{wallet();}catch(e){code=e.relayerCode||'RELAYER_UNAVAILABLE';}return{configured:Boolean(env.MARKETPLACE_RELAYER_KEY)&&!code,address,chainId:56,automaticTopUp:false,...(code?{code}:{})};}};
}
let singleton;
export const settleTask=(task,decision)=>(singleton??=createSettlementRelayer()).settleTask(task,decision);
