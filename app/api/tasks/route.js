import { dailyTasks, wibDay } from "../../../lib/tasks.mjs";
export async function GET(req) {
  const p = new URL(req.url).searchParams,
    rank = Number(p.get("rank") || 0);
  if (!Number.isInteger(rank) || rank < 0 || rank > 4)
    return Response.json({ error: "rank must be 0-4" }, { status: 400 });
  return Response.json({
    day: wibDay(),
    timezone: "Asia/Jakarta",
    dailyLimit: 1,
    choices: 5,
    tasks: dailyTasks(wibDay(), rank),
  });
}
