import { handle, publicList } from "../../../lib/marketplace-http.mjs";
import { MarketplaceError } from "../../../lib/marketplace-core.mjs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const url = new URL(req.url);
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", "12");
  try {
    const result = await publicList(new Request(url, req));
    return handle(() => result);
  } catch (error) {
    // Only the public listing index exposes a retry snapshot; private errors stay unchanged.
    if (error instanceof MarketplaceError && error.code === "INDEX_BUILDING") {
      const readBlock = Number(error.readBlock);
      return Response.json({
        error: "Preparing the search index. Retry this page shortly.",
        code: "INDEX_BUILDING",
        ...(Number.isSafeInteger(readBlock) && readBlock > 0 ? { readBlock } : {}),
        retryAfterSeconds: 1,
      }, { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "1", "X-Content-Type-Options": "nosniff" } });
    }
    return handle(() => { throw error; });
  }
}
