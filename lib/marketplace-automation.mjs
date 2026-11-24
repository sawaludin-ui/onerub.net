// Node.js server only — durable, bounded review scheduling; never funds or refunds tasks.
import { randomBytes } from 'node:crypto';
import { store, storePrefix, getTask, withChain } from './marketplace-core.mjs';
import { evaluateTask, runEvaluator } from './marketplace-service.mjs';
import { createProviderQueue } from './marketplace-provider-queue.mjs';
import { MIN_SETTLEMENT_SECONDS } from './marketplace-policy.mjs';

// Fixed program: atomic EDF ready queue, delayed retries, expiry recovery and fenced ack.
export const AUTOMATION_LUA = `local tm=redis.call('TIME'); local now=tonumber(tm[1])+tonumber(tm[2])/1000000
local op=ARGV[1]
local function save(j) redis.call('HSET',KEYS[4],j.id,cjson.encode(j)) end
local function load(id) local s=redis.call('HGET',KEYS[4],id); if s then return cjson.decode(s) end end
if op=='scan' then
 local total=tonumber(ARGV[2]); local n=tonumber(ARGV[3]); local cursor=tonumber(redis.call('HGET',KEYS[6],'cursor') or '1'); if cursor>total then cursor=1 end
 local ids={}; for i=1,math.min(n,total) do table.insert(ids,tostring(cursor)); cursor=cursor+1; if cursor>total then cursor=1 end end
 redis.call('HSET',KEYS[6],'cursor',cursor,'total',total); return cjson.encode(ids)
elseif op=='enqueue' then
 local j=cjson.decode(ARGV[2]); local old=load(j.id); if old then return 0 end
 local expired=redis.call('ZRANGEBYSCORE',KEYS[5],'-inf',now-604800,'LIMIT',0,50); for _,id in ipairs(expired) do redis.call('ZREM',KEYS[5],id); redis.call('HDEL',KEYS[4],id) end
 if redis.call('HLEN',KEYS[4])>=tonumber(ARGV[3]) then return -1 end
 j.attempts=0; j.member=string.format('%020d',redis.call('HINCRBY',KEYS[6],'sequence',1))..':'..j.id; save(j); if j.nextAt>now then redis.call('ZADD',KEYS[2],j.nextAt,j.id) else redis.call('ZADD',KEYS[1],j.deadline,j.member) end; return 1
elseif op=='claim' then
 local expired=redis.call('ZRANGEBYSCORE',KEYS[3],'-inf',now,'LIMIT',0,50)
 for _,id in ipairs(expired) do local j=load(id); redis.call('ZREM',KEYS[3],id); if j then j.owner=nil; j.fence=nil; j.status='retry'; save(j); redis.call('ZADD',KEYS[1],j.deadline,j.member) end end
 local ready=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',now,'LIMIT',0,50)
 for _,id in ipairs(ready) do local j=load(id); redis.call('ZREM',KEYS[2],id); if j then redis.call('ZADD',KEYS[1],j.deadline,j.member) end end
 local ids=redis.call('ZRANGE',KEYS[1],0,0); if #ids==0 then return '' end
 local j=load(string.match(ids[1],':(.+)$')); redis.call('ZREM',KEYS[1],ids[1]); if not j then return '' end
 j.owner=ARGV[2]; j.fence=redis.call('HINCRBY',KEYS[6],'fence',1); j.leaseUntil=now+120; j.status='running'; j.attempts=j.attempts+1; save(j); redis.call('ZADD',KEYS[3],j.leaseUntil,j.id); return cjson.encode(j)
elseif op=='finish' or op=='check' then
 local j=load(ARGV[2]); if not j or j.owner~=ARGV[3] or j.fence~=tonumber(ARGV[4]) or j.leaseUntil<=now then return 0 end
 if op=='check' then return 1 end
 local update=cjson.decode(ARGV[5]); j.status=update.status; j.code=update.code; j.nextAt=update.nextAt; j.updatedAt=now; j.owner=nil; j.fence=nil; j.leaseUntil=nil; save(j); redis.call('ZREM',KEYS[3],j.id)
 if update.terminal then redis.call('ZADD',KEYS[5],now,j.id) elseif j.nextAt>now then redis.call('ZADD',KEYS[2],j.nextAt,j.id) else redis.call('ZADD',KEYS[1],j.deadline,j.member) end; return 1
elseif op=='budget' then
 local day=math.floor((now+25200)/86400); local prior=tonumber(redis.call('HGET',KEYS[7],'day') or '-1'); if prior~=day then redis.call('HSET',KEYS[7],'day',day,'used',0) end
 local used=tonumber(redis.call('HGET',KEYS[7],'used') or '0'); if used>=tonumber(ARGV[2]) then return {0,(day+1)*86400-25200,used} end
 redis.call('HINCRBY',KEYS[7],'used',1); redis.call('EXPIRE',KEYS[7],172800); return {1,0,used+1}
elseif op=='status' then return redis.call('HGET',KEYS[4],ARGV[2]) or ''
elseif op=='inspect' then
 return cjson.encode({ready=redis.call('ZCARD',KEYS[1]),delayed=redis.call('ZCARD',KEYS[2]),running=redis.call('ZCARD',KEYS[3]),retained=redis.call('HLEN',KEYS[4]),cursor=tonumber(redis.call('HGET',KEYS[6],'cursor') or '1'),total=tonumber(redis.call('HGET',KEYS[6],'total') or '0'),earliestReadyDeadline=tonumber(redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES')[2] or '0'),serverNow=math.floor(now),budgetUsed=tonumber(redis.call('HGET',KEYS[7],'day') or '-1')==math.floor((now+25200)/86400) and tonumber(redis.call('HGET',KEYS[7],'used') or '0') or 0})
end
return redis.error_reply('Unsupported automation operation')`;

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid automation '+name);
  return value;
}
function error(code, retryAt) { const e = new Error(code); e.code = code; if (retryAt) e.retryAt=retryAt; return e; }
function retrySeconds(result, now, fallback=15) {
  let at = Number(result?.retryAt);
  if (at > 1e11) at /= 1000; // Older relayer adapters use milliseconds.
  return Math.max(now+1, Number.isFinite(at)&&at>now ? Math.ceil(at) : now+Math.max(1,Math.min(86400,Number(result?.retryAfterSeconds)||fallback)));
}
export function capacityReport({pendingTasks=0,candidateCalls=pendingTasks,windowSeconds=3600,intervalMs=7000,dailyRemaining=Infinity}={}) {
  integer(pendingTasks,0,Number.MAX_SAFE_INTEGER,'pending count');
  integer(candidateCalls,0,Number.MAX_SAFE_INTEGER,'candidate count');
  integer(windowSeconds,1,Number.MAX_SAFE_INTEGER,'window'); integer(intervalMs,1000,60000,'provider interval');
  const slots=Math.floor(windowSeconds*1000/intervalMs);
  const available=Math.max(0,Math.min(slots,dailyRemaining));
  return {pendingTasks,candidateCalls,windowSeconds,intervalMs,maximumProviderSlots:slots,dailyRemaining:Number.isFinite(dailyRemaining)?dailyRemaining:null,
    minimumDispatchSeconds:Math.ceil(candidateCalls*intervalMs/1000),admissible:candidateCalls<=available,
    alert:candidateCalls>available?'CAPACITY_EXCEEDED':null,
    guarantee:false,scope:'automation-only; candidate count may be a lower bound; shared interactive traffic, model latency, discovery and cron cadence reduce capacity'};
}

