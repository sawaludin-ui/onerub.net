// Admin-only isolated Redis Lua execution; synthetic keys, no task state or funds modified.
import {randomBytes}from'node:crypto';import{store}from'./marketplace-core.mjs';import{AUTOMATION_LUA}from'./marketplace-automation.mjs';import{RELAYER_LUA}from'./marketplace-relayer.mjs';
export async function smokeAutomationStorage({storage=store}={}){
 const prefix='onerub:ops-smoke:{'+randomBytes(16).toString('hex')+'}:',keys=['ready','delayed','running','jobs','finished','meta','budget'].map(k=>prefix+k),relay=['lease','lane','tx','cost'].map(k=>prefix+'relay:'+k),all=[...keys,...relay],checks=[];
 const eq=(name,value,expected)=>{if(value!==expected)throw Error('SMOKE_'+name);checks.push(name);};
 try{
  const run=(op,...args)=>storage.command('EVAL',AUTOMATION_LUA,String(keys.length),...keys,op,...args.map(String));
  const tm=await storage.command('TIME'),now=Number(tm[0]);
  eq('QUEUE_ENQUEUE',Number(await run('enqueue',JSON.stringify({id:'1',deadline:now+3600,nextAt:now-1,status:'queued'}),100)),1);
  const job=JSON.parse(await run('claim','owner-a'));eq('QUEUE_CLAIM',job.id,'1');eq('STALE_FENCE',Number(await run('check','1','owner-b',job.fence)),0);
  eq('QUEUE_FINISH',Number(await run('finish','1','owner-a',job.fence,JSON.stringify({status:'complete',terminal:true,code:'SYNTHETIC'}))),1);
  const count=JSON.parse(await run('inspect'));eq('QUEUE_NO_RUNNING',count.running,0);eq('QUEUE_RETAINED',count.retained,1);
  eq('BUDGET_ALLOW',Number((await run('budget',1))[0]),1);eq('BUDGET_DENY',Number((await run('budget',1))[0]),0);
  const rr=(op,token,...args)=>storage.command('EVAL',RELAYER_LUA,'4',...relay,op,token,...args.map(String));
  eq('RELAYER_CLAIM',Number(await rr('claim','owner-a',10000)),1);eq('RELAYER_RACE',Number(await rr('claim','owner-b',10000)),0);eq('RELAYER_WRONG_OWNER',Number(await rr('persist','owner-b','{}',1,10,10)),-1);
  const journal=JSON.stringify({hash:'synthetic',raw:'not-a-transaction'});eq('RELAYER_PERSIST',Number(await rr('persist','owner-a',journal,1,10,10)),1);
  eq('RELAYER_FINISH',Number(await rr('finish','owner-a',JSON.stringify({status:'settled'}),'synthetic')),1);
  return{status:'available',synthetic:true,checks,realRedisLuaExecuted:true,participantDataTouched:false,transactionBroadcast:false};
 }finally{if(!all.every(k=>k.startsWith(prefix)))throw Error('SMOKE_CLEANUP_SCOPE');await storage.command('DEL',...all);}
}
