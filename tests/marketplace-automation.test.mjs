// Node.js — isolated queue-state tests; no provider, production Redis, or transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAutomation,capacityReport,AUTOMATION_LUA} from '../lib/marketplace-automation.mjs';

// Atomic Redis state-machine double. This tests client protocol, not Lua execution.
class RedisDouble {
  constructor(time){this.time=time;this.jobs=new Map();this.ready=new Map();this.delayed=new Map();this.running=new Map();this.finished=new Map();this.cursor=1;this.fence=0;this.sequence=0;this.total=0;this.day=-1;this.used=0;this.commands=[];}
  ordered(map){return [...map].sort((a,b)=>a[1]-b[1]||a[0].localeCompare(b[0]));}
  async command(cmd,lua,n,...rest){
    assert.equal(cmd,'EVAL');assert.equal(lua,AUTOMATION_LUA);assert.equal(n,'7');
    const keys=rest.splice(0,7);assert.equal(new Set(keys).size,7);
    const [op,...args]=rest;this.commands.push(op);const now=this.time();
    if(op==='scan'){
      const [total,n]=args.map(Number);this.total=total;if(this.cursor>total)this.cursor=1;
      const ids=[];for(let i=0;i<Math.min(n,total);i++){ids.push(String(this.cursor++));if(this.cursor>total)this.cursor=1;}return JSON.stringify(ids);
    }
    if(op==='enqueue'){
      const j=JSON.parse(args[0]);if(this.jobs.has(j.id))return 0;
      for(const [id] of this.ordered(this.finished).filter(([,at])=>at<=now-604800).slice(0,50)){this.finished.delete(id);this.jobs.delete(id);}
      if(this.jobs.size>=Number(args[1]))return -1;j.attempts=0;j.member=String(++this.sequence).padStart(20,'0')+':'+j.id;this.jobs.set(j.id,j);(j.nextAt>now?this.delayed:this.ready).set(j.nextAt>now?j.id:j.member,j.nextAt>now?j.nextAt:j.deadline);return 1;
    }
    if(op==='claim'){
      for(const [id] of this.ordered(this.running).filter(([,at])=>at<=now).slice(0,50)){this.running.delete(id);const j=this.jobs.get(id);delete j.owner;delete j.fence;j.status='retry';this.ready.set(j.member,j.deadline);}
      for(const [id] of this.ordered(this.delayed).filter(([,at])=>at<=now).slice(0,50)){this.delayed.delete(id);this.ready.set(this.jobs.get(id).member,this.jobs.get(id).deadline);}
      const member=this.ordered(this.ready)[0]?.[0];if(!member)return '';this.ready.delete(member);const id=member.split(':')[1],j=this.jobs.get(id);
      Object.assign(j,{owner:args[0],fence:++this.fence,leaseUntil:now+120,status:'running',attempts:j.attempts+1});this.running.set(id,j.leaseUntil);return JSON.stringify(j);
    }
    if(op==='check'||op==='finish'){
      const j=this.jobs.get(args[0]);if(!j||j.owner!==args[1]||j.fence!==Number(args[2])||j.leaseUntil<=now)return 0;
      if(op==='check')return 1;const u=JSON.parse(args[3]);Object.assign(j,{status:u.status,code:u.code,nextAt:u.nextAt,updatedAt:now});delete j.owner;delete j.fence;delete j.leaseUntil;this.running.delete(j.id);
      if(u.terminal)this.finished.set(j.id,now);else (j.nextAt>now?this.delayed:this.ready).set(j.nextAt>now?j.id:j.member,j.nextAt>now?j.nextAt:j.deadline);return 1;
    }
    if(op==='budget'){
      const day=Math.floor((now+25200)/86400);if(day!==this.day){this.used=0;this.day=day;}
      if(this.used>=Number(args[0]))return [0,(day+1)*86400-25200,this.used];return [1,0,++this.used];
    }
    if(op==='status')return this.jobs.has(args[0])?JSON.stringify(this.jobs.get(args[0])):'';
    if(op==='inspect')return JSON.stringify({ready:this.ready.size,delayed:this.delayed.size,running:this.running.size,retained:this.jobs.size,cursor:this.cursor,total:this.total,earliestReadyDeadline:this.ordered(this.ready)[0]?.[1]||0,serverNow:now,budgetUsed:this.day===Math.floor((now+25200)/86400)?this.used:0});
    throw Error('unsupported '+op);
  }
  raw(op,...args){return this.command('EVAL',AUTOMATION_LUA,'7',...['ready','delayed','running','jobs','finished','meta','budget'],op,...args.map(String));}
}
function setup(overrides={}){
  const state={seconds:1795500000,ms:0,calls:0,settlements:0};
  const storage=new RedisDouble(()=>state.seconds);
  const task=id=>({id:String(id),requester:'0x1111111111111111111111111111111111111111',phase:'Review',submissionDeadline:state.seconds-1,reviewDeadline:1795600000,submissionCount:1});
  const providerQueue={intervalMs:7000,async reserve(){return {admitted:true,owner:'mock-permit'};},async finish(){return {retryAt:state.seconds+7};}};
  const options={enabled:true,storage,readTask:async id=>task(id),readTaskCount:async()=>1,now:()=>state.seconds,clockMs:()=>state.ms,providerQueue,dailyBudget:10000,
    evaluate:async(id,who,{providerQueue:q})=>{assert.equal(who,task(id).requester);const p=await q.reserve();if(!p.admitted)return {status:'cooldown',...p};try{state.calls++;return {outcome:'winner',coverage:{complete:true},private:'must not leak'};}finally{await q.finish(p);}},
    settle:async()=>{state.settlements++;return {status:'settled',code:'SETTLED'};},...overrides};
  return {state,storage,task,options,automation:createAutomation(options)};
}

