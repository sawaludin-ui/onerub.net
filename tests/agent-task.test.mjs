import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Interface,parseUnits} from 'ethers';
import {buildTaskRequest,validatePrepared,requestPreparation,makeBawRunner,parseBawJson,runTask,taskStopOutput} from '../scripts/agent-task.mjs';
import {hash} from '../lib/marketplace-core.mjs';
import {normalizePolicy,policyHash} from '../lib/marketplace-policy.mjs';
const config={version:2,verified:true,newTasksEnabled:true,chainId:56,address:'0x1111111111111111111111111111111111111111',token:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'};
const wallet='0x607cF25614065179a9238705E03E6590C082F56d',now=1800000000n;
const abi=new Interface(JSON.parse(fs.readFileSync(new URL('../lib/marketplace-v2-abi.json',import.meta.url))));
const approve=new Interface(['function approve(address,uint256)']);
const doc={amount:'1',metadata:{title:'Review a small algorithm',description:'Inspect the supplied algorithm and provide test evidence.',category:'Code review',rubric:'Accept complete work with reproducible test evidence.'},submissionDeadline:Number(now)+3600,reviewDeadline:Number(now)+7200,policy:{minScore:70}};
function prepared(body){
 let data;if(body.action==='approve')data=approve.encodeFunctionData('approve',[config.address,parseUnits(body.amount,18)]);
 else if(body.action==='createAndFund')data=abi.encodeFunctionData(body.action,[config.token,parseUnits(body.amount,18),hash(body.metadata),body.submissionDeadline,body.reviewDeadline,policyHash(body.policy)]);
 else if(body.action==='selectWinner')data=abi.encodeFunctionData(body.action,[body.taskId,wallet,Number(now)+999,'0x1234']);
 else if(body.action==='rejectAll')data=abi.encodeFunctionData(body.action,[body.taskId,Number(now)+999,'0x1234']);
 else if(body.action==='submitCommitment')data=abi.encodeFunctionData(body.action,[body.taskId,'0x'+'12'.repeat(32),'0x'+'13'.repeat(32),100,Number(now)+999,'0x1234']);
 else data=abi.encodeFunctionData(body.action,[body.taskId]);
 return {chainId:56,to:body.action==='approve'?config.token:config.address,value:'0',data};
}
function mock(preview={success:true,data:{requestId:'safe-request-1',simulationResult:{simulationCode:'000000000'}}},enabled=true){const calls=[];return {calls,baw:a=>{calls.push(a);if(a[1]==='settings')return {success:true,data:{devMode:{enabled,expiresAt:Number(now)+1000}}};if(a[1]==='address')return {success:true,data:{addresses:[{binanceChainId:'56',address:wallet}]}};if(a[1]==='preview')return preview;if(a[1]==='execute')return {success:true,data:{status:'PENDING_CONFIRMATION',txHash:null}};throw Error('Unexpected wallet call');}};}

test('normal CLI selection and rejection use hosted preparation with task ID only',()=>{
 assert.deepEqual(buildTaskRequest(['select','1']).body,{action:'selectWinner',taskId:'1'});
 assert.deepEqual(buildTaskRequest(['reject','1']).body,{action:'rejectAll',taskId:'1'});
 assert.deepEqual(buildTaskRequest(['submit','1'],{from:wallet}).body,{action:'submitCommitment',taskId:'1',worker:wallet});
 assert.throws(()=>buildTaskRequest(['select','1',wallet]));
 assert.throws(()=>buildTaskRequest(['submit','1','0x'+'12'.repeat(32)]));
});
test('task JSON preserves readable policy and sufficient review window',()=>{
 const {body}=buildTaskRequest(['create','task.json'],{readFile:()=>JSON.stringify(doc)});
 assert.equal(body.policy.minReviewWindowSeconds,3600);assert.equal(body.metadata.title,doc.metadata.title);assert.equal(body.amount,'1');
 assert.throws(()=>buildTaskRequest(['create','task.json'],{readFile:()=>JSON.stringify({...doc,reviewDeadline:doc.submissionDeadline+1})}),/one hour/);
 assert.throws(()=>buildTaskRequest(['create','task.json'],{readFile:()=>JSON.stringify({...doc,policy:undefined})}),/readable policy/);
});
test('malformed commands and amounts fail locally',()=>{
 for(const a of [['select','0'],['refund','1','extra'],['approve','-1'],['approve','1 & calc'],['approve','0'],['approve','1e3'],['approve','1','--execute','--execute']])assert.throws(()=>buildTaskRequest(a));
});
test('unsigned transaction target, amount, spender, task, method and metadata are verified',()=>{
 const body={action:'approve',amount:'1'},p=prepared(body);assert.equal(validatePrepared(p,body,config).to,config.token);
 assert.throws(()=>validatePrepared({...p,to:wallet},body,config),/unexpected/);
 assert.throws(()=>validatePrepared({...p,value:'1'},body,config),/invalid unsigned/);
 assert.throws(()=>validatePrepared({...p,data:approve.encodeFunctionData('approve',[wallet,parseUnits('1',18)])},body,config),/spender/);
 const select={action:'selectWinner',taskId:'1'};assert.throws(()=>validatePrepared(prepared({...select,taskId:'2'}),select,config),/task ID/);
 assert.throws(()=>validatePrepared(prepared({action:'refund',taskId:'1'}),select,config),/action mismatch/);
 const create=buildTaskRequest(['create','task.json'],{readFile:()=>JSON.stringify(doc)}).body;
 const changed={...create,metadata:{...create.metadata,title:'Changed by remote API'}};
 assert.throws(()=>validatePrepared(prepared(changed),create,config),/commitment mismatch/);
});
test('wallet child uses argv without shell interpolation',()=>{
 let invocation;const runner=makeBawRunner({cli:'C:/with spaces/index.js',env:{},spawn:(...p)=>{invocation=p;return {status:0,stdout:'{"success":true}'};}});runner(['contract-call','execute','--requestId','bad & calc']);assert.equal(invocation[0],process.execPath);assert.equal(invocation[2].shell,false);assert.equal(invocation[1].at(-1),'bad & calc');
});
test('actual Node child loads a spaced Windows preload path',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'onerub wallet runner ')),shim=path.join(dir,'binance-doh.cjs'),cli=path.join(dir,'fake-baw.cjs');fs.writeFileSync(shim,"process.env.ONERUB_TEST_PRELOAD='loaded';\n");fs.writeFileSync(cli,"console.log(JSON.stringify({success:true,preload:process.env.ONERUB_TEST_PRELOAD}));\n");try{assert.deepEqual(makeBawRunner({cli,shim,env:{...process.env,NODE_OPTIONS:'--no-warnings'}})(['wallet','status','--json']),{success:true,preload:'loaded'});}finally{fs.unlinkSync(cli);fs.unlinkSync(shim);fs.rmdirSync(dir);}
});
test('pretty JSON is parsed but stderr cannot masquerade as success',()=>{
 assert.deepEqual(parseBawJson('notice\n{\n"success":true\n}'),{success:true});assert.throws(()=>parseBawJson('','{"success":true}'));
});
test('API errors remain errors and insecure remote HTTP is rejected',async()=>{
 await assert.rejects(requestPreparation({action:'approve',amount:'1'},{base:'http://untrusted.example',fetcher:()=>{throw Error('must not call')}}),/HTTPS/);
 await assert.rejects(requestPreparation({action:'selectWinner',taskId:'1'},{fetcher:async()=>({ok:false,json:async()=>({error:'Evaluation pending',code:'EVALUATION_REQUIRED'})})}),/EVALUATION_REQUIRED/);
});
test('normal run previews prepared calldata without execution by default',async()=>{
 const m=mock(),out=[],bodies=[];await runTask(['select','1'],{...m,config,nowSec:now,prepare:async body=>{bodies.push(body);return prepared(body)},print:v=>out.push(v)});assert.deepEqual(bodies,[{action:'selectWinner',taskId:'1'}]);assert.equal(m.calls.some(a=>a[1]==='execute'),false);assert.equal(out.at(-1).broadcast,false);
});
test('disabled developer mode prevents API prepare and wallet preview',async()=>{
 const m=mock(undefined,false);await assert.rejects(runTask(['select','1'],{...m,config,nowSec:now,prepare:()=>{throw Error('must not call')},print:()=>{}}),/Developer Mode/);assert.equal(m.calls.length,1);
});
test('failed or intercepted previews never execute',async()=>{
 for(const p of [{success:false},{success:true,data:{}},{success:true,data:{requestId:'r; calc'}},{success:true,data:{requestId:'r',simulationResult:{simulationCode:'351805'}}}]){const m=mock(p);await assert.rejects(runTask(['select','1','--execute'],{...m,config,nowSec:now,prepare:async b=>prepared(b),print:()=>{}}),/Preview failed/);assert.equal(m.calls.some(a=>a[1]==='execute'),false);}
});
test('App pending execution is never claimed as confirmed settlement',async()=>{
 const m=mock(),out=[];await runTask(['select','1','--execute'],{...m,config,nowSec:now,prepare:async b=>prepared(b),print:v=>out.push(v)});assert.equal(out.at(-1).confirmedOnChain,false);assert.equal(out.at(-1).execution.data.status,'PENDING_CONFIRMATION');
});

