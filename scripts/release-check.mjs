// Repository release integrity; no credential contents, network or financial operations.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const required=['public/security.md','public/terms.md','public/submission.md','public/skill.md','lib/marketplace-v2-deployment.json','contracts/vendor/legacy-openzeppelin.json'];
for(const file of required)if(!fs.existsSync(file))throw Error('Required release file missing: '+file);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8')),lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
if(pkg.overrides?.solc?.tmp!=='0.2.7'||lock.packages['node_modules/solc/node_modules/tmp']?.version!=='0.2.7')throw Error('tmp override and lock must agree');
const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split(String.fromCharCode(0)).filter(Boolean);
const forbidden=tracked.filter(file=>file.split('/').some(part=>(part.startsWith('.env')&&part!=='.env.example')||part==='.local'||part.includes('runtime-secrets')||part.includes('recovery-vault')||part.endsWith('.dpapi')));
if(forbidden.length)throw Error('Sensitive file path tracked in git');
const {ACTIVE_MARKETPLACE_DEPLOYMENT:deployment,MARKETPLACE_ABI,validateDeploymentManifest}=await import('../lib/marketplace-deployment-resolver.mjs');
const manifest=JSON.parse(fs.readFileSync(deployment.version===2?'lib/marketplace-v2-deployment.json':'lib/marketplace-deployment.json','utf8'));
if(!validateDeploymentManifest(manifest,deployment.version))throw Error('Invalid active deployment');
if(!MARKETPLACE_ABI.some(entry=>entry.name==='createAndFund'))throw Error('Matching ABI missing');
console.log(JSON.stringify({releaseIntegrity:true,requiredFiles:required.length,trackedSecretPaths:0,activeVersion:deployment.version,activeContract:deployment.address,newTasksEnabled:deployment.version===2,tmpLocked:'0.2.7'}));
