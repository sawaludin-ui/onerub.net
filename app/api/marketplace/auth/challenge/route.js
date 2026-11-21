import {handle,challenge} from '../../../../../lib/marketplace-http.mjs';
export const runtime='nodejs';
export async function POST(req){return handle(()=>challenge(req));}