test('funding deployment gate precedes task and acknowledgement file reads with flag before command',async()=>{
 for(const c of [{...config,version:1},{...config,verified:false}])await assert.rejects(runTask(['--health-ack','missing.json','create','unused.json'],{config:c,readFile:()=>{throw Error('must not read')},baw:()=>{throw Error('must not call wallet')}}),error=>error.code==='ESCROW_UPGRADE_REQUIRED');
});
const healthAck={accepted:true,token:'ab'.repeat(32),expiresAt:Number(now)+100};
test('manual health acknowledgement parses flags anywhere without implying execute',()=>{
 for(const args of [['--health-ack','ack.json','approve','1'],['approve','--health-ack','ack.json','1'],['approve','1','--health-ack','ack.json']]){
  const v=buildTaskRequest(args,{nowSec:now,readFile:p=>{assert.equal(p,'ack.json');return JSON.stringify(healthAck)}});
  assert.deepEqual(v.body.healthAcknowledgement,healthAck);assert.equal(v.execute,false);
 }
 const v=buildTaskRequest(['--execute','--health-ack','ack.json','create','task.json'],{nowSec:now,readFile:p=>JSON.stringify(p==='ack.json'?healthAck:doc)});
 assert.equal(v.execute,true);assert.deepEqual(v.body.healthAcknowledgement,healthAck);
 assert.equal(Object.hasOwn(buildTaskRequest(['approve','1']).body,'healthAcknowledgement'),false);
});
test('acknowledgements reject malformed, expired, oversized, ambiguous and unrelated action input',()=>{
 const invalid=[null,[],{}, {...healthAck,accepted:false},{...healthAck,token:'cd'}, {...healthAck,token:'AB'.repeat(32)}, {...healthAck,expiresAt:Number(now)}, {...healthAck,expiresAt:Number(now)-1}, {...healthAck,expiresAt:Number(now)+121}, {...healthAck,expiresAt:String(healthAck.expiresAt)}, {...healthAck,secret:'not-allowed'}];
 for(const ack of invalid)assert.throws(()=>buildTaskRequest(['approve','1','--health-ack','ack.json'],{nowSec:now,readFile:()=>JSON.stringify(ack)}),/Invalid health acknowledgement/);
 for(const raw of ['{',' '.repeat(4097)])assert.throws(()=>buildTaskRequest(['approve','1','--health-ack','ack.json'],{nowSec:now,readFile:()=>raw}),/JSON/);
 for(const args of [['approve','1','--health-ack'],['approve','1','--health-ack','--execute'],['approve','1','--health-ack','a','--health-ack','b'],['--health-ack','ack.json','select','1'],['refund','1','--health-ack','ack.json'],['approve','1','--auto-ack']])assert.throws(()=>buildTaskRequest(args,{readFile:()=>{throw Error('must not read')}}));
 const readFile=()=>JSON.stringify({...doc,healthAcknowledgement:healthAck});
 assert.deepEqual(buildTaskRequest(['create','task.json'],{nowSec:now,readFile}).body.healthAcknowledgement,healthAck);
 assert.throws(()=>buildTaskRequest(['create','task.json','--health-ack','ack.json'],{nowSec:now,readFile}),/both/);
});
function healthFailure(code='HEALTH_ACK_REQUIRED'){
 return {code,error:'SECRET_SERVER_MESSAGE',secret:'SECRET_ROOT',readiness:{status:'degraded',secret:'SECRET_READINESS',checks:{rpc:{status:'available'},evaluator:{status:'unknown',basis:'read-only',secret:'SECRET_CHECK'},delivery:{status:'cooldown',retryAt:123},evil:{status:'available',secret:'SECRET_UNKNOWN'}}},healthAcknowledgement:{token:healthAck.token,expiresAt:healthAck.expiresAt,secret:'SECRET_ACK'}};
}
test('prepare preserves bounded allowlisted warning fields and prints actionable stop JSON',async()=>{
 const value=healthFailure();let calls=0;
 await assert.rejects(requestPreparation({action:'approve',amount:'1'},{config,fetcher:async()=>{calls++;return {ok:false,status:409,json:async()=>value}}}),error=>{
  assert.equal(error.code,'HEALTH_ACK_REQUIRED');assert.equal(error.status,409);
  const out=taskStopOutput(error);assert.equal(out.step,'stop');assert.deepEqual(out.healthAcknowledgement,{token:healthAck.token,expiresAt:healthAck.expiresAt});
  assert.equal(out.readiness.checks.evaluator.basis,'read-only');assert.equal(out.readiness.checks.delivery.retryAt,123);
  assert.match(out.hint,/--health-ack/);assert.equal(JSON.stringify(out).includes('SECRET'),false);assert.equal(Object.hasOwn(out.readiness.checks,'evil'),false);
  return true;
 });assert.equal(calls,1);
});
test('prepare validation diagnostics preserve only bounded public machine fields',async()=>{
 const fields={field:'metadata.title',expected:'string length 5–140',received:'string length 2'};
 await assert.rejects(requestPreparation({action:'approve',amount:'1'},{config,fetcher:async()=>({ok:false,status:400,json:async()=>({code:'METADATA_FIELD_INVALID',...fields,error:'SECRET_RAW_ERROR',body:{token:'SECRET_BODY'},token:'SECRET_TOKEN',provider:'SECRET_PROVIDER'})})}),error=>{
  const out=taskStopOutput(error);assert.deepEqual(out,{step:'stop',error:'Marketplace preparation failed: METADATA_FIELD_INVALID',code:'METADATA_FIELD_INVALID',status:400,...fields});assert.equal(JSON.stringify(out).includes('SECRET'),false);return true;
 });
 const out=taskStopOutput({message:'local validation',field:'a'.repeat(201),expected:{secret:'SECRET'},received:'number'});assert.deepEqual(out,{step:'stop',error:'local validation',received:'number'});
});
test('malformed remote warning fields are omitted or fail closed',async()=>{
 await assert.rejects(requestPreparation({action:'approve',amount:'1'},{config,fetcher:async()=>({ok:false,status:409,json:async()=>({...healthFailure(),healthAcknowledgement:{token:'SECRET',expiresAt:'not-int'},readiness:{status:'healthy',checks:null}})})}),error=>{const out=taskStopOutput(error);assert.equal(out.readiness.status,'degraded');assert.equal(out.healthAcknowledgement,undefined);assert.equal(JSON.stringify(out).includes('SECRET'),false);return true;});
});
test('manual ack is serialized only in prepare JSON and keeps deployment identity',async()=>{
 const body=buildTaskRequest(['approve','1','--health-ack','ack.json'],{nowSec:now,readFile:()=>JSON.stringify(healthAck)}).body;
 await requestPreparation(body,{config,fetcher:async(url,options)=>{assert.equal(url.pathname,'/api/marketplace/prepare');assert.deepEqual(JSON.parse(options.body),{...body,chainId:56,escrowAddress:config.address});return {ok:true,json:async()=>prepared(body)}}});
});
test('fatal funding error remains typed and cannot offer acknowledgement bypass',async()=>{
 await assert.rejects(requestPreparation({action:'approve',amount:'1',healthAcknowledgement:healthAck},{config,fetcher:async()=>({ok:false,status:503,json:async()=>healthFailure('FUNDING_UNAVAILABLE')})}),error=>{
  const out=taskStopOutput(error);assert.equal(out.code,'FUNDING_UNAVAILABLE');assert.equal(out.status,503);assert.equal(Object.hasOwn(out,'healthAcknowledgement'),false);assert.match(out.hint,/cannot bypass/);return true;
 });
});
test('manual ack reaches prepare but never auto retries, previews on failure or executes by default',async()=>{
 for(const fail of [false,true]){
  const m=mock();let prepares=0;
  const go=runTask(['--health-ack','ack.json','approve','1'],{...m,config,nowSec:now,readFile:()=>JSON.stringify(healthAck),print:()=>{},prepare:async body=>{prepares++;assert.deepEqual(body.healthAcknowledgement,healthAck);if(fail)throw Object.assign(Error('Marketplace preparation failed: HEALTH_ACK_REQUIRED'),healthFailure());return prepared(body)}});
  if(fail)await assert.rejects(go);else await go;
  assert.equal(prepares,1);assert.equal(m.calls.some(a=>a[1]==='execute'),false);assert.equal(m.calls.some(a=>a[1]==='preview'),!fail);
 }
});
