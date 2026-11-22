import { officeState } from "../../../lib/chain.mjs";
import { walletAddress } from "../../../lib/request-validation.mjs";
export const dynamic = "force-dynamic";
export async function GET(req) {
  const address = new URL(req.url).searchParams.get("address");
  if (address !== null && !walletAddress(address))
    return Response.json({ error: "Invalid wallet address." }, { status: 400 });
  try {
    return Response.json(await officeState(address, { summary: new URL(req.url).searchParams.get("summary") === "1" }), {
      headers: {
        "Cache-Control": address
          ? "private, no-store"
          : "public, max-age=0, s-maxage=5, must-revalidate",
      },
    });
  } catch (e) {
    console.error(
      "Office read failed",
      /^[A-Z_]{1,32}$/.test(e?.code) ? e.code : "RPC_UNAVAILABLE",
    );
    return Response.json(
      {
        error: "Live chain data is temporarily unavailable. Please retry.",
        unavailable: true,
      },
      { status: 503 },
    );
  }
}
