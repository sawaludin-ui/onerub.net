import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Interface,parseUnits} from 'ethers';
import {buildTaskRequest,validatePrepared,requestPreparation,makeBawRunner,parseBawJson,runTask} from '../scripts/agent-task.mjs';
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
