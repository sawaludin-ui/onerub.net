import { handle, publicConfig } from '../../../../lib/marketplace-http.mjs';
export const dynamic = 'force-dynamic';
export async function GET() { return handle(publicConfig); }
