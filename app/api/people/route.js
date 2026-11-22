import { officePage } from "../../../lib/chain.mjs";
import { officePageParams, officePageError } from "../../../lib/office-pagination.mjs";
export const dynamic = "force-dynamic";
export async function GET(req) {
  try {
    const options = officePageParams(new URL(req.url).searchParams, "people");
    return Response.json(await officePage("people", options), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return officePageError(error); }
}
