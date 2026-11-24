// Read-only health projections: unknown is not failure, and historic success is not current proof.
import { evaluatorConfig } from './marketplace-core.mjs';
export function classifyReadiness(checks) {
 const values=Object.values(checks||{}).map(c=>c?.status||'unknown');
 if(values.some(s=>['failed','unavailable'].includes(s)))return 'failed';
 if(values.some(s=>s==='cooldown'||s==='degraded'||s==='stale'))return 'degraded';
 if(values.some(s=>!['available','not-required'].includes(s)))return 'unverified';
 return values.length?'healthy':'unverified';
}
export async function cachedProviderHealth({storage,now=Date.now(),config=evaluatorConfig(),maxAgeMs=900000}={}){
 const unknown={status:'unknown',basis:'provider-not-probed'};if(!storage?.get)return unknown;
 try{
  const value=await storage.get('ops:provider-probe:last');if(!value)return unknown;
  const at=value.checkedAtMs,age=now-at;if(!Number.isSafeInteger(at)||age<0||age>maxAgeMs)return{status:'unknown',basis:'provider-probe-expired',...(Number.isSafeInteger(at)?{lastProbeAt:new Date(at).toISOString()}:{})};
  if(value.model!==config.model||value.providerOrigin!==new URL(config.url).origin)return{status:'unknown',basis:'provider-configuration-changed'};
  if(!['available','failed','unavailable'].includes(value.status))return unknown;
  return{status:value.status,basis:'recent-synthetic-provider-probe-not-quota-guarantee',checkedAt:new Date(at).toISOString(),ageSeconds:Math.floor(age/1000)};
 }catch{return unknown;}
}
