import { createHash } from "node:crypto";
export const RANKS = ["New hire", "Intern", "Staff", "Senior", "Manager"];
export const FAMILIES = [
  {
    name: "Clean the inbox",
    category: "Data operations",
    summary: "Turn a noisy office inbox into a clean, structured report.",
  },
  {
    name: "Connect the departments",
    category: "Graph reasoning",
    summary: "Find the fastest valid route through the office network.",
  },
  {
    name: "Balance the workload",
    category: "Planning",
    summary: "Allocate a limited work budget to the highest-value jobs.",
  },
  {
    name: "Read between the lines",
    category: "Rule engine",
    summary: "Apply the office policy to a batch of incoming requests.",
  },
  {
    name: "Reconcile the ledger",
    category: "Verification",
    summary:
      "Trace events and rebuild the final state without double-counting.",
  },
];
function rng(seed) {
  let x = Number.parseInt(
    createHash("sha256").update(seed).digest("hex").slice(0, 8),
    16,
  );
  return () => {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}
function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
export function wibDay(now = Date.now()) {
  return Math.floor((now + 7 * 3600000) / 86400000);
}
export function dateForDay(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}
export function taskVariant(day, slot) {
  return (((day * 31 + slot * 17) % 200) + 200) % 200;
}
export function makeTask(rank, slot, variant, day = null, withAnswer = false) {
  if (
    !Number.isInteger(rank) ||
    rank < 0 ||
    rank > 4 ||
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot > 4 ||
    !Number.isInteger(variant) ||
    variant < 0 ||
    variant >= 200
  )
    throw Error("Invalid task coordinates");
  const random = rng(`${rank}:${slot}:${variant}`),
    int = (a, b) => a + Math.floor(random() * (b - a + 1));
  const n = [6, 10, 16, 24, 32][rank];
  let data, brief, format, answer;
  if (slot === 0) {
    const records = Array.from({ length: n }, (_, i) => ({
      id: `M${i + 1}`,
      department: ["research", "support", "engineering"][int(0, 2)],
      minutes: int(5, 90),
      status: ["open", "closed", "open"][int(0, 2)],
    }));
    const duplicates = Array.from({ length: rank + 1 }, () => ({
      ...records[int(0, n - 1)],
    }));
    data = { records: shuffle([...records, ...duplicates], random) };
    brief =
      "Deduplicate by id (duplicates are identical). Keep open records. Return IDs sorted by numeric suffix, total minutes, and minute totals by department. Include all three departments even when their total is zero.";
    format = {
      ids: ["M1"],
      totalMinutes: 0,
      byDepartment: { research: 0, support: 0, engineering: 0 },
    };
    if (withAnswer) {
      const open = records.filter((r) => r.status === "open");
      answer = {
        ids: open.map((r) => r.id),
        totalMinutes: open.reduce((s, r) => s + r.minutes, 0),
        byDepartment: Object.fromEntries(
          ["research", "support", "engineering"].map((d) => [
            d,
            open
              .filter((r) => r.department === d)
              .reduce((s, r) => s + r.minutes, 0),
          ]),
        ),
      };
    }
  } else if (slot === 1) {
    const count = 5 + rank * 2,
      nodes = Array.from({ length: count }, (_, i) =>
        String.fromCharCode(65 + i),
      );
    const edges = nodes
      .slice(0, -1)
      .map((a, i) => ({ from: a, to: nodes[i + 1], cost: int(2, 20) }));
    for (let i = 0; i < count; i++) {
      const a = int(0, count - 2),
        b = int(a + 1, count - 1);
      if (!edges.some((e) => e.from === nodes[a] && e.to === nodes[b]))
        edges.push({ from: nodes[a], to: nodes[b], cost: int(3, 30) });
    }
    data = { nodes, edges, start: "A", destination: nodes.at(-1) };
    brief =
      'Edges are directed. Find the minimum total cost path from start to destination. If costs tie, choose the lexicographically smallest path when node labels are joined with ">". Return path and cost.';
    format = { path: ["A", "B"], cost: 0 };
    if (withAnswer) {
      const costs = { A: 0 },
        paths = { A: ["A"] };
      for (const a of nodes)
        for (const e of edges.filter((e) => e.from === a)) {
          if (costs[a] === undefined) continue;
          const c = costs[a] + e.cost,
            p = [...paths[a], e.to];
          if (
            costs[e.to] === undefined ||
            c < costs[e.to] ||
            (c === costs[e.to] && p.join(">") < paths[e.to].join(">"))
          ) {
            costs[e.to] = c;
            paths[e.to] = p;
          }
        }
      answer = { path: paths[nodes.at(-1)], cost: costs[nodes.at(-1)] };
    }
  } else if (slot === 2) {
    const jobs = Array.from({ length: 6 + rank * 2 }, (_, i) => ({
      id: `J${String(i + 1).padStart(2, "0")}`,
      cost: int(2, 12),
      value: int(3, 30),
    }));
    const budget = 12 + rank * 8 + int(0, 8);
    data = { jobs, budget };
    brief =
      "Choose each job at most once. Maximize total value without exceeding budget. Break ties by lower total cost, then lexicographically smaller comma-joined sorted job IDs. Return sorted IDs, total cost, and total value.";
    format = { ids: ["J01"], cost: 0, value: 0 };
    if (withAnswer) {
      let best = { ids: [], cost: 0, value: 0 };
      for (let mask = 0; mask < 2 ** jobs.length; mask++) {
        const s = { ids: [], cost: 0, value: 0 };
        for (let j = 0; j < jobs.length; j++)
          if (mask & (1 << j)) {
            s.ids.push(jobs[j].id);
            s.cost += jobs[j].cost;
            s.value += jobs[j].value;
          }
        if (
          s.cost <= budget &&
          (s.value > best.value ||
            (s.value === best.value &&
              (s.cost < best.cost ||
                (s.cost === best.cost &&
                  s.ids.join(",") < best.ids.join(",")))))
        )
          best = s;
      }
      answer = best;
    }
  } else if (slot === 3) {
    const requests = Array.from({ length: n }, (_, i) => ({
      id: `R${i + 1}`,
      verified: random() > 0.25,
      amount: int(1, 150),
      daysWaiting: int(0, 12),
      priority: ["normal", "urgent"][int(0, 1)],
    }));
    const threshold = 40 + rank * 15;
    data = {
      policy: {
        deny: "Unverified requests are denied first.",
        escalate: `Otherwise escalate when amount > ${threshold}.`,
        fastTrack:
          "Otherwise fast-track urgent requests waiting at least 3 days.",
        accept: "Accept all remaining requests.",
      },
      requests,
    };
    brief =
      "Apply policies in the stated order. Return decisions in the original request order, each with id and decision. Allowed decisions: deny, escalate, fast-track, accept.";
    format = { decisions: [{ id: "R1", decision: "accept" }] };
    if (withAnswer) {
      answer = {
        decisions: requests.map((r) => ({
          id: r.id,
          decision: !r.verified
            ? "deny"
            : r.amount > threshold
              ? "escalate"
              : r.priority === "urgent" && r.daysWaiting >= 3
                ? "fast-track"
                : "accept",
        })),
      };
    }
  } else {
    const events = Array.from({ length: n }, (_, i) => ({
      eventId: `E${i + 1}`,
      account: ["desk-a", "desk-b", "desk-c"][int(0, 2)],
      delta: int(-12, 20),
    }));
    const retries = Array.from({ length: rank + 2 }, () => ({
      ...events[int(0, n - 1)],
    }));
    const opening = { "desk-a": 50, "desk-b": 50, "desk-c": 50 };
    data = { opening, events: shuffle([...events, ...retries], random) };
    brief =
      "Each eventId must be applied exactly once; repeated entries are retries with identical content. Reconcile the closing balance for every account. Return balances, uniqueEvents, and ignoredRetries.";
    format = {
      balances: { "desk-a": 0, "desk-b": 0, "desk-c": 0 },
      uniqueEvents: 0,
      ignoredRetries: 0,
    };
    if (withAnswer) {
      answer = {
        balances: Object.fromEntries(
          Object.entries(opening).map(([k, v]) => [
            k,
            v +
              events
                .filter((e) => e.account === k)
                .reduce((s, e) => s + e.delta, 0),
          ]),
        ),
        uniqueEvents: events.length,
        ignoredRetries: retries.length,
      };
    }
  }
  const task = {
    id:
      day === null
        ? `BANK-${rank}-${slot}-${variant}`
        : `WORK-${day}-${rank}-${slot}`,
    day,
    date: day === null ? null : dateForDay(day),
    rank,
    rankName: RANKS[rank],
    slot,
    variant,
    title: FAMILIES[slot].name,
    category: FAMILIES[slot].category,
    summary: FAMILIES[slot].summary,
    difficulty: ["Starter", "Easy", "Intermediate", "Advanced", "Expert"][rank],
    brief,
    data,
    outputFormat: format,
    instructions:
      "Return valid JSON matching outputFormat. Include a concise explanation in a separate explanation field. Submit only public work; all submissions are on-chain. Maximum submission size: 2400 UTF-8 bytes.",
    reviewRubric: [
      "Correct result for every requested field",
      "Exact tie-breaking and deduplication rules followed",
      "Valid JSON and a clear explanation",
    ],
  };
  if (withAnswer) task.expectedAnswer = answer;
  return task;
}
export function dailyTasks(day = wibDay(), rank = 0) {
  return FAMILIES.map((_, slot) =>
    makeTask(rank, slot, taskVariant(day, slot), day),
  );
}
