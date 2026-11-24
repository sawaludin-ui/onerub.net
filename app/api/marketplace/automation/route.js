// Server-owned scheduler entry. No user-supplied task IDs, decisions, prompts or transactions.
import { authorizeOps } from '../../../../lib/marketplace-ops.mjs';
import { createAutomation } from '../../../../lib/marketplace-automation.mjs';
import { createSettlementRelayer } from '../../../../lib/marketplace-relayer.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const relay=createSettlementRelayer();
const automation=createAutomation({settle:relay.settleTask});
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
export async function GET(req){if(!authorizeOps(req))return reply({code:'UNAUTHORIZED'},401);try{return reply({queue:await automation.inspect(),relayer:relay.status(),enabled:process.env.MARKETPLACE_AUTOMATION_ENABLED==='true'});}catch{return reply({code:'AUTOMATION_UNAVAILABLE'},503);}}
export async function POST(req){if(!authorizeOps(req))return reply({code:'UNAUTHORIZED'},401);try{const text=await req.text();if(text&&text!=='{}')return reply({code:'INVALID_REQUEST'},400);return reply(await automation.tick());}catch{return reply({code:'AUTOMATION_UNAVAILABLE',retryable:true},503);}}
