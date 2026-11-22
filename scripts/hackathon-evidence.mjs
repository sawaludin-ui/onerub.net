// Read-only on-chain evidence; never signs or broadcasts. Output is not an organizer eligibility decision.
import fs from 'node:fs';
import path from 'node:path';
import { Contract, FetchRequest, JsonRpcProvider } from 'ethers';
import { SUBMISSION_START, SUBMISSION_END, RULES_URL, firstBlockAt, summarizeEvidence } from '../lib/hackathon-evidence.mjs';
const root=new URL('../',import.meta.url);
const v1=JSON.parse(fs.readFileSync(new URL('lib/marketplace-deployment.json',root),'utf8'));
const office=JSON.parse(fs.readFileSync(new URL('lib/deployment.json',root),'utf8'));
const contracts=[{address:v1.address,kind:'marketplace-v1',deploymentBlock:v1.blockNumber,submitted:false},{address:office.address,kind:'office-playground',deploymentBlock:office.blockNumber,submitted:false}];
const v2path=new URL('lib/marketplace-v2-deployment.json',root);
if(fs.existsSync(v2path)){const v2=JSON.parse(fs.readFileSync(v2path,'utf8'));if(v2.address&&v2.blockNumber)contracts.push({address:v2.address,kind:'marketplace-v2',deploymentBlock:v2.blockNumber,submitted:false});}
const rpc=process.env.BSC_RPC_URL||'https://bsc-rpc.publicnode.com';
const request=new FetchRequest(rpc);request.timeout=15000;
const provider=new JsonRpcProvider(request,undefined,{batchMaxCount:1});
const output=process.argv[2]||'docs/audit-evidence/hackathon-participation.json';
const chunk=Math.max(1,Math.min(10000,Number(process.env.EVIDENCE_BLOCK_CHUNK||2000)));
if(!Number.isInteger(chunk))throw Error('EVIDENCE_BLOCK_CHUNK must be an integer');
const records=[],failures=[],blocks=new Map(),seen=new Set();
async function bounded(call){let last;for(let i=0;i<3;i++){try{return await call();}catch(e){last=e;}}throw last;}
try{
 if((await provider.getNetwork()).chainId!==56n)throw Error('Expected BNB mainnet');
 const head=(await provider.getBlockNumber())-3,headBlock=await provider.getBlock(head);
 if(!headBlock)throw Error('Snapshot block unavailable');
 const fromBlock=await firstBlockAt(provider,SUBMISSION_START,head);
 const endBlock=headBlock.timestamp>=SUBMISSION_END?(await firstBlockAt(provider,SUBMISSION_END,head))-1:head;
 for(const item of contracts){
  const begin=Math.max(fromBlock,Number(item.deploymentBlock));
  for(let from=begin;from<=endBlock;from+=chunk){
   let logs;try{logs=await bounded(()=>provider.getLogs({address:item.address,fromBlock:from,toBlock:Math.min(endBlock,from+chunk-1)}));}
   catch{failures.push({contract:item.address,fromBlock:from,toBlock:Math.min(endBlock,from+chunk-1),reason:'LOG_RANGE_UNAVAILABLE'});continue;}
   for(const log of logs){
    const key=item.address.toLowerCase()+':'+log.transactionHash.toLowerCase();if(seen.has(key))continue;seen.add(key);
    try{
     const [receipt,tx]=await Promise.all([bounded(()=>provider.getTransactionReceipt(log.transactionHash)),bounded(()=>provider.getTransaction(log.transactionHash))]);
     if(!blocks.has(log.blockNumber))blocks.set(log.blockNumber,await bounded(()=>provider.getBlock(log.blockNumber)));
     const block=blocks.get(log.blockNumber);if(!tx||!receipt||!block)throw Error('missing');
     records.push({contract:item.address,kind:item.kind,from:tx.from,transactionHash:log.transactionHash,status:Number(receipt.status),blockNumber:log.blockNumber,timestamp:Number(block.timestamp)});
    }catch{failures.push({contract:item.address,transactionHash:log.transactionHash,reason:'RECEIPT_OR_BLOCK_UNAVAILABLE'});}
   }
  }
  console.log(JSON.stringify({contract:item.address,kind:item.kind,scanFinished:true}));
 }
 const registry=new Contract(v1.registry,['function balanceOf(address) view returns(uint256)'],provider),holders={};
 for(const address of new Set(records.map(r=>r.from.toLowerCase()))){try{holders[address]={holder:(await bounded(()=>registry.balanceOf(address,{blockTag:head})))>0n};}catch{holders[address]={holder:null,error:'REGISTRY_SNAPSHOT_UNAVAILABLE'};}}
 const summary={capturedAt:new Date().toISOString(),rulesUrl:RULES_URL,chainId:56,snapshotBlock:head,snapshotHash:headBlock.hash,period:{start:SUBMISSION_START,endExclusive:SUBMISSION_END,fromBlock,toBlock:endBlock},...summarizeEvidence(records,holders,contracts),scanComplete:failures.length===0,failures,records};
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(summary,null,2)+'\n');
 console.log(JSON.stringify({file:output,scanComplete:summary.scanComplete,observedTransactions:summary.observedSuccessfulTransactions,uniqueInteractingAddresses:summary.uniqueInteractingAddresses,uniqueCurrentHolders:summary.uniqueCurrentHolders,eligibilityConfirmed:false,unreadRanges:failures.length}));
 if(failures.length)process.exitCode=1;
}finally{provider.destroy();}
