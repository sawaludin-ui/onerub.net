#!/usr/bin/env node
// Drives the OneRubMarketplaceEscrow from an agent's Binance Agentic Wallet
// (ferta.ai) through the `baw` CLI, using the two-step contract-call flow
// (preview -> execute). Preview only simulates; nothing is broadcast unless you
// pass --execute, and the CLI still routes high-value calls through the Binance
// App for confirmation.
//
// Usage (always previews first; add --execute to broadcast):
//   node scripts/agent-task.mjs approve <amountUSDC>
//   node scripts/agent-task.mjs create <task.json>
//   node scripts/agent-task.mjs submit <taskId>  (private upload must already exist)
//   node scripts/agent-task.mjs select <taskId>  (hosted evaluator chooses; no arbitrary winner)
//   node scripts/agent-task.mjs reject <taskId>  (signed no-acceptable verdict)
//   node scripts/agent-task.mjs cancel <taskId>
//   node scripts/agent-task.mjs refund <taskId>
//
// The wallet that signs is whichever agent is signed into `baw` (expected: ferta).
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {pathToFileURL} from "node:url";
import { ACTIVE_MARKETPLACE_DEPLOYMENT, marketplaceAbiFor } from "../lib/marketplace-deployment-resolver.mjs";
import { Interface, parseUnits, isAddress } from "ethers";
import {hash} from '../lib/marketplace-core.mjs';
import {normalizePolicy,policyHash} from '../lib/marketplace-policy.mjs';
import {fundingReadinessContract} from '../lib/marketplace-action-contract.mjs';

const SHIM = path.join(os.homedir(), ".claude/network/binance-doh.cjs");
const CHAIN = String(ACTIVE_MARKETPLACE_DEPLOYMENT.chainId);
const erc20 = new Interface(['function approve(address spender,uint256 value) returns(bool)']);
export function activeDeployment() { return ACTIVE_MARKETPLACE_DEPLOYMENT; }
export function locateBaw(env=process.env) {
  const candidates=[env.BAW_CLI_JS];
  for(const dir of (env.PATH||env.Path||'').split(path.delimiter)) {
    candidates.push(path.join(dir,'node_modules/@binance/agentic-wallet/dist/index.js'));
    candidates.push(path.resolve(dir,'../lib/node_modules/@binance/agentic-wallet/dist/index.js'));
  }
  const found=candidates.find(p=>p&&fs.existsSync(p)&&fs.statSync(p).isFile());
  if(!found) throw Error('Cannot find baw CLI; install @binance/agentic-wallet or set BAW_CLI_JS');
  return found;
}
export function parseBawJson(stdout,stderr='') {
  const text=String(stdout||'').trim();
  try{return JSON.parse(text);}catch{}
  const first=text.indexOf('{');
  if(first>=0){try{return JSON.parse(text.slice(first));}catch{}}
  throw Error('baw returned invalid JSON: '+String(stderr||text).slice(0,500));
}
export function makeBawRunner({cli=locateBaw(),spawn=spawnSync,env=process.env,shim=SHIM}={}) {
  const childEnv={...env};
  // NODE_OPTIONS has its own quote parser even though spawn does not use a
  // shell. Backslashes in quoted Windows paths can otherwise be consumed.
  const preload=shim.replaceAll('\\','/');
  if(fs.existsSync(shim)&&!(childEnv.NODE_OPTIONS||'').includes(preload))
    childEnv.NODE_OPTIONS=[childEnv.NODE_OPTIONS,'--require '+JSON.stringify(preload)].filter(Boolean).join(' ');
  return cmdArgs=>{
    const r=spawn(process.execPath,[cli,...cmdArgs],{encoding:'utf8',shell:false,windowsHide:true,timeout:90000,env:childEnv});
    if(r.error)throw Error('baw process failed: '+r.error.message);
    const result=parseBawJson(r.stdout,r.stderr);
    if(r.status!==0&&result.success)throw Error('baw exited unsuccessfully despite success response');
    return result;
  };
}

function fromAddress(baw) {
  const res = baw(["wallet", "address", "--json"]);
  const list = res?.data?.addresses || [];
  const evm = list.find((a) => String(a.binanceChainId) === CHAIN || a.chainName === "BNB Smart Chain");
  if (!evm) throw Error("No EVM address from baw wallet; is ferta signed in?");
  if (!res?.success || !isAddress(evm.address)) throw Error("Invalid BSC wallet response");
  return evm.address;
}

