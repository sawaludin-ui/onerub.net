import {handle,publicList} from '../../../lib/marketplace-http.mjs';
export const dynamic='force-dynamic';
export async function GET(req){return handle(()=>publicList(req));}
