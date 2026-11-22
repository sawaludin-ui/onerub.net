import { handle, publicProfile } from '../../../../../lib/marketplace-http.mjs';
export const dynamic = 'force-dynamic';
export async function GET(req, { params }) { const { address } = await params; return handle(() => publicProfile(req, address)); }
