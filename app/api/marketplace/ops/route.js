import { authorizeOps, probeEvaluator, operationalStatus } from '../../../../lib/marketplace-ops.mjs';
import { smokeAutomationStorage } from '../../../../lib/marketplace-automation-smoke.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export async function GET(req){if(!authorizeOps(req))return reply({code:'UNAUTHORIZED'},401);try{return reply(await operationalStatus());}catch{return reply({code:'OPS_UNAVAILABLE'},503);}}
export async function POST(req){if(!authorizeOps(req))return reply({code:'UNAUTHORIZED'},401);let body;try{body=await req.json();}catch{return reply({code:'INVALID_REQUEST'},400);}if(!['probe','storage-smoke'].includes(body?.action)||Object.keys(body).length!==1)return reply({code:'INVALID_REQUEST'},400);try{const result=body.action==='probe'?await probeEvaluator():await smokeAutomationStorage();return reply(result,result.status==='available'?200:result.status==='busy'?409:503);}catch{return reply({code:'PROBE_UNAVAILABLE'},503);}}