test('capacity refuses 1000 tasks in one hour even at one candidate each',()=>{
  const r=capacityReport({pendingTasks:1000});assert.equal(r.admissible,false);assert.equal(r.maximumProviderSlots,514);assert.equal(r.minimumDispatchSeconds,7000);assert.equal(r.alert,'CAPACITY_EXCEEDED');assert.equal(r.guarantee,false);
  assert.equal(capacityReport({pendingTasks:101,dailyRemaining:100}).admissible,false);
  assert.equal(capacityReport({pendingTasks:12,candidateCalls:12}).admissible,true);
});
test('disabled scheduler has no storage or chain side effects',async()=>{
  const x=setup({enabled:false});assert.equal((await x.automation.tick()).status,'disabled');assert.equal(x.storage.commands.length,0);assert.equal(x.state.calls,0);
});
test('bounded discovery persists cursor and cycles over older active tasks',async()=>{
  const x=setup({readTaskCount:async()=>1000});
  for(let i=0;i<20;i++){const s=await x.automation.tick({maxDiscovery:50,maxJobs:0});assert.equal(s.discovered,50);}
  assert.equal((await x.automation.inspect()).pending,1000);assert.equal(x.storage.cursor,1);
  const next=createAutomation(x.options);assert.equal((await next.tick({maxDiscovery:1,maxJobs:0})).discovered,1);assert.equal((await next.inspect()).retained,1000);
});
test('1000 isolated tasks drain in bounded batches, never all calls per tick',async()=>{
  const x=setup({readTaskCount:async()=>1000});
  for(let i=1;i<=1000;i++)await x.automation.enqueue(x.task(i));
  for(let i=0;i<100;i++){const s=await x.automation.tick({maxDiscovery:0,maxJobs:10});assert.equal(s.claimed,10);assert.equal(s.completed,10);assert.ok(!JSON.stringify(s).includes('must not leak'));}
  assert.equal(x.state.calls,1000);assert.equal(x.state.settlements,1000);assert.equal((await x.automation.inspect()).pending,0);
});
test('two simultaneous instances never evaluate the same claimed task',async()=>{
  const x=setup();const active=new Set();const seen=[];
  const evaluate=async(id)=>{assert.ok(!active.has(id));active.add(id);seen.push(id);await new Promise(r=>setImmediate(r));active.delete(id);return {outcome:'winner'};};
  const a=createAutomation({...x.options,evaluate}),b=createAutomation({...x.options,evaluate});
  for(let i=1;i<=20;i++)await a.enqueue(x.task(i));
  await Promise.all([a.tick({maxDiscovery:0}),b.tick({maxDiscovery:0})]);assert.equal(new Set(seen).size,20);assert.equal(seen.length,20);
});
test('expired claim recovers and stale ack is fenced',async()=>{
  const x=setup();await x.automation.enqueue(x.task(1));const old=JSON.parse(await x.storage.raw('claim','old'));
  assert.equal(await x.storage.raw('claim','other'),'');x.state.seconds+=121;const current=JSON.parse(await x.storage.raw('claim','new'));
  assert.ok(current.fence>old.fence);assert.equal(await x.storage.raw('check','1',old.owner,old.fence),0);
  assert.equal(await x.storage.raw('finish','1',old.owner,old.fence,JSON.stringify({status:'complete',terminal:true})),0);
  assert.equal(await x.storage.raw('finish','1',current.owner,current.fence,JSON.stringify({status:'retry',nextAt:x.state.seconds+15})),1);
  assert.equal((await x.automation.status('1')).status,'retry');assert.equal((await x.automation.status('1')).owner,undefined);
});
test('ready jobs use earliest review deadline first',async()=>{
  const x=setup();await x.automation.enqueue({...x.task(1),reviewDeadline:x.state.seconds+1000});await x.automation.enqueue({...x.task(2),reviewDeadline:x.state.seconds+500});
  const j=JSON.parse(await x.storage.raw('claim','worker'));assert.equal(j.id,'2');
});
test('equal review deadlines preserve FIFO admission order rather than lexical IDs',async()=>{
  const x=setup();for(const id of [9,2,11])await x.automation.enqueue(x.task(id));
  const order=[];for(let i=0;i<3;i++)order.push(JSON.parse(await x.storage.raw('claim','worker'+i)).id);assert.deepEqual(order,['9','2','11']);
});
test('Open task waits until Review and rereads authoritative phase',async()=>{
  const x=setup();let phase='Open';const a=createAutomation({...x.options,readTask:async id=>({...x.task(id),phase,submissionDeadline:1795500100})});
  await a.enqueue({...x.task(1),phase,submissionDeadline:x.state.seconds+100});assert.equal((await a.tick({maxDiscovery:0})).claimed,0);assert.equal(x.state.calls,0);
  x.state.seconds+=100;phase='Review';await a.tick({maxDiscovery:0});assert.equal(x.state.calls,1);
});
test('late task is explicit missed, never evaluated, settled or refunded',async()=>{
  const x=setup({readTask:async id=>({...x.task(id),reviewDeadline:x.state.seconds+119})});await x.automation.enqueue(x.task(1));
  const s=await x.automation.tick({maxDiscovery:0});assert.equal(s.missed,1);assert.equal(x.state.calls,0);assert.equal(x.state.settlements,0);assert.equal((await x.automation.status(1)).code,'REVIEW_DEADLINE_MISSED');
});
test('cooldown persists exact retry and cannot spin or settle an incomplete decision',async()=>{
  const x=setup({evaluate:async()=>({status:'cooldown',retryAt:1795500042,retryAfterSeconds:42})});await x.automation.enqueue(x.task(1));
  let s=await x.automation.tick({maxDiscovery:0});assert.equal(s.claimed,1);assert.equal(s.deferred,1);assert.equal(x.state.settlements,0);assert.equal((await x.automation.status(1)).nextAt,1795500042);
  s=await x.automation.tick({maxDiscovery:0});assert.equal(s.claimed,0);
});
test('pending checkpoint resumes across scheduler instances without early settlement',async()=>{
  const x=setup();let cursor=0;const evaluate=async()=>++cursor<3?{status:'evaluating',outcome:'pending'}:{outcome:'winner'};
  const a=createAutomation({...x.options,evaluate});await a.enqueue(x.task(1));
  await a.tick({maxDiscovery:0});assert.equal(x.state.settlements,0);x.state.seconds+=7;
  await createAutomation({...x.options,evaluate}).tick({maxDiscovery:0});assert.equal(x.state.settlements,0);x.state.seconds+=7;
  await a.tick({maxDiscovery:0});assert.equal(x.state.settlements,1);
});
test('daily automation dispatch cap is atomic and resets at WIB midnight',async()=>{
  const x=setup({dailyBudget:1});await x.automation.enqueue(x.task(1));await x.automation.enqueue(x.task(2));
  const s=await x.automation.tick({maxDiscovery:0});assert.equal(x.state.calls,1);assert.ok(s.alerts.includes('DAILY_LLM_BUDGET'));assert.equal(x.storage.used,1);
  const row=await x.automation.status(2);assert.equal(row.status,'blocked');assert.equal(row.nextAt,Math.floor((x.state.seconds+25200)/86400+1)*86400-25200);
  x.state.seconds=row.nextAt;await x.automation.tick({maxDiscovery:0});assert.equal(x.state.calls,2);assert.equal(x.storage.used,1);
});
test('provider cooldown does not spend daily model budget',async()=>{
  const x=setup({providerQueue:{intervalMs:7000,reserve:async()=>({admitted:false,retryAt:1795500100}),finish:async()=>assert.fail('not admitted')}});
  await x.automation.enqueue(x.task(1));await x.automation.tick({maxDiscovery:0});assert.equal(x.storage.used,0);assert.equal(x.state.calls,0);
});
test('transient evaluator errors persist bounded backoff without leaking message',async()=>{
  const x=setup({evaluate:async()=>{throw Object.assign(Error('secret report text'),{code:'EVALUATOR_UNAVAILABLE'});}});await x.automation.enqueue(x.task(1));
  const s=await x.automation.tick({maxDiscovery:0});assert.equal(s.claimed,1);assert.equal(x.state.settlements,0);assert.equal((await x.automation.status(1)).nextAt,x.state.seconds+2);assert.ok(!JSON.stringify(s).includes('secret report text'));
});
test('unconfigured relayer leaves decision blocked visibly and retries within a minute',async()=>{
  const x=setup({settle:undefined});await x.automation.enqueue(x.task(1));const s=await x.automation.tick({maxDiscovery:0});assert.ok(s.alerts.includes('RELAYER_UNCONFIGURED'));assert.equal((await x.automation.status(1)).nextAt,x.state.seconds+60);
});
test('blocked gas status cannot claim settlement complete',async()=>{
  const x=setup({settle:async()=>({status:'blocked',code:'RELAYER_GAS_BALANCE_LOW',retryAt:1795500015})});await x.automation.enqueue(x.task(1));const s=await x.automation.tick({maxDiscovery:0});assert.equal(s.completed,0);assert.ok(s.alerts.includes('RELAYER_GAS_BALANCE_LOW'));
});
test('queue capacity is explicit and terminal chain records are never rescheduled',async()=>{
  const x=setup({maxRecords:1});await x.automation.enqueue(x.task(1));assert.equal((await x.automation.enqueue(x.task(2))).code,'QUEUE_CAPACITY_EXCEEDED');
  assert.equal((await x.automation.enqueue({...x.task(3),phase:'Settled'})).terminal,true);
});
test('short discovery ticks advance individual IDs rather than repeatedly skipping batch tails',async()=>{
  const x=setup({readTaskCount:async()=>1000});const ids=[];
  const a=createAutomation({...x.options,readTask:async id=>{ids.push(id);x.state.ms+=12000;return x.task(id);}});
  for(let i=0;i<10;i++)await a.tick({maxJobs:0,maxDiscovery:50});assert.deepEqual(ids,Array.from({length:10},(_,i)=>String(i+1)));
});
test('zero tasks, safe bounds, and fence failure fail closed',async()=>{
  const x=setup({readTaskCount:async()=>0});assert.equal((await x.automation.tick()).claimed,0);
  await assert.rejects(x.automation.tick({maxJobs:11}),/job bound/);await assert.rejects(x.automation.tick({maxDiscovery:51}),/discovery bound/);await assert.rejects(x.automation.tick({budgetMs:45001}),/tick budget/);
  assert.throws(()=>createAutomation({...x.options,dailyBudget:-1}),/daily budget/);
});
test('already expired discoveries are retained as missed, not silently omitted',async()=>{
  const x=setup({readTask:async id=>({...x.task(id),phase:'Expired'})});
  const s=await x.automation.tick();assert.equal(s.discovered,1);assert.equal(s.missed,1);assert.ok(s.alerts.includes('REVIEW_DEADLINE_MISSED'));assert.equal(x.state.calls,0);
});
test('capacity report respects imminent deadline reserve, not a fictitious hour',async()=>{
  const x=setup();for(let id=1;id<=20;id++)await x.automation.enqueue({...x.task(id),reviewDeadline:x.state.seconds+180});
  const s=await x.automation.tick({maxDiscovery:0,maxJobs:0});assert.equal(s.capacity.windowSeconds,60);assert.equal(s.capacity.maximumProviderSlots,8);assert.equal(s.capacity.admissible,false);
});
test('production wiring preserves resumable evaluator and aborts HTTP without orphan races',async()=>{
  const source=await readFile(new URL('../lib/marketplace-automation.mjs',import.meta.url),'utf8');
  assert.match(source,/evaluate=evaluateTask/);assert.match(source,/nextTaskId/);assert.match(source,/AbortSignal.any/);assert.match(source,/AbortSignal.timeout/);assert.doesNotMatch(source,/Promise\.race\(/);assert.doesNotMatch(source,/prepareTransaction|createAndFund|refundExpired/);
  assert.match(AUTOMATION_LUA,/redis.call\('TIME'\)/);assert.match(AUTOMATION_LUA,/j.fence~=tonumber/);assert.match(AUTOMATION_LUA,/j.leaseUntil<=now/);
});
