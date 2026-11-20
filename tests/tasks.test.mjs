import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { dailyTasks, makeTask, wibDay } from "../lib/tasks.mjs";
test("task bank contains 5000 unique complete tasks, 1000 per difficulty", () => {
  const bank = JSON.parse(fs.readFileSync("data/task-bank.json"));
  assert.equal(bank.length, 5000);
  assert.equal(
    new Set(
      bank.map((t) =>
        createHash("sha256").update(JSON.stringify(t.data)).digest("hex"),
      ),
    ).size,
    5000,
  );
  for (let r = 0; r < 5; r++)
    assert.equal(bank.filter((t) => t.rank === r).length, 1000);
  for (const t of bank) {
    assert.ok(t.brief.length > 50);
    assert.ok(t.outputFormat);
    assert.equal(t.expectedAnswer, undefined);
  }
});
test("each rank gets exactly five deterministic daily choices and no answer leaks", () => {
  for (let rank = 0; rank < 5; rank++) {
    const a = dailyTasks(20777, rank),
      b = dailyTasks(20777, rank);
    assert.equal(a.length, 5);
    assert.deepEqual(a, b);
    assert.ok(a.every((t) => !("expectedAnswer" in t)));
    assert.notDeepEqual(a, dailyTasks(20778, rank));
  }
});
test("WIB clock turns at 17:00 UTC", () => {
  assert.equal(
    wibDay(Date.parse("2026-11-20T16:59:59Z")) + 1,
    wibDay(Date.parse("2026-11-20T17:00:00Z")),
  );
});
test("expected results satisfy core invariants across every rank and family", () => {
  for (let rank = 0; rank < 5; rank++)
    for (let slot = 0; slot < 5; slot++)
      for (const v of [0, 19, 99, 199]) {
        const t = makeTask(rank, slot, v, null, true),
          a = t.expectedAnswer;
        assert.ok(JSON.stringify(a).length < 2200);
        if (slot === 0)
          assert.equal(
            a.totalMinutes,
            Object.values(a.byDepartment).reduce((s, n) => s + n, 0),
          );
        if (slot === 1) {
          assert.equal(a.path[0], t.data.start);
          assert.equal(a.path.at(-1), t.data.destination);
          let cost = 0;
          for (let i = 0; i < a.path.length - 1; i++)
            cost += t.data.edges.find(
              (e) => e.from === a.path[i] && e.to === a.path[i + 1],
            ).cost;
          assert.equal(cost, a.cost);
        }
        if (slot === 2) {
          assert.ok(a.cost <= t.data.budget);
          assert.equal(
            a.value,
            t.data.jobs
              .filter((j) => a.ids.includes(j.id))
              .reduce((s, j) => s + j.value, 0),
          );
        }
        if (slot === 3)
          assert.equal(a.decisions.length, t.data.requests.length);
        if (slot === 4)
          assert.equal(a.uniqueEvents + a.ignoredRetries, t.data.events.length);
      }
});
