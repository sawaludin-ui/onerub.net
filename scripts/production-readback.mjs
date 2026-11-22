// Read-only public release evidence; never authorizes wallet actions or invents task usage.
import fs from 'node:fs';
import {ACTIVE_MARKETPLACE_DEPLOYMENT as expected} from '../lib/marketplace-deployment-resolver.mjs';
const base='https://onerub.net',paths=['/api/marketplace/config','/api/marketplace/health','/api/marketplace','/tasks','/permissions','/playground','/skill.md','/security.md','/terms.md','/submission.md'];
const checks=[],bodies={};
for(const path of paths){const response=await fetch(base+path,{cache:'no-store',signal:AbortSignal.timeout(35000)}),text=await response.text();checks.push({path,status:response.status,bytes:Buffer.byteLength(text)});if(response.headers.get('content-type')?.includes('json'))bodies[path]=JSON.parse(text);}
const config=bodies['/api/marketplace/config'],health=bodies['/api/marketplace/health'],list=bodies['/api/marketplace'];
const actual=config?.activeDeployment;
const match=actual?.address?.toLowerCase()===expected.address.toLowerCase()&&actual?.version===expected.version&&config.newTasksEnabled===(expected.version===2)&&list?.contract?.toLowerCase()===expected.address.toLowerCase();
const result={checkedAt:new Date().toISOString(),base,identityMatched:match,checks,config,health,totalTasks:list?.totalTasks,readBlock:list?.readBlock,limitations:['No wallet signing, task funding, private uploads, provider inference or artifact delivery is performed by this check.','Source verification is Sourcify evidence; BscScan verification is distinct.']};
fs.mkdirSync('docs/audit-evidence',{recursive:true});fs.writeFileSync('docs/audit-evidence/production-release.json',JSON.stringify(result,null,2)+String.fromCharCode(10));
console.log(JSON.stringify({base,identityMatched:match,allHttp200:checks.every(c=>c.status===200),version:actual?.version,address:actual?.address,totalTasks:list?.totalTasks,readiness:health?.status,checks:health?.checks}));
if(!match||checks.some(c=>c.status!==200))process.exitCode=1;
