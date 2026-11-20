import { officeInterface, deployment } from "../../../lib/chain.mjs";
import {
  actionArguments,
  readJsonObject,
  RequestError,
} from "../../../lib/request-validation.mjs";

export async function POST(request) {
  if (!deployment.address)
    return Response.json({ error: "Office unavailable." }, { status: 503 });
  try {
    const body = await readJsonObject(request);
    const args = actionArguments(body);
    const data = officeInterface.encodeFunctionData(body.action, args);
    return Response.json(
      {
        chainId: deployment.chainId,
        binanceChainId: String(deployment.chainId),
        from: body.address,
        to: deployment.address,
        value: "0",
        data,
        action: body.action,
        args,
        notice:
          "Unsigned transaction. Preview and confirm with your own wallet.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RequestError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      { error: "Could not prepare the transaction." },
      { status: 500 },
    );
  }
}
