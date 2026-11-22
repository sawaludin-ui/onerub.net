import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import solc from 'solc';
const root=fileURLToPath(new URL('../',import.meta.url));
export function compileMarketplaceV2({writeAbi=true}={}){
  const sources=Object.fromEntries(['OneRubMarketplaceEscrowV2.sol','MockAgentID.sol','MockERC20.sol'].map(n=>[n,{content:fs.readFileSync(path.join(root,'contracts',n),'utf8')}]));
  const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode','evm.deployedBytecode','metadata']}}}};
  const output=JSON.parse(solc.compile(JSON.stringify(input),{import:p=>{try{return {contents:fs.readFileSync(path.join(root,'node_modules',p),'utf8')}}catch{return {error:'Missing import '+p}}}}));
  const errors=(output.errors||[]).filter(e=>e.severity==='error');if(errors.length)throw Error(errors.map(e=>e.formattedMessage).join('\n'));
  for(const file of Object.keys(output.sources))if(!input.sources[file])input.sources[file]={content:fs.readFileSync(path.join(root,'node_modules',file),'utf8')};
  const dir=path.join(root,'artifacts/marketplace-v2');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'compiler-input.json'),JSON.stringify(input));fs.writeFileSync(path.join(dir,'compiler-version.txt'),solc.version());
  for(const [file,contracts]of Object.entries(output.contracts))for(const [name,c]of Object.entries(contracts))if(c.evm.bytecode.object){const a={name,source:file,abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,deployedBytecode:'0x'+c.evm.deployedBytecode.object,metadata:c.metadata};fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(a,null,2));if(name==='OneRubMarketplaceEscrowV2'&&writeAbi)fs.writeFileSync(path.join(root,'lib/marketplace-v2-abi.json'),JSON.stringify(a.abi,null,2));}
  return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){compileMarketplaceV2();const a=JSON.parse(fs.readFileSync(path.join(root,'artifacts/marketplace-v2/OneRubMarketplaceEscrowV2.json')));console.log(JSON.stringify({compiled:a.name,compiler:solc.version(),runtimeBytes:(a.deployedBytecode.length-2)/2}));}
