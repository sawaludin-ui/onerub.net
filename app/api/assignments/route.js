import { readChain, assignmentView } from "../../../lib/chain.mjs";
export const dynamic = "force-dynamic";
export async function GET(req) {
  const p = new URL(req.url).searchParams,
    offset = Number(p.get("offset") || 0),
    limit = Number(p.get("limit") || 30);
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    return Response.json(
      { error: "offset must be nonnegative and limit 1-50" },
      { status: 400 },
    );
  try {
    return Response.json(
      await readChain(async (c) => {
        const [total, page] = await Promise.all([
          c.assignmentCount(),
          c.getRecentAssignments(offset, limit),
        ]);
        return {
          assignments: page[0].map((id, i) => assignmentView(id, page[1][i])),
          total: Number(total),
          nextOffset:
            offset + page[0].length < Number(total)
              ? offset + page[0].length
              : null,
        };
      }),
    );
  } catch {
    return Response.json({ error: "Chain unavailable" }, { status: 503 });
  }
}
