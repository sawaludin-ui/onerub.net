// Defaults to read-only gas/config preflight. Root must explicitly --broadcast.
// V1 deployment/ABI are never modified. Pending transaction journal prevents a
// duplicate broadcast after an RPC timeout or process interruption.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Contract,ContractFactory,FetchRequest,JsonRpcProvider,Wallet,formatEther,getCreateAddress,isAddress,keccak256,parseEther} from 'ethers';
import {compileMarketplaceV2} from './compile-marketplace-v2.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'lib/marketplace-v2-deployment.json'),pending=path.join(root,'.local/marketplace-v2-pending.json');
const REGISTRY='0x60b9262456de011f7d15a54cdd8c48baaa8b022f',TREASURY='0x607cF25614065179a9238705E03E6590C082F56d',TOKEN='0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const broadcast=process.argv.includes('--broadcast');
compileMarketplaceV2();
if(fs.existsSync(output)&&JSON.parse(fs.readFileSync(output)).address)throw Error('V2 already recorded; do not deploy a duplicate');
const request=new FetchRequest(process.env.BSC_RPC_URL||'https://bsc-dataseed.bnbchain.org');request.timeout=15000;
const provider=new JsonRpcProvider(request,undefined,{batchMaxCount:1,pollingInterval:1500});
try {
  if((await provider.getNetwork()).chainId!==56n)throw Error('RPC is not BNB mainnet chain56');
  const secret=JSON.parse(fs.readFileSync(process.env.ONERUB_DEPLOYER_SECRET_PATH||'D:/NXR/secrets/agentopia-oracle.json','utf8'));
  let signer;try{signer=new Wallet(secret.privateKey,provider);}catch{throw Error('Deployment key is invalid');}
  let evaluator=process.env.MARKETPLACE_V2_EVALUATOR;
  if(!evaluator&&process.env.MARKETPLACE_ATTESTATION_KEY){try{evaluator=new Wallet(process.env.MARKETPLACE_ATTESTATION_KEY).address;}catch{throw Error('Attestation key is invalid');}}
  if(!isAddress(evaluator||''))throw Error('Provide MARKETPLACE_V2_EVALUATOR or MARKETPLACE_ATTESTATION_KEY');
  for(const [name,a]of [['registry',REGISTRY],['token',TOKEN]])if((await provider.getCode(a))==='0x')throw Error(name+' missing mainnet bytecode');
  const a=JSON.parse(fs.readFileSync(path.join(root,'artifacts/marketplace-v2/OneRubMarketplaceEscrowV2.json')));
  const factory=new ContractFactory(a.abi,a.bytecode,signer),args=[REGISTRY,TREASURY,TOKEN,evaluator];
  const tx=await factory.getDeployTransaction(...args),gas=await provider.estimateGas({...tx,from:signer.address});
  const gasPrice=(await provider.getFeeData()).gasPrice;if(gasPrice===null)throw Error('Gas price unavailable');
  const gasLimit=gas*120n/100n,maxCost=gasLimit*gasPrice,balance=await provider.getBalance(signer.address);
  const plan={protocolRevision:3,minimumValidSubmissions:1,signerRecovery:"snapshot-revoke-refund-no-active-migration",settlement:"signed-receipt-relayer-funded-escrow-only",chainId:56,deployer:signer.address,registry:REGISTRY,treasury:TREASURY,token:TOKEN,evaluator,estimatedGas:String(gas),gasLimit:String(gasLimit),gasPriceWei:String(gasPrice),maxCostBNB:formatEther(maxCost),balanceBNB:formatEther(balance),broadcastRequested:broadcast,runtimeBytes:(a.deployedBytecode.length-2)/2,minReviewSeconds:3600,maxParticipants:64};
  console.log(JSON.stringify({plan}));
  if(!broadcast)process.exitCode=0;
  else {
    if(fs.existsSync(pending))throw Error('V2 pending journal exists; inspect its tx hash before any retry');
    if(maxCost>parseEther(process.env.MAX_DEPLOY_GAS_BNB||'0.001'))throw Error('Estimated gas exceeds configured deployment budget');
    if(balance<maxCost)throw Error('Insufficient deployment gas; no transaction submitted');
    const nonce=await provider.getTransactionCount(signer.address,'pending');
    const signed=await signer.signTransaction({...tx,chainId:56,nonce,gasLimit,gasPrice,type:0});
    const transactionHash=keccak256(signed),address=getCreateAddress({from:signer.address,nonce});
    fs.mkdirSync(path.dirname(pending),{recursive:true});
    fs.writeFileSync(pending,JSON.stringify({transactionHash,address,nonce,deployer:signer.address,plan},null,2),{flag:'wx'});
    fs.copyFileSync(path.join(root,'artifacts/marketplace-v2/compiler-input.json'),path.join(root,'artifacts/marketplace-v2/deployed-compiler-input.json'));
    await provider.broadcastTransaction(signed);console.log(JSON.stringify({submitted:transactionHash,address}));
    const receipt=await provider.waitForTransaction(transactionHash,3,180000);
    if(!receipt||receipt.status!==1)throw Error('Deployment receipt missing or failed; preserve journal and inspect chain');
    if((await provider.getCode(address)).length<100)throw Error('Confirmed deployment bytecode missing');
    const c=new Contract(address,a.abi,provider);
    const readBack={agentId:await c.agentId(),treasury:await c.treasury(),evaluator:await c.evaluator(),usdcAllowed:await c.allowedToken(TOKEN),feeBps:String(await c.FEE_BPS()),minReviewSeconds:String(await c.MIN_REVIEW_WINDOW()),maxParticipants:String(await c.MAX_PARTICIPANTS()),protocolRevision:String(await c.PROTOCOL_REVISION()),minimumValidSubmissions:String(await c.MIN_VALID_SUBMISSIONS()),evaluatorRevoked:await c.revokedEvaluator(evaluator)};
    if(readBack.agentId.toLowerCase()!==REGISTRY.toLowerCase()||readBack.treasury.toLowerCase()!==TREASURY.toLowerCase()||readBack.evaluator.toLowerCase()!==evaluator.toLowerCase()||!readBack.usdcAllowed||readBack.feeBps!=='1000'||readBack.minReviewSeconds!=='3600'||readBack.protocolRevision!=='3'||readBack.minimumValidSubmissions!=='1'||readBack.evaluatorRevoked)throw Error('Post-deploy wiring mismatch; preserve journal');
    const deployed={version:2,protocolRevision:3,status:"deployed-unverified",chainId:56,contract:'OneRubMarketplaceEscrowV2',address,registry:REGISTRY,treasury:TREASURY,token:TOKEN,evaluator,deployer:signer.address,blockNumber:receipt.blockNumber,transactionHash,deployedWib:new Date().toLocaleString('sv-SE',{timeZone:'Asia/Jakarta'})+' WIB',gasUsed:String(receipt.gasUsed),gasPriceWei:String(receipt.gasPrice),costBNB:formatEther(receipt.gasUsed*receipt.gasPrice),compiler:fs.readFileSync(path.join(root,'artifacts/marketplace-v2/compiler-version.txt'),'utf8'),readBack};
    fs.writeFileSync(output,JSON.stringify(deployed,null,2)+'\n');fs.unlinkSync(pending);console.log(JSON.stringify({verifiedDeployment:deployed}));
  }
}finally{provider.destroy();}
