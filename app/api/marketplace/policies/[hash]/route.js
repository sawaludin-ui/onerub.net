import { handle, publicPolicy } from '../../../../../lib/marketplace-http.mjs';
export const dynamic = 'force-dynamic';
export async function GET(req, { params }) { const { hash } = await params; return handle(() => publicPolicy(hash)); }
