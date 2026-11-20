import { dailyTasks, wibDay } from "../../../lib/tasks.mjs";
import { integerParam } from "../../../lib/request-validation.mjs";
export async function GET(req) {
  const p = new URL(req.url).searchParams,
    rank = integerParam(p, "rank", 0, 0, 4);
  if (rank === null)
    return Response.json({ error: "rank must be 0-4" }, { status: 400 });
  const now = Date.now();
  const day = wibDay(now);
  const secondsUntilMidnight = Math.floor(
    ((day + 1) * 86400000 - 25200000 - now) / 1000,
  );
  return Response.json(
    {
      day,
      timezone: "Asia/Jakarta",
      dailyLimit: 1,
      choices: 5,
      tasks: dailyTasks(day, rank),
    },
    {
      headers: {
        "Cache-Control": `public, max-age=0, s-maxage=${Math.min(300, secondsUntilMidnight)}, must-revalidate`,
      },
    },
  );
}
