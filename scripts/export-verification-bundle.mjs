// Public verifier handoff bundle: exact deployed source, ABI, constructor args and deployment evidence only.
import fs from 'node:fs';
import {AbiCoder} from 'ethers';
import {validateDeploymentManifest} from '../lib/marketplace-deployment-resolver.mjs';
const d=JSON.parse(fs.readFileSync('lib/marketplace-v2-deployment.json','utf8'));
if(!validateDeploymentManifest(d,2))throw Error('Verified V2 deployment evidence required');
const directory='artifacts/onerub-v2-verification';fs.mkdirSync(directory,{recursive:true});
for(const [from,to] of [['artifacts/marketplace-v2/deployed-compiler-input.json','standard-input.json'],['lib/marketplace-v2-abi.json','abi.json'],['lib/marketplace-v2-deployment.json','deployment.json']])fs.copyFileSync(from,directory+'/'+to);
const args=AbiCoder.defaultAbiCoder().encode(['address','address','address','address'],[d.registry,d.treasury,d.token,d.evaluator]).slice(2);
fs.writeFileSync(directory+'/constructor-arguments.txt',args+String.fromCharCode(10));
const readme=['ONERUB V2 source verification','Address: '+d.address,'Chain: BNB Smart Chain (56)','Deployment transaction: '+d.transactionHash,'Block: '+d.blockNumber,'Compiler: v'+d.compiler.replace('.Emscripten.clang',''),'Optimization: enabled, runs200','EVM: Cancun','Contract identifier: OneRubMarketplaceEscrowV2.sol:OneRubMarketplaceEscrowV2','License: MIT','Upload standard-input.json as Solidity Standard JSON; constructor arguments are in the separate file.','Sourcify exact creation/runtime and readback already recorded. BscScan verification is a separate check.','This bundle contains public source only; no private keys, provider credentials, user artifacts or wallet sessions.'];
fs.writeFileSync(directory+'/README.txt',readme.join(String.fromCharCode(10))+String.fromCharCode(10));
console.log(JSON.stringify({publicVerificationBundle:directory,files:5,address:d.address,sourceVerified:'Sourcify exact creation and runtime',bscScanVerified:false}));