function id(value){if(!/^[1-9]\d*$/.test(value||'')||BigInt(value)>=2n**256n)throw Error('Task ID must be a positive uint256');return value;}
function amount(value){if(!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value||''))throw Error('Amount must be decimal USDC, at most18 places');const n=parseUnits(value,18);if(n<=0n||n>=2n**256n)throw Error('Amount outside uint256 range');return value;}
function parseTaskArgs(argv) {
  let execute=false,ackFile;const positional=[];
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--execute'){if(execute)throw Error('Duplicate execute flag');execute=true;}
    else if(a==='--health-ack'){
      if(ackFile!==undefined)throw Error('Duplicate health acknowledgement flag');
      if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('--health-ack requires a JSON file');
      ackFile=argv[++i];
    }else if(a.startsWith('--'))throw Error('Unknown marketplace flag');
    else positional.push(a);
  }
  const [cmd,...p]=positional;
  if(p.length!==1)throw Error('Usage: approve <USDC>; create <task.json>; submit/select/reject/cancel/refund <taskId>; optional --execute; approve/create only: --health-ack <file.json>');
  if(ackFile!==undefined&&!['approve','create'].includes(cmd))throw Error('--health-ack is only supported for approve/create');
  return {cmd,p,execute,ackFile};
}
export function validateHealthAcknowledgement(v,nowSec=Math.floor(Date.now()/1000)) {
  const now=Number(nowSec);
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==3||
      !['accepted','token','expiresAt'].every(k=>Object.hasOwn(v,k))||v.accepted!==true||
      typeof v.token!=='string'||! /^[a-f0-9]{64}$/.test(v.token)||
      !Number.isSafeInteger(v.expiresAt)||!Number.isSafeInteger(now)||v.expiresAt<=now||v.expiresAt>now+120)
    throw Error('Invalid health acknowledgement: require exactly {accepted:true,token:64 lowercase hex,expiresAt:future Unix seconds within 120s}');
  return {accepted:true,token:v.token,expiresAt:v.expiresAt};
}
export function buildTaskRequest(argv,{from,readFile=p=>fs.readFileSync(p,'utf8'),nowSec=Math.floor(Date.now()/1000)}={}){
  const {cmd,p,execute,ackFile}=parseTaskArgs(argv);
  let body;
  if(cmd==='approve')body={action:'approve',amount:amount(p[0])};
  else if(cmd==='create'){
    const raw=readFile(p[0]);if(Buffer.byteLength(raw,'utf8')>65536)throw Error('Task JSON is too large');
    let v;try{v=JSON.parse(raw);}catch{throw Error('Task JSON is invalid');}
    if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Task JSON must be an object');
    body={action:'createAndFund',amount:amount(v.amount),metadata:v.metadata,submissionDeadline:v.submissionDeadline,reviewDeadline:v.reviewDeadline,policy:v.policy};
    if(!body.metadata||typeof body.metadata!=='object'||!body.policy||typeof body.policy!=='object')throw Error('Task JSON requires metadata and a readable policy');
    body.metadata=Object.fromEntries(['title','description','category','rubric'].map(k=>{if(typeof body.metadata[k]!=='string')throw Error('Invalid task metadata');return [k,body.metadata[k]];}));
    body.policy=normalizePolicy(body.policy);
    if(Object.hasOwn(v,'healthAcknowledgement')){
      if(ackFile!==undefined)throw Error('Health acknowledgement supplied in both task JSON and --health-ack');
      body.healthAcknowledgement=validateHealthAcknowledgement(v.healthAcknowledgement,nowSec);
    }
    const minReview=body.policy.minReviewWindowSeconds;
    if(!Number.isSafeInteger(body.submissionDeadline)||!Number.isSafeInteger(body.reviewDeadline)||body.reviewDeadline-body.submissionDeadline<minReview)throw Error('Review window must be at least '+minReview+' seconds for the selected policy');
  }else{
    const names={submit:'submitCommitment',select:'selectWinner',reject:'rejectAll',cancel:'cancel',refund:'refund'};
    if(!Object.hasOwn(names,cmd))throw Error('Unknown marketplace action');body={action:names[cmd],taskId:id(p[0])};
    if(cmd==='submit'){if(!isAddress(from||''))throw Error('Connected worker address required');body.worker=from;}
  }
  if(ackFile!==undefined){
    const raw=readFile(ackFile);
    if(Buffer.byteLength(raw,'utf8')>4096)throw Error('Health acknowledgement JSON exceeds 4KB');
    let ack;try{ack=JSON.parse(raw);}catch{throw Error('Health acknowledgement JSON is invalid');}
    body.healthAcknowledgement=validateHealthAcknowledgement(ack,nowSec);
  }
  return {body,execute};
}
function requireFundingDeployment(body, config) {
  if (['approve', 'createAndFund'].includes(body.action) && !(config.version === 2 && config.verified === true && config.newTasksEnabled !== false)) {
    const error = new Error('ESCROW_UPGRADE_REQUIRED: New hosted approvals and funding require an active verified receipt-gated V2 deployment. Existing V1 task settlement and refunds remain supported.');
    error.code = 'ESCROW_UPGRADE_REQUIRED'; throw error;
  }
}
export function validatePrepared(value,body,config){
  requireFundingDeployment(body, config);
  if(String(value?.chainId)!==String(config.chainId)||String(value?.value)!=='0'||!isAddress(value?.to||'')||!/^0x[0-9a-f]+$/i.test(value?.data||''))throw Error('API returned an invalid unsigned transaction');
  if(value.escrowVersion!==undefined&&value.escrowVersion!==(config.version||1))throw Error('API escrow version mismatch');
  if(value.activeDeployment&&(String(value.activeDeployment.chainId)!==String(config.chainId)||value.activeDeployment.address?.toLowerCase()!==config.address.toLowerCase()||value.activeDeployment.version!==(config.version||1)))throw Error('API deployment identity mismatch');
  if(body.action==='rejectAll'&&(config.version||1)<2)throw Error('rejectAll requires a verified V2 deployment; V1 supports timeout refund only');
  const escrow=new Interface(marketplaceAbiFor(config.version||1));
  const expected=body.action==='approve'?config.token:config.address;
  if(value.to.toLowerCase()!==expected.toLowerCase())throw Error('API transaction targets an unexpected token or escrow');
  let decoded;try{decoded=(body.action==='approve'?erc20:escrow).parseTransaction({data:value.data});}catch{throw Error('API calldata is invalid');}
  if(decoded?.name!==body.action)throw Error('API calldata action mismatch');
  if(body.action==='approve'){
    if(decoded.args[0].toLowerCase()!==config.address.toLowerCase()||decoded.args[1]!==parseUnits(body.amount,18))throw Error('API approval spender or amount mismatch');
  }else if(body.action==='createAndFund'){
    if(decoded.args[0].toLowerCase()!==config.token.toLowerCase()||decoded.args[1]!==parseUnits(body.amount,18)||decoded.args[3]!==BigInt(body.submissionDeadline)||decoded.args[4]!==BigInt(body.reviewDeadline))throw Error('API funding amount, token or deadline mismatch');
    if(decoded.args[2]!==hash(body.metadata)||decoded.args[5]!==policyHash(body.policy))throw Error('API task metadata or policy commitment mismatch');
  }else if(decoded.args[0]!==BigInt(body.taskId))throw Error('API task ID mismatch');
  return {...value,note:body.action,to:expected};
}
export async function requestPreparation(body,{base=process.env.ONERUB_API_BASE||'https://onerub.net',fetcher=fetch,config=activeDeployment()}={}){
  const url=new URL('/api/marketplace/prepare',base);
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Marketplace API requires HTTPS');
  requireFundingDeployment(body, config);
  const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,chainId:config.chainId,escrowAddress:config.address}),signal:AbortSignal.timeout(30000),cache:'no-store'});
  let value;try{value=await response.json();}catch{throw Error('Marketplace API returned invalid JSON');}
  if(!response.ok){
    const code=typeof value?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)?value.code:'REQUEST_FAILED';
    const error=Object.assign(Error('Marketplace preparation failed: '+code),{code});
    if(Number.isInteger(response.status)&&response.status>=400&&response.status<=599)error.status=response.status;
    Object.assign(error,safeValidationDetails(value),safeFundingError(value,code));
    throw error;
  }
  return value;
}
function safeFundingError(value,code) {
  if(!['HEALTH_ACK_REQUIRED','FUNDING_UNAVAILABLE'].includes(code))return {};
  const out={};
  if(value?.readiness&&typeof value.readiness==='object'){
    const checks=fundingReadinessContract(value.readiness.checks&&typeof value.readiness.checks==='object'?value.readiness.checks:{});
    out.readiness={status:value.readiness.status==='healthy'&&Object.values(checks).every(c=>['available','not-required'].includes(c.status))?'healthy':'degraded',checks};
  }
  const ack=value?.healthAcknowledgement;
  if(code==='HEALTH_ACK_REQUIRED'){
    if(typeof ack?.token==='string'&&/^[a-f0-9]{64}$/.test(ack.token)&&Number.isSafeInteger(ack.expiresAt)&&ack.expiresAt>0)
      out.healthAcknowledgement={token:ack.token,expiresAt:ack.expiresAt};
    out.hint='Review readiness. To explicitly accept this request only, save {accepted:true,token,expiresAt} from healthAcknowledgement to JSON and retry unchanged approve/create with --health-ack <file.json> before expiry. This does not authorize wallet execution; --execute and preview checks are unchanged.';
  }else out.hint='Funding is unavailable. Restore required services/configuration and retry; acknowledgement cannot bypass this failure.';
  return out;
}
function safeValidationDetails(value) {
  return Object.fromEntries(['field','expected','received'].filter(k=>typeof value?.[k]==='string'&&value[k].length<=200).map(k=>[k,value[k]]));
}
export function taskStopOutput(error) {
  const out={step:'stop',error:String(error?.message||'Marketplace task failed').slice(0,1000)};
  if(typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code))out.code=error.code;
  if(Number.isInteger(error?.status)&&error.status>=400&&error.status<=599)out.status=error.status;
  return {...out,...safeValidationDetails(error),...safeFundingError(error,out.code)};
}
export async function runTask(args,{baw,prepare=requestPreparation,config=activeDeployment(),print=v=>console.log(JSON.stringify(v)),nowSec=BigInt(Math.floor(Date.now()/1000)),readFile}={}){
  const {cmd}=parseTaskArgs(args);
  requireFundingDeployment({action:cmd==='create'?'createAndFund':cmd},config);
  const planned=buildTaskRequest(args,{from:config.address,nowSec,readFile});
  requireFundingDeployment(planned.body, config);
  if(planned.body.action==='rejectAll'&&(config.version||1)<2)throw Error('rejectAll requires a verified V2 deployment; V1 supports timeout refund only');
  // Settings and wallet identity are read locally. No private key or session is
  // sent to ONERUB: only public task input and unsigned calldata are exchanged.
  baw ??= makeBawRunner();
  const settings=baw(['wallet','settings','--json']);const dev=settings?.data?.devMode,raw=dev?.expiresAt;
  const numeric=typeof raw==='number'||(typeof raw==='string'&&/^\d+$/.test(raw))?Number(raw):null;
  const expiry=numeric!==null?(numeric<1e12?numeric*1000:numeric):raw?Date.parse(raw):null;
  if(!settings?.success||dev?.enabled!==true||(expiry!==null&&(!Number.isFinite(expiry)||expiry<=Number(nowSec)*1000)))throw Error('Developer Mode disabled or expired; enable it in Binance App before preview');
  const from=fromAddress(baw);const {body,execute}=planned;if(body.action==='submitCommitment')body.worker=from;
  const call=validatePrepared(await prepare(body,{config}),body,config);
  print({step:'plan',from,chainId:config.chainId,escrowVersion:config.version||1,compatibility:config.compatibility,to:call.to,note:call.note,inputData:call.data,policyHash:call.policyHash,criteriaHash:call.criteriaHash});
  const preview=baw(['contract-call','preview','--binanceChainId',String(config.chainId),'--from',from,'--to',call.to,'--value','0','--inputData',call.data,'--json']);print({step:'preview',preview});
  const requestId=preview?.data?.requestId,code=preview?.data?.simulationResult?.simulationCode;
  if(!preview?.success||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(requestId)||(code&&code!=='000000000'))throw Error('Preview failed, intercepted, or missing a usable requestId; not executing');
  if(!execute){print({step:'dry-run',requestId,broadcast:false,hint:'Inspect parsed transaction and risks before --execute'});return;}
  const execution=baw(['contract-call','execute','--requestId',requestId,'--json']);print({step:'execute',execution,confirmedOnChain:false,hint:'Check App confirmation and receipt: broadcast is not settlement'});
  if(!execution?.success)throw Error('Wallet execution request failed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await runTask(process.argv.slice(2));}catch(error){console.error(JSON.stringify(taskStopOutput(error)));process.exitCode=1;}
}