export function createAutomation({storage=store,readTask=getTask,
  readTaskCount=()=>withChain(async(c,p,block)=>Number(await c.nextTaskId({blockTag:block}))-1),
  evaluate=evaluateTask,settle,providerQueue,
  enabled=process.env.MARKETPLACE_AUTOMATION_ENABLED==='true',
  dailyBudget=Number(process.env.MARKETPLACE_AUTOMATION_DAILY_LLM_BUDGET||100),
  maxRecords=10000,namespace=storePrefix+'automation:v1:',now=()=>Math.floor(Date.now()/1000),clockMs=Date.now,
  fetchImpl=globalThis.fetch}={}) {
  integer(dailyBudget,0,100000,'daily budget'); integer(maxRecords,1,100000,'queue capacity');
  if (!storage?.command || typeof namespace!=='string' || !namespace || namespace.length>256) throw new Error('Durable automation storage required');
  const keys=['ready','delayed','running','jobs','finished','meta','budget'].map(s=>namespace+s);
  const command=async(op,...args)=>storage.command('EVAL',AUTOMATION_LUA,String(keys.length),...keys,op,...args.map(String));
  const parse=value=>value?JSON.parse(value):null;
  const inspect=async()=>{const s=parse(await command('inspect')); return {...s,pending:s.ready+s.delayed+s.running,dailyBudget,budgetScope:'automation-only'};};
  const enqueue=async task=>{
    const id=String(task.id); if (!/^[1-9][0-9]*$/.test(id)) throw new Error('Invalid automation task id');
    if (['Settled','Refunded','Cancelled'].includes(task.phase)) return {enqueued:false,terminal:true};
    if (!['Open','Review','Expired'].includes(task.phase)) return {enqueued:false,code:'UNSUPPORTED_PHASE'};
    const deadline=integer(Number(task.reviewDeadline),1,Number.MAX_SAFE_INTEGER,'review deadline');
    const nextAt=task.phase==='Open'?integer(Number(task.submissionDeadline),1,Number.MAX_SAFE_INTEGER,'submission deadline'):now();
    const n=Number(await command('enqueue',JSON.stringify({id,deadline,nextAt,status:task.phase==='Open'?'waiting':'queued'}),maxRecords));
    return {enqueued:n===1,code:n<0?'QUEUE_CAPACITY_EXCEEDED':undefined};
  };
  async function tick({maxDiscovery=25,maxJobs=10,budgetMs=45000}={}) {
    integer(maxDiscovery,0,50,'discovery bound'); integer(maxJobs,0,10,'job bound'); integer(budgetMs,100,45000,'tick budget');
    if (!enabled) return {enabled:false,status:'disabled',code:'AUTOMATION_DISABLED'};
    const end=clockMs()+budgetMs, summary={enabled:true,discovered:0,claimed:0,completed:0,deferred:0,missed:0,fenced:0,alerts:[]};
    const alert=code=>{if(code&&!summary.alerts.includes(code))summary.alerts.push(code);};
    const remaining=()=>Math.max(0,end-clockMs());
    if(maxDiscovery && remaining()>2000){
      const total=integer(Number(await readTaskCount()),0,Number.MAX_SAFE_INTEGER,'chain task count');
      // Advance one item at a time: a short tick must not permanently skip a batch tail.
      const discoveryEnd=clockMs()+Math.min(10000,budgetMs/3);
      for(let index=0;index<Math.min(maxDiscovery,total);index++){
        if(remaining()<2000||clockMs()>=discoveryEnd)break;
        const [id]=parse(await command('scan',total,1));
        try { const result=await enqueue(await readTask(id)); summary.discovered++; alert(result.code); }
        catch(e){alert(e.code==='NOT_FOUND'?'DISCOVERY_REORG':'DISCOVERY_RETRY');}
      }
    }
    let queue;
    for(let i=0;i<maxJobs&&remaining()>2000;i++){
      const job=parse(await command('claim',randomBytes(24).toString('hex'))); if(!job)break;
      summary.claimed++;
      const owned=async()=>{if(Number(await command('check',job.id,job.owner,job.fence))!==1)throw error('AUTOMATION_LEASE_LOST');};
      const finish=async(update)=>{
        const ok=Number(await command('finish',job.id,job.owner,job.fence,JSON.stringify(update)))===1;
        if(!ok)summary.fenced++; return ok;
      };
      let update;
      try{
        const task=await readTask(job.id), time=now();
        if(['Settled','Refunded','Cancelled'].includes(task.phase)) update={status:'complete',terminal:true,code:'CHAIN_TERMINAL'};
        else if(task.phase==='Expired'||Number(task.reviewDeadline)-time<MIN_SETTLEMENT_SECONDS) update={status:'missed',terminal:true,code:'REVIEW_DEADLINE_MISSED'};
        else if(task.phase!=='Review') update={status:'waiting',nextAt:Math.max(time+15,Number(task.submissionDeadline)||time+60),code:'WAITING_REVIEW'};
        else{
          if(!queue) queue=providerQueue||createProviderQueue({storage});
          const dispatch={intervalMs:queue.intervalMs,
            async reserve(){
              await owned(); if(remaining()<2000)throw error('AUTOMATION_TICK_BUDGET',now()+15);
              const permit=await queue.reserve(); if(!permit.admitted)return permit;
              try{
                await owned(); const value=await command('budget',dailyBudget);
                if(Number(value[0])!==1)throw error('DAILY_LLM_BUDGET',Number(value[1]));
                return permit;
              }catch(e){await queue.finish(permit,0);throw e;}
            },finish:(...args)=>queue.finish(...args)};
          // No detached Promise.race: only the HTTP request is aborted and awaited.
          const evaluator=(t,records,metadata,options)=>runEvaluator(t,records,metadata,{...options,transport:{...options.transport,
            fetchImpl:(url,init)=>{const ms=Math.floor(remaining()-1500);if(ms<1)throw error('AUTOMATION_TICK_BUDGET');
              return fetchImpl(url,{...init,signal:AbortSignal.any([init.signal,AbortSignal.timeout(ms)].filter(Boolean))});}}});
          await owned();
          const decision=await evaluate(job.id,task.requester,{storage,readTask,now,providerQueue:dispatch,evaluator});
          await owned();
          if(decision.status==='cooldown'||decision.status==='evaluating'||decision.outcome==='pending')
            update={status:'pending',code:decision.code||'EVALUATION_PENDING',nextAt:retrySeconds(decision,now(),Math.ceil(queue.intervalMs/1000))};
          else if(!settle) update={status:'blocked',code:'RELAYER_UNCONFIGURED',nextAt:now()+60};
          else if(remaining()<2000) update={status:'pending',code:'AUTOMATION_TICK_BUDGET',nextAt:now()+15};
          else {
            const fresh=await readTask(job.id); await owned();
            if(['Settled','Refunded'].includes(fresh.phase))update={status:'complete',terminal:true,code:'CHAIN_TERMINAL'};
            else if(fresh.phase!=='Review'||fresh.reviewDeadline-now()<MIN_SETTLEMENT_SECONDS)update={status:'missed',terminal:true,code:'REVIEW_DEADLINE_MISSED'};
            else{const result=await settle(fresh,decision); update=['settled','done'].includes(result.status)?{status:'complete',terminal:true,code:result.code||'SETTLED'}:
              {status:result.status==='blocked'?'blocked':'pending',code:result.code||'SETTLEMENT_PENDING',nextAt:Math.min(now()+60,retrySeconds(result,now()))};}
          }
        }
      }catch(e){
        const code=/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code||'')?e.code:'AUTOMATION_RETRY';
        update={status:code==='DAILY_LLM_BUDGET'?'blocked':'retry',code,nextAt:retrySeconds(e,now(),Math.min(60,2**Math.min(job.attempts,6)))};
      }
      if(await finish(update)){
        if(update.status==='complete')summary.completed++;
        else if(update.status==='missed')summary.missed++;
        else summary.deferred++;
        if(update.status==='blocked'||update.status==='missed'||update.status==='retry')alert(update.code);
      }
    }
    const state=await inspect();
    const reviewWindow=state.earliestReadyDeadline>0?Math.max(1,Math.min(3600,state.earliestReadyDeadline-state.serverNow-MIN_SETTLEMENT_SECONDS)):3600;
    const capacity=capacityReport({pendingTasks:state.pending,candidateCalls:state.pending,windowSeconds:reviewWindow,dailyRemaining:Math.max(0,dailyBudget-state.budgetUsed),intervalMs:queue?.intervalMs||7000});
    if(state.total>state.retained)alert('DISCOVERY_INCOMPLETE_OR_TERMINAL');
    alert(capacity.alert);
    return {...summary,status:'bounded_tick',budgetExhausted:remaining()<2000,queue:state,capacity,
      timing:'Cooperative 45s budget with abortable model HTTP; existing Redis/chain IO timeouts can add overhead. No throughput or completion guarantee.'};
  }
  return {tick,enqueue,inspect,status:async id=>{const j=parse(await command('status',id)); if(!j)return null; const {owner,fence,leaseUntil,...safe}=j;return safe;}};
}
