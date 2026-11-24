// Server-only operational probes; no participant reports or arbitrary prompts accepted.
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { store, evaluatorConfig, capabilities, hash, artifactKey, encryptArtifact } from './marketplace-core.mjs';
import { runEvaluator } from './marketplace-service.mjs';
import { DEFAULT_POLICY } from './marketplace-policy.mjs';
export function authorizeOps(req, secret = process.env.CRON_SECRET) {
 const value=req.headers.get('authorization')||'';
 if(typeof secret!=='string'||secret.length<32)return false;
 const expected='Bearer '+secret;
 return timingSafeEqual(createHash('sha256').update(value).digest(),createHash('sha256').update(expected).digest());
}
export async function probeEvaluator({storage=store,evaluate=runEvaluator,config=evaluatorConfig(),now=Date.now}={}) {
 const key='ops:provider-probe:last',owner=randomBytes(16).toString('hex');
 if(!await storage.put('ops:provider-probe:lease',owner,{nx:true,ttl:90}))return {status:'busy',code:'PROBE_RUNNING'};
 try{
  const prior=await storage.get(key);if(prior&&now()-prior.checkedAtMs<60000)return {...prior,cached:true};
  const start=now(),worker=Wallet.createRandom().address,id='1',bytes=Buffer.from('Synthetic readiness test only. Two plus two equals four.');
  const encrypted=encryptArtifact(bytes,artifactKey(id,worker));
  const record={worker,size:bytes.length,encrypted,contentHash:hash(encrypted),artifactPtrHash:hash('isolated-ops-probe'),plaintextHash:(await import('ethers')).keccak256(bytes)};
  const task={id};let result,providerHttpStatus=null;
  try{
   const score=await evaluate(task,[record],{title:'Synthetic evaluator readiness arithmetic',description:'Verify the arithmetic in this synthetic public report.',rubric:'Accept a correct statement that two plus two equals four; reject incorrect arithmetic.',category:'ops-probe'},{policy:DEFAULT_POLICY,model:config.model,storage,transport:{fetchImpl:async(...args)=>{const response=await fetch(...args);providerHttpStatus=response.status;return response;}}});
   result={status:score.acceptable&&score.score>=70?'available':'failed',code:score.acceptable&&score.score>=70?'PROVIDER_PROBE_OK':'PROVIDER_PROBE_UNEXPECTED_VERDICT',model:config.model,providerOrigin:new URL(config.url).origin,checkedAtMs:now(),durationMs:now()-start,synthetic:true,participantReportsRead:0,taskDecisionWritten:false};
  }catch(error){result={status:'unavailable',code:/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'PROVIDER_PROBE_FAILED',model:config.model,providerOrigin:new URL(config.url).origin,checkedAtMs:now(),durationMs:now()-start,synthetic:true,participantReportsRead:0,taskDecisionWritten:false};}
  result.evaluatorVersion=DEFAULT_POLICY.evaluatorVersion;result.policyVersion=DEFAULT_POLICY.version;result.providerHttpStatus=providerHttpStatus;await storage.put(key,result,{ttl:86400});return result;
 }finally{await storage.release('ops:provider-probe:lease',owner);}
}
export async function operationalStatus({storage=store}={}){
 return{capabilities:capabilities(),providerProbe:await storage.get('ops:provider-probe:last'),automationEnabled:process.env.MARKETPLACE_AUTOMATION_ENABLED==='true',relayerConfigured:Boolean(process.env.MARKETPLACE_RELAYER_KEY),note:'A successful synthetic probe does not prove quota for all tasks or participant delivery.'};
}
