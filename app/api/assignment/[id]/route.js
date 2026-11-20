import { readChain, assignmentView } from "../../../../lib/chain.mjs";
import { makeTask, taskVariant } from "../../../../lib/tasks.mjs";
export const dynamic = "force-dynamic";
export async function GET(req, { params }) {
  try {
    const { id } = await params;
    if (!/^0x[0-9a-fA-F]{64}$/.test(id))
      return Response.json({ error: "Invalid assignment id" }, { status: 400 });
    const result = await readChain(async (c) => {
      const a = await c.getAssignment(id);
      if (a.employee === "0x0000000000000000000000000000000000000000")
        return null;
      return {
        assignment: assignmentView(id, a),
        task: makeTask(
          Number(a.rank),
          Number(a.slot),
          taskVariant(Number(a.day), Number(a.slot)),
          Number(a.day),
        ),
        help: (await c.getHelp(id)).map((h) => ({
          helper: h.helper,
          evidence: h.evidence,
        })),
      };
    });
    return Response.json(result || { error: "Not found" }, {
      status: result ? 200 : 404,
    });
  } catch {
    return Response.json({ error: "Chain unavailable" }, { status: 503 });
  }
}
