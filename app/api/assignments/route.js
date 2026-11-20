import { readChain, assignmentView } from "../../../lib/chain.mjs";
import { integerParam } from "../../../lib/request-validation.mjs";
export const dynamic = "force-dynamic";
export async function GET(req) {
  const p = new URL(req.url).searchParams,
    offset = integerParam(p, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    limit = integerParam(p, "limit", 30, 1, 50);
  if (offset === null || limit === null)
    return Response.json(
      { error: "offset must be nonnegative and limit 1-50" },
      { status: 400 },
    );
  try {
    return Response.json(
      await readChain(async (c, provider) => {
        const call = { blockTag: await provider.getBlockNumber() };
        const [total, page] = await Promise.all([
          c.assignmentCount(call),
          c.getRecentAssignments(offset, limit, call),
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
