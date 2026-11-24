// Node.js — isolated protocol doubles; no production Redis, provider calls or transactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AUTOMATION_LUA,AUTOMATION_OPS_LUA,createAutomation,getAutomationOpsStatus,getAutomationTaskStatus,runAutomationTick,schedulerEvent,validateAutomationBody} from '../lib/marketplace-automation.mjs';
import {runScheduler} from '../scripts/run-automation-scheduler.mjs';
class JournalDouble {
 constructor(){this.time=10000;this.state={};this.events=[];this.calls=0;}
 async command(cmd,lua,n,...args){
  this.calls++;assert.equal(cmd,'EVAL');assert.equal(lua,AUTOMATION_OPS_LUA);assert.equal(n,'2');assert.ok(args[0].endsWith('ops'));assert.ok(args[1].endsWith('ops:events'));
  const [op,...a]=args.slice(2),s=this.state,now=this.time;
  const add=v=>{this.events.unshift(v);this.events.length=Math.min(64,this.events.length);};
  if(op==='start'){const sequence=s.tickCount=(s.tickCount||0)+1;s.lastStartedAt=now;s.lastSource=a[0];if(['schedule','vercel_schedule'].includes(a[0])){s.lastScheduledAt=now;s.scheduledCount=(s.scheduledCount||0)+1;}else s.manualCount=(s.manualCount||0)+1;add({sequence,source:a[0]});return sequence;}
  if(op==='finish'){const [seq,source,code,completed,failed]=a;const key=failed==='1'?'errorCount':'successCount';s[key]=(s[key]||0)+1;if(Number(seq)>=(s.lastFinishedSequence||0)){s.lastFinishedSequence=Number(seq);s.lastCompletedAt=now;s.lastCode=code;}if(failed!=='1'){s.lastSuccessfulAt=now;if(['schedule','vercel_schedule'].includes(source))s.lastScheduledSuccessfulAt=now;}if(Number(completed)>0){s.lastProgressAt=now;s.completedJobs=(s.completedJobs||0)+Number(completed);}add({sequence:Number(seq),source,code,completed:Number(completed)});return 1;}
  if(op==='read')return JSON.stringify({state:Object.entries(s).flat().map(String),serverNow:now});
  assert.fail('unknown op');
 }
}
const idle={tick:async()=>({enabled:true,completed:0,alerts:[]})};
test('manual successes never disguise absent periodic heartbeat; successful schedules persist across instances',async()=>{
 const storage=new JournalDouble();let state=await getAutomationOpsStatus({storage});assert.equal(state.overdue,true);assert.equal(state.lastScheduledAgeSecs,null);
 await runAutomationTick({storage,automation:idle,source:'workflow_dispatch'});state=await getAutomationOpsStatus({storage});assert.equal(state.manualCount,1);assert.equal(state.scheduledCount,0);assert.equal(state.overdue,true);
 await runAutomationTick({storage,automation:idle,source:'vercel_schedule'});state=await getAutomationOpsStatus({storage});assert.equal(state.overdue,false);assert.equal(state.scheduledCount,1);assert.equal(state.tickCount,2);
 storage.time+=2101;assert.equal((await getAutomationOpsStatus({storage})).overdue,true);
});
test('errors are safe, failed scheduled ticks do not refresh success, ring is bounded',async()=>{
 const storage=new JournalDouble();const automation={tick:async()=>{throw Object.assign(Error('PRIVATE prompt bearer secret'),{code:'bad private text'});}};
 await assert.rejects(runAutomationTick({storage,automation,source:'schedule'}));let state=await getAutomationOpsStatus({storage});assert.equal(state.lastCode,'AUTOMATION_UNAVAILABLE');assert.equal(state.lastScheduledSuccessfulAt,0);assert.equal(state.errorCount,1);assert.doesNotMatch(JSON.stringify(storage.events),/PRIVATE|bearer|secret/);
 for(let i=0;i<40;i++)await runAutomationTick({storage,automation:idle});state=await getAutomationOpsStatus({storage});assert.equal(storage.events.length,64);assert.equal(state.tickCount,41);assert.equal(state.successCount,40);
 assert.match(AUTOMATION_OPS_LUA,/LTRIM.*0,63/);assert.match(AUTOMATION_OPS_LUA,/lastFinishedSequence/);
});
test('disabled workers and aggregate job errors remain degraded not successful periodic work',async()=>{
 const storage=new JournalDouble();await runAutomationTick({storage,automation:{tick:async()=>({enabled:false})},source:'schedule'});assert.equal((await getAutomationOpsStatus({storage})).lastCode,'AUTOMATION_DISABLED');
 await runAutomationTick({storage,automation:{tick:async()=>({enabled:true,completed:2,alerts:['RELAYER_GAS_BALANCE_LOW']})},source:'schedule'});const s=await getAutomationOpsStatus({storage});assert.equal(s.errorCount,2);assert.equal(s.completedJobs,2);assert.equal(s.overdue,true);
});
test('journal start failure prevents evaluation; completion persistence failure is not counted twice',async()=>{
 let ticks=0;await assert.rejects(runAutomationTick({storage:{command:async()=>{throw Error('offline');}},automation:{tick:async()=>{ticks++;}}}));assert.equal(ticks,0);
 const storage=new JournalDouble();const command=storage.command.bind(storage);storage.command=async(...args)=>{if(args[5]==='finish')throw Error('offline');return command(...args);};await assert.rejects(runAutomationTick({storage,automation:idle}));assert.equal(storage.state.successCount,undefined);
});
test('bounded body reads reject giant chunked requests early, cancel stream and never call text()',async()=>{
 for(const body of ['', '{}'])await validateAutomationBody(new Request('https://onerub.net',{method:'POST',body}));
 await assert.rejects(validateAutomationBody(new Request('https://onerub.net',{method:'POST',body:'{"taskId":1}'})),{code:'INVALID_REQUEST'});
 let cancelled=false,reads=0;const request={headers:new Headers(),body:new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(600));},cancel(){cancelled=true;}})};
 await assert.rejects(validateAutomationBody(request),{code:'REQUEST_TOO_LARGE'});assert.equal(cancelled,true);assert.ok(reads<=3);
 await assert.rejects(validateAutomationBody({headers:new Headers({'content-length':'90000000'}),body:{getReader(){assert.fail('must reject declared giant body first');}}}),{code:'REQUEST_TOO_LARGE'});
});
test('event allowlist identifies authenticated caller only; unknown event rejected',()=>{
 const req=headers=>new Request('https://onerub.net',{headers});assert.equal(schedulerEvent(req({})),'operator');assert.equal(schedulerEvent(req({'X-ONERUB-Scheduler-Event':'schedule'})),'schedule');assert.equal(schedulerEvent(req({'ce-type':'com.vercel.schedule.v1beta','ce-specversion':'1.0'})),'vercel_schedule');assert.throws(()=>schedulerEvent(req({'X-ONERUB-Scheduler-Event':'fake'})),{code:'INVALID_SCHEDULER_EVENT'});
});
test('per-task public status drops private job data and leases',async()=>{
 const storage={command:async(cmd,lua,n,...args)=>{assert.equal(lua,AUTOMATION_LUA);assert.equal(args[7],'status');return JSON.stringify({id:'1',status:'pending',code:'SETTLEMENT_PENDING',nextAt:10,updatedAt:9,owner:'SECRET',fence:3,decision:{private:'PRIVATE'}});}};
 assert.deepEqual(await getAutomationTaskStatus(1,{storage}),{id:'1',status:'pending',code:'SETTLEMENT_PENDING',nextAt:10,updatedAt:9});await assert.rejects(getAutomationTaskStatus('../1',{storage}),{code:'INVALID_TASK_ID'});
});
test('workflow sends schedule event and all-HTTP-error runs fail instead of false green',async()=>{
 let clock=0;const s=await runScheduler({event:'schedule',secret:'x'.repeat(64),fetcher:async(url,init)=>{assert.equal(init.headers['X-ONERUB-Scheduler-Event'],'schedule');return Response.json({enabled:true,claimed:0,queue:{pending:0}});}});assert.equal(s.successfulTicks,1);
 await assert.rejects(runScheduler({secret:'x'.repeat(64),maxTicks:2,now:()=>clock,sleep:async ms=>{clock+=ms;},fetcher:async()=>Response.json({code:'AUTOMATION_UNAVAILABLE'},{status:503})}),/SCHEDULER_UNAVAILABLE/);
 const workflow=await readFile(new URL('../.github/workflows/marketplace-automation.yml',import.meta.url),'utf8');assert.ok(workflow.includes('2-57/5'));assert.match(workflow,/github.event_name/);
});
test('server tick resumes near-term cooldowns within budget but never sleeps until future Open deadline',async()=>{
 let clock=1000000000000,nextAt=0,attempts=0,sleeps=0,finished=false;
 const storage={command:async(cmd,lua,n,...args)=>{assert.equal(lua,AUTOMATION_LUA);const [op,...a]=args.slice(7);const now=clock/1000;
  if(op==='claim'){if(finished||nextAt>now)return '';return JSON.stringify({id:'1',owner:'test',fence:1,attempts:++attempts});}
  if(op==='check')return 1;
  if(op==='finish'){const u=JSON.parse(a[3]);nextAt=u.nextAt||0;finished=Boolean(u.terminal);return 1;}
  if(op==='inspect')return JSON.stringify({ready:!finished&&nextAt<=now?1:0,delayed:!finished&&nextAt>now?1:0,running:0,retained:1,total:1,serverNow:now,budgetUsed:0,earliestDelayedAt:nextAt});
 }};
 const task={id:'1',requester:'test',phase:'Review',reviewDeadline:clock/1000+1000};let evaluates=0;
 const automation=createAutomation({enabled:true,storage,now:()=>clock/1000,clockMs:()=>clock,sleep:async ms=>{sleeps++;clock+=ms;},readTask:async()=>task,providerQueue:{intervalMs:7000},evaluate:async()=>++evaluates<4?{status:'evaluating',retryAt:clock/1000+7}:{outcome:'winner'},settle:async()=>({status:'settled'})});
 const result=await automation.tick({maxDiscovery:0});assert.equal(evaluates,4);assert.equal(sleeps,3);assert.equal(result.completed,1);assert.equal(clock,1000000021000);
 finished=false;nextAt=clock/1000+3600;sleeps=0;await automation.tick({maxDiscovery:0});assert.equal(sleeps,0);
});
