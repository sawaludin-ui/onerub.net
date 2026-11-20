import { officeState } from "../../../lib/chain.mjs";
export const dynamic = "force-dynamic";
export async function GET(req) {
  try {
    return Response.json(
      await officeState(new URL(req.url).searchParams.get("address")),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("Office read failed:", e.shortMessage || e.message);
    return Response.json(
      {
        error: "Live chain data is temporarily unavailable. Please retry.",
        unavailable: true,
      },
      { status: 503 },
    );
  }
}
