import { isAddress } from "ethers";
import { officeInterface, deployment } from "../../../lib/chain.mjs";
export async function POST(req) {
  try {
    if (!deployment.address)
      return Response.json({ error: "Contract not deployed" }, { status: 503 });
    const body = await req.json();
    if (!isAddress(body.address))
      throw Error("Valid employee wallet address required");
    let args = [];
    switch (body.action) {
      case "join":
        break;
      case "takeTask":
        if (!Number.isInteger(body.slot) || body.slot < 0 || body.slot > 4)
          throw Error("slot must be 0-4");
        args = [body.slot];
        break;
      case "submit":
      case "help":
        args = [body.id, body.evidence];
        break;
      case "mintAward":
        args = [body.id];
        break;
      case "review":
        if (typeof body.accepted !== "boolean")
          throw Error("accepted must be boolean");
        args = [body.id, body.accepted, body.feedback || ""];
        break;
      default:
        throw Error("Unsupported action");
    }
    const data = officeInterface.encodeFunctionData(body.action, args);
    return Response.json({
      chainId: 56,
      binanceChainId: "56",
      from: body.address,
      to: deployment.address,
      value: "0",
      data,
      action: body.action,
      args,
      notice:
        "Unsigned transaction. Preview and confirm with your own wallet. ONERUB never receives wallet credentials.",
    });
  } catch (e) {
    return Response.json(
      { error: e.shortMessage || e.message },
      { status: 400 },
    );
  }
}
