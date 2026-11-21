import {handle,publicTask} from '../../../../../lib/marketplace-http.mjs';
export const dynamic='force-dynamic';
export async function GET(req,{params}){const {id}=await params;return handle(()=>publicTask(id));}
