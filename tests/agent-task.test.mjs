import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTaskCall, makeBawRunner, parseBawJson, runTask } from '../scripts/agent-task.mjs';

const H = '0x'+'12'.repeat(32);
const address = '0x607cF25614065179a9238705E03E6590C082F56d';
const now = 1800000000n;
const args = ['create','1','60','120',H,H];
const mock = (preview = {success:true,data:{requestId:'safe-request-1',simulationResult:{simulationCode:'000000000'}}}, enabled = true) => {
  const calls=[];
  return {calls,baw:a=>{
    calls.push(a);
    if(a[1]==='settings')return {success:true,data:{devMode:{enabled,expiresAt:Number(now)+1000}}};
    if(a[1]==='address')return {success:true,data:{addresses:[{binanceChainId:'56',address}]}};
    if(a[1]==='preview')return preview;
    if(a[1]==='execute')return {success:true,data:{status:'PENDING_CONFIRMATION',txHash:null}};
    throw Error('Unexpected wallet operation');
  }};
};

test('calldata uses explicit metadata commitments, 18 decimals and ordered deadlines',()=>{
  const call=buildTaskCall(args,now);
  const i=new Interface(['function createAndFund(address,uint256,bytes32,uint64,uint64,bytes32)']);
  const p=i.decodeFunctionData('createAndFund',call.data);
  assert.equal(p[1],10n**18n);assert.equal(p[2],H);assert.equal(p[3],now+3600n);assert.equal(p[4],now+7200n);
  assert.equal(call.execute,false);
});
test('malformed inputs do not silently hash text or use fake metadata',()=>{
  for(const a of [
    ['create','1','60','120'],['create','1','60','120','criteria',H],
    ['create','-1','60','120',H,H],['create','0','60','120',H,H],
    ['create','1','1','120',H,H],['create','1','60','60',H,H],
    ['create','1','60.5','120',H,H],['submit','1',H,'0x'+'00'.repeat(32)],
    ['submit','0',H,H],['approve','1 & calc'],['refund','1','unexpected'],
    ['select','1','0x'+'00'.repeat(20)],
  ])assert.throws(()=>buildTaskCall(a,now));
});
test('wallet child is node argv with no shell, including untrusted requestId',()=>{
  let invocation;
  const runner=makeBawRunner({cli:'C:/with spaces/index.js',env:{},spawn:(...p)=>{
    invocation=p;return {status:0,stdout:'{"success":true}'};
  }});
  runner(['contract-call','execute','--requestId','bad & calc']);
  assert.equal(invocation[0],process.execPath);
  assert.deepEqual(invocation[1],['C:/with spaces/index.js','contract-call','execute','--requestId','bad & calc']);
  assert.equal(invocation[2].shell,false);
});
test('real Node child loads a preload from a Windows-style path containing spaces',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'onerub wallet runner '));
  const shim=path.join(directory,'binance-doh.cjs'),cli=path.join(directory,'fake-baw.cjs');
  fs.writeFileSync(shim,"process.env.ONERUB_TEST_PRELOAD='loaded';\n");
  fs.writeFileSync(cli,"console.log(JSON.stringify({success:true,preload:process.env.ONERUB_TEST_PRELOAD}));\n");
  try{
    const runner=makeBawRunner({cli,shim,env:{...process.env,NODE_OPTIONS:'--no-warnings'}});
    assert.deepEqual(runner(['wallet','status','--json']),{success:true,preload:'loaded'});
  }finally{fs.unlinkSync(cli);fs.unlinkSync(shim);fs.rmdirSync(directory);}
});
test('JSON parser supports pretty JSON and rejects mixed stderr JSON',()=>{
  assert.deepEqual(parseBawJson('notice\n{\n"success":true\n}'),{success:true});
  assert.throws(()=>parseBawJson('', '{"success":true}'));
});
test('default run previews but never executes',()=>{
  const m=mock();const output=[];
  runTask(args,{...m,nowSec:now,print:v=>output.push(v)});
  assert.equal(m.calls.some(a=>a[1]==='execute'),false);
  assert.equal(output.at(-1).broadcast,false);
});
test('disabled developer mode prevents wallet preview',()=>{
  const m=mock(undefined,false);
  assert.throws(()=>runTask(args,{...m,nowSec:now,print:()=>{}}),/Developer Mode/);
  assert.equal(m.calls.length,1);
});
test('intercepted, malformed or failed simulation previews never execute',()=>{
  for(const preview of [
    {success:false}, {success:true,data:{}},
    {success:true,data:{requestId:'r; calc'}},
    {success:true,data:{requestId:'r',simulationResult:{simulationCode:'351805'}}},
  ]){
    const m=mock(preview);
    assert.throws(()=>runTask([...args,'--execute'],{...m,nowSec:now,print:()=>{}}),/Preview failed/);
    assert.equal(m.calls.some(a=>a[1]==='execute'),false);
  }
});
test('execute response does not claim pending confirmation is on-chain success',()=>{
  const m=mock(),output=[];
  runTask([...args,'--execute'],{...m,nowSec:now,print:v=>output.push(v)});
  assert.equal(m.calls.at(-1)[1],'execute');
  assert.equal(output.at(-1).confirmedOnChain,false);
  assert.equal(output.at(-1).execution.data.status,'PENDING_CONFIRMATION');
});
