#!/usr/bin/env node
// Drives the OneRubMarketplaceEscrow from an agent's Binance Agentic Wallet
// (ferta.ai) through the `baw` CLI, using the two-step contract-call flow
// (preview -> execute). Preview only simulates; nothing is broadcast unless you
// pass --execute, and the CLI still routes high-value calls through the Binance
// App for confirmation.
//
// Usage (always previews first; add --execute to broadcast):
//   node scripts/agent-task.mjs approve <amountUSDC>
//   node scripts/agent-task.mjs create <amountUSDC> <submitMins> <reviewMins> <criteriaHash> <policyHash>
//   node scripts/agent-task.mjs submit <taskId> <contentHash> <artifactPtrHash>
//   node scripts/agent-task.mjs select <taskId> <winnerAddress>
//   node scripts/agent-task.mjs cancel <taskId>
//   node scripts/agent-task.mjs refund <taskId>
//
// The wallet that signs is whichever agent is signed into `baw` (expected: ferta).
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import { Interface, parseUnits, isAddress } from "ethers";

const SHIM = path.join(os.homedir(), ".claude/network/binance-doh.cjs");
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const USDC_DECIMALS = 18;
const CHAIN = "56";

const deployment = JSON.parse(fs.readFileSync(path.join(ROOT,"lib/marketplace-deployment.json"), "utf8"));
const ESCROW = deployment.address;
const escrowAbi = JSON.parse(fs.readFileSync(path.join(ROOT,"lib/marketplace-abi.json"), "utf8"));
const escrow = new Interface(escrowAbi);
const erc20 = new Interface([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

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

function h32(value) {
  if(!/^0x[0-9a-fA-F]{64}$/.test(value||'')||/^0x0{64}$/i.test(value))throw Error('A nonzero bytes32 hash is required; text is not automatically hashed');
  return value;
}
function id(value) {
  if(!/^[1-9]\d*$/.test(value||'')||BigInt(value)>=2n**256n)throw Error('Task ID must be a positive uint256');
  return BigInt(value);
}
function qty(value,allowZero=false) {
  if(!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value||''))throw Error('USDC amount must be a decimal with at most 18 places');
  const n=parseUnits(value,USDC_DECIMALS);
  if((!allowZero&&n<10n)||n>=2n**256n)throw Error('USDC amount outside allowed range');
  return n;
}
export function buildTaskCall(args,nowSec=BigInt(Math.floor(Date.now()/1000))) {
  if(args.filter(a=>a==='--execute').length>1)throw Error('Duplicate execute flag');
  const execute=args.includes('--execute');
  const [cmd,...p]=args.filter(a=>a!=='--execute');
  const lengths={approve:1,create:5,submit:3,select:2,cancel:1,refund:1};
  if(!(cmd in lengths)||p.length!==lengths[cmd])throw Error('Invalid arguments; see script usage');
  const call=build(cmd,p,nowSec);
  return {...call,execute};
}
function build(cmd,p,nowSec) {
  switch (cmd) {
    case "approve": {
      const amount = qty(p[0],cmd === "approve");
      return { to: USDC, data: erc20.encodeFunctionData("approve", [ESCROW, amount]), note: `approve ${p[0]} USDC to escrow` };
    }
    case "create": {
      const amount = qty(p[0]);
      if(!/^[1-9]\d*$/.test(p[1])||!/^[1-9]\d*$/.test(p[2]))throw Error("Deadline minutes must be positive integers");
      if(BigInt(p[1])<2n||BigInt(p[2])<=BigInt(p[1])||nowSec+BigInt(p[2])*60n>=2n**64n)throw Error("Submission must be at least 2 minutes and review must end later");
      const subDl = nowSec + BigInt(p[1]) * 60n;
      const revDl = nowSec + BigInt(p[2]) * 60n;
      const criteria = h32(p[3]);
      const policy = h32(p[4]);
      return {
        to: ESCROW,
        data: escrow.encodeFunctionData("createAndFund", [USDC, amount, criteria, subDl, revDl, policy]),
        note: `createAndFund ${p[0]} USDC, submit +${p[1]}m, review +${p[2]}m`,
      };
    }
    case "submit":
      return { to: ESCROW, data: escrow.encodeFunctionData("submitCommitment", [id(p[0]), h32(p[1]), h32(p[2])]), note: `submit task ${p[0]}` };
    case "select":
      if (!isAddress(p[1]) || /^0x0{40}$/i.test(p[1])) throw Error("winner must be an address");
      return { to: ESCROW, data: escrow.encodeFunctionData("selectWinner", [id(p[0]), p[1]]), note: `select winner ${p[1]} for task ${p[0]}` };
    case "cancel":
      return { to: ESCROW, data: escrow.encodeFunctionData("cancel", [id(p[0])]), note: `cancel task ${p[0]}` };
    case "refund":
      return { to: ESCROW, data: escrow.encodeFunctionData("refund", [id(p[0])]), note: `refund task ${p[0]}` };
    default:
      throw Error(`Unknown command: ${cmd}. See header for usage.`);
  }
}

export function runTask(args,{baw=makeBawRunner(),print=v=>console.log(JSON.stringify(v)),nowSec=BigInt(Math.floor(Date.now()/1000))}={}) {
  const call=buildTaskCall(args,nowSec);
  const settings=baw(['wallet','settings','--json']);
  const dev=settings?.data?.devMode;
  const raw=dev?.expiresAt;
  const numeric=typeof raw==='number'||(typeof raw==='string'&&/^\d+$/.test(raw))?Number(raw):null;
  const expiry=numeric!==null?(numeric<1e12?numeric*1000:numeric):raw?Date.parse(raw):null;
  if(!settings?.success||dev?.enabled!==true||(expiry!==null&&(!Number.isFinite(expiry)||expiry<=Number(nowSec)*1000)))throw Error('Developer Mode disabled or expired; enable it in Binance App before preview');
  const from=fromAddress(baw);
  print({step:'plan',from,to:call.to,note:call.note,inputData:call.data});
  const preview=baw(['contract-call','preview','--binanceChainId',CHAIN,'--from',from,'--to',call.to,'--value','0','--inputData',call.data,'--json']);
  print({step:'preview',preview});
  const requestId=preview?.data?.requestId,code=preview?.data?.simulationResult?.simulationCode;
  if(!preview?.success||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(requestId)||(code&&code!=='000000000'))throw Error('Preview failed, intercepted, or missing a usable requestId; not executing');
  if(!call.execute){print({step:'dry-run',requestId,broadcast:false,hint:'Inspect parsed transaction and risks before --execute'});return;}
  const execution=baw(['contract-call','execute','--requestId',requestId,'--json']);
  print({step:'execute',execution,confirmedOnChain:false,hint:'Check App confirmation and receipt: broadcast is not settlement'});
  if(!execution?.success)throw Error('Wallet execution request failed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{runTask(process.argv.slice(2));}catch(error){console.error(JSON.stringify({step:'stop',error:error.message}));process.exitCode=1;}
}
