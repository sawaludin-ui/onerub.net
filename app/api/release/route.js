// Build-frozen public provenance. Never inspect runtime environment or filesystem here.
import manifest from '../../../artifacts/release/manifest.json';
export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json(manifest, {headers: {'Cache-Control': 'no-store', 'X-ONERUB-Build-Id': manifest.buildId}});
}
