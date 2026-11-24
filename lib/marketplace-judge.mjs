// Node.js — v4 bounded data-only judging; no executable validators or external tools.
import { canonical, fail } from './marketplace-core.mjs';
export const JUDGE_VERSION = 'onerub-review-v4';
export const REASON_CODES = Object.freeze(['SATISFIED','PARTIAL','MISSING','UNSUPPORTED','INCORRECT']);
const DEFAULT_CRITERIA = Object.freeze([
  {id:'correctness',weight:40,description:'Correctness against the public task and rubric.'},
  {id:'completeness',weight:30,description:'Coverage of all requested deliverables.'},
  {id:'evidence',weight:30,description:'Verifiable support within the submitted artifact, without assuming external execution.'},
]);
const invalid=()=>fail('Invalid public structured rubric.',400,'RUBRIC_INVALID');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,allowed)=>object(x)&&Object.keys(x).every(k=>allowed.includes(k));
const id=x=>typeof x==='string'&&/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(x);
export function judgeRubric(metadata){
  const text=metadata?.rubric;
  if(typeof text!=='string')invalid();
  // Plain-language legacy-style rubrics remain usable, but never infer an answer key.
  if(!text.trim().startsWith('{'))return {protocol:'onerub-rubric-v1',criteria:structuredClone(DEFAULT_CRITERIA),assertions:[]};
  let value;try{value=JSON.parse(text);}catch{invalid();}
  if(!keys(value,['protocol','criteria','assertions'])||value.protocol!=='onerub-rubric-v1'||!Array.isArray(value.criteria)||value.criteria.length<1||value.criteria.length>8)invalid();
  if(value.criteria.some(c=>!keys(c,['id','weight','description'])||!id(c.id)||!Number.isInteger(c.weight)||c.weight<1||c.weight>100||typeof c.description!=='string'||c.description.length<1||c.description.length>500)||value.criteria.reduce((n,c)=>n+c.weight,0)!==100||new Set(value.criteria.map(c=>c.id)).size!==value.criteria.length)invalid();
  const assertions=value.assertions??[];
  if(!Array.isArray(assertions)||assertions.length>16||new Set(assertions.map(a=>a?.id)).size!==assertions.length)invalid();
  for(const a of assertions){
    if(!keys(a,['id','path','equals'])||!id(a.id)||!Object.hasOwn(a,'equals')||canonical(a.equals).length>2048||!(a.path==='$text'||Array.isArray(a.path)&&a.path.length<=8&&a.path.every(k=>typeof k==='string'&&k.length>0&&k.length<=64&&!['__proto__','constructor','prototype'].includes(k))))invalid();
  }
  return {protocol:value.protocol,criteria:value.criteria,assertions};
}
export function deterministicChecks(bytes,rubric){
  let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{parsed=undefined;}
  return rubric.assertions.map(a=>{
    let actual=a.path==='$text'?bytes.toString('utf8'):parsed;
    if(Array.isArray(a.path))for(const key of a.path){actual=actual!==null&&typeof actual==='object'&&Object.hasOwn(actual,key)?actual[key]:undefined;}
    return {id:a.id,passed:actual!==undefined&&canonical(actual)===canonical(a.equals)};
  });
}
export function parseJudgeScore(text,rubric,{minScore=70,assertions=[]}={}){
  let value;try{value=JSON.parse(text);}catch{}
  const bad=()=>fail('Evaluator returned an invalid criterion score.',502,'EVALUATOR_INVALID');
  if(!keys(value,['criteria'])||Object.keys(value).length!==1||!Array.isArray(value.criteria)||value.criteria.length!==rubric.criteria.length)bad();
  const criteria=rubric.criteria.map((criterion,i)=>{
    const c=value.criteria[i];
    if(!keys(c,['id','score','reasonCode'])||Object.keys(c).length!==3||c.id!==criterion.id||!Number.isInteger(c.score)||c.score<0||c.score>100||!REASON_CODES.includes(c.reasonCode))bad();
    return {id:c.id,score:c.score,reasonCode:c.reasonCode};
  });
  const scoreBasisPoints=criteria.reduce((n,c,i)=>n+c.score*rubric.criteria[i].weight,0);
  return {score:Math.floor(scoreBasisPoints/100),scoreBasisPoints,acceptable:scoreBasisPoints>=minScore*100&&assertions.every(a=>a.passed),criteria,assertions};
}
export function compareJudgeScores(a,b){
  return b.scoreBasisPoints-a.scoreBasisPoints||a.submissionOrder.ordinal-b.submissionOrder.ordinal;
}
// Authentication is performed by HTTP before this projection. Never return a MAC
// over a redacted object: worker progress is informational, not an attested verdict.
export function decisionView(decision,who,task){
  // The attested decision already binds its requester; a caller-supplied task is optional.
  const requester=task?.requester??decision?.requester;
  if(typeof requester!=='string'||who.toLowerCase()===requester.toLowerCase())return decision;
  const out={};
  for(const key of ['status','outcome','taskId','processed','total','acceptedCandidates','excludedCount','nextAction','evaluatorVersion','snapshotBlock','code','retryAfterSeconds','retryAt','winner','score','coverage','expiresAt'])if(decision[key]!==undefined)out[key]=decision[key];
  return out;
}
