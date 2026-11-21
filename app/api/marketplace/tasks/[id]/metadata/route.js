import {handle,privateAction} from '../../../../../../lib/marketplace-http.mjs';
export const runtime='nodejs';
export const maxDuration=60;
export async function POST(req,{params}){const {id}=await params;return handle(()=>privateAction(req,id,'metadata'));}
