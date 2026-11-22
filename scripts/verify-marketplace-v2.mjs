// Node.js — read-only verification by default; --submit explicitly uploads source, --record explicitly records activation evidence.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Contract,FetchRequest,JsonRpcProvider,keccak256} from 'ethers';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=path.join(root,'lib/marketplace-v2-deployment.json');
const d=JSON.parse(fs.readFileSync(manifest));
if(!d.address||d.chainId!==56||d.protocolRevision!==3)throw Error('Deployed V2 revision3 record required');
const file=path.join(root,'artifacts/marketplace-v2/deployed-compiler-input.json');
if(process.argv.includes('--submit')){
  if(!fs.existsSync(file))throw Error('Exact deployed compiler input required; do not recompile for verification');
  const response=await fetch('https://sourcify.dev/server/v2/verify/56/'+d.address,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(45000),body:JSON.stringify({stdJsonInput:JSON.parse(fs.readFileSync(file)),compilerVersion:d.compiler.replace(/\.Emscripten\.clang$/,''),contractIdentifier:'OneRubMarketplaceEscrowV2.sol:OneRubMarketplaceEscrowV2',creationTransactionHash:d.transactionHash})});
  if(!response.ok)throw Error('Source verification submission failed: HTTP '+response.status);
  console.log(JSON.stringify({submitted:true,result:await response.json(),activationRecorded:false}));
}else{
  const response=await fetch('https://sourcify.dev/server/v2/contract/56/'+d.address+'?fields=creationMatch,runtimeMatch,deployment',{signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('Source verification unavailable: HTTP '+response.status);
  const source=await response.json();
  if(source.creationMatch!=='exact_match'||source.runtimeMatch!=='exact_match')throw Error('Exact creation and runtime source matches required');
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  if(source.address&&!same(source.address,d.address)||source.chainId&&Number(source.chainId)!==56||
     !same(source.deployment?.transactionHash,d.transactionHash)||Number(source.deployment?.blockNumber)!==Number(d.blockNumber))
    throw Error('Source verification deployment identity mismatch');
  const request=new FetchRequest(process.env.BSC_RPC_URL||'https://bsc-dataseed.bnbchain.org');request.timeout=15000;
  const provider=new JsonRpcProvider(request,undefined,{batchMaxCount:1});
  try{
    if((await provider.getNetwork()).chainId!==56n)throw Error('RPC chain mismatch');
    const receipt=await provider.getTransactionReceipt(d.transactionHash),code=await provider.getCode(d.address);
    if(!receipt||receipt.status!==1||!same(receipt.contractAddress,d.address)||receipt.blockNumber!==Number(d.blockNumber)||code==='0x')throw Error('Confirmed deployment mismatch');
    if(await provider.getBlockNumber()-receipt.blockNumber<3)throw Error('Three deployment confirmations required');
    const abi=JSON.parse(fs.readFileSync(path.join(root,'lib/marketplace-v2-abi.json'))),c=new Contract(d.address,abi,provider);
    const readBack={agentId:await c.agentId(),treasury:await c.treasury(),evaluator:await c.evaluator(),usdcAllowed:await c.allowedToken(d.token),feeBps:String(await c.FEE_BPS()),minReviewSeconds:String(await c.MIN_REVIEW_WINDOW()),maxParticipants:String(await c.MAX_PARTICIPANTS()),protocolRevision:String(await c.PROTOCOL_REVISION()),minimumValidSubmissions:String(await c.MIN_VALID_SUBMISSIONS()),evaluatorRevoked:await c.revokedEvaluator(await c.evaluator())};
    if(!same(readBack.agentId,d.registry)||!same(readBack.treasury,d.treasury)||!same(readBack.evaluator,d.evaluator)||!readBack.usdcAllowed||readBack.feeBps!=='1000'||readBack.minReviewSeconds!=='3600'||readBack.protocolRevision!=='3'||readBack.minimumValidSubmissions!=='1'||readBack.evaluatorRevoked)throw Error('Live contract configuration mismatch');
    const verification={status:'verified',chainId:56,address:d.address,transactionHash:d.transactionHash,blockNumber:receipt.blockNumber,runtimeCodeHash:keccak256(code),protocolRevision:3,source:'sourcify',creationMatch:'exact_match',runtimeMatch:'exact_match'};
    if(process.argv.includes('--record'))fs.writeFileSync(manifest,JSON.stringify({...d,status:'verified',readBack,verification},null,2)+'\n');
    console.log(JSON.stringify({verification,readBack,activationRecorded:process.argv.includes('--record')}));
  }finally{provider.destroy();}
}
