import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TASK_PAGE_SIZE, firstTaskPage, taskPageTarget, acceptTaskPage, taskPageTotal, listQuery, requestGate, taskTimeline, scheduleTaskSearch } from "../app/components/marketplace-view.mjs";

test("fast typing commits only the final search after 300ms and aborts stale work immediately", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = requestGate(), stale = gate.next(), requests = [];
  let cancel;
  for (const value of ["r", "ra", "rare"]) {
    gate.cancel();
    cancel?.();
    cancel = scheduleTaskSearch(value, query => requests.push(listQuery({ q: query })));
    t.mock.timers.tick(50);
  }
  assert.equal(stale.signal.aborted, true);
  assert.equal(stale.current(), false);
  assert.equal(requests.length, 0);
  t.mock.timers.tick(249);
  assert.equal(requests.length, 0);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0], "https://example.invalid").searchParams.get("q"), "rare");
  cancel();
});

// Synthetic local data only: no chain, provider, wallet, funding or paid task creation.
const fixture = Array.from({ length: 1000 }, (_, i) => ({ id: String(1000 - i), phase: "Open" }));
function server(target) {
  const offset = target.cursors[target.page - 1];
  const tasks = fixture.slice(offset, offset + TASK_PAGE_SIZE);
  return { tasks, totalTasks: 1000, matchedTasks: 1000, readBlock: 321, nextOffset: offset + tasks.length < 1000 ? offset + tasks.length : null };
}
test("1000 synthetic tasks traverse 84 replacement pages with at most 12 records", () => {
  let target = firstTaskPage(), visible = [], pages = 0, seen = new Set();
  while (target) {
    const url = new URL(listQuery({ offset: target.cursors[target.page - 1], block: target.block }), "https://example.invalid");
    assert.equal(url.searchParams.get("limit"), "12");
    if (pages) assert.equal(url.searchParams.get("block"), "321");
    const data = server(target);
    target = acceptTaskPage(data, target);
    visible = data.tasks;
    assert.ok(visible.length <= 12);
    if (pages < 83) assert.equal(visible.length, 12);
    for (const row of visible) { assert.equal(seen.has(row.id), false); seen.add(row.id); }
    pages++;
    target = taskPageTarget(target, target.page + 1);
  }
  assert.equal(pages, 84); assert.equal(seen.size, 1000); assert.equal(visible.length, 4);
  assert.equal(visible.every(row => row.phase === "Open"), true);
  assert.equal(Object.fromEntries(taskTimeline(visible[0])).Payment, "Not settled");
});
test("opaque scan cursors, empty pages and previous retain the accepted snapshot", () => {
  const first = acceptTaskPage({tasks:fixture.slice(0,12),readBlock:77,nextOffset:95},firstTaskPage());
  const next = taskPageTarget(first,2);
  assert.deepEqual(next.cursors,[0,95]);
  const empty = acceptTaskPage({tasks:[],readBlock:77,nextOffset:190},next);
  const third = taskPageTarget(empty,3);
  assert.equal(third.cursors[2],190); assert.equal(third.block,77);
  const previous = taskPageTarget(empty,1);
  assert.equal(previous.cursors[previous.page-1],0); assert.equal(previous.block,77);
  assert.equal(taskPageTarget(first,3),null);
  assert.equal(taskPageTarget(first,0),null);
});
test("filters and refresh start page one without a block; totals never mislabel escrow count", () => {
  const reset = firstTaskPage();
  const url = new URL(listQuery({q:"rare",phase:"Paid",block:reset.block}),"https://example.invalid");
  assert.equal(url.searchParams.has("block"),false);
  assert.equal(url.searchParams.get("phase"),"Settled");
  assert.equal(taskPageTotal({totalTasks:1000},{q:"rare"}),null);
  assert.equal(taskPageTotal({totalTasks:1000},{phase:"Paid"}),null);
  assert.equal(taskPageTotal({totalTasks:1000,matchedTasks:9},{phase:"Paid"}),9);
  assert.equal(taskPageTotal({totalTasks:1000}),1000);
});
test("page validation rejects overfull payloads, changed snapshots and nonadvancing cursors", () => {
  assert.throws(()=>acceptTaskPage({tasks:fixture.slice(0,13),readBlock:1},firstTaskPage()),/Invalid task page/);
  assert.throws(()=>acceptTaskPage({tasks:[],readBlock:2},{...firstTaskPage(),block:1}),/snapshot changed/);
  assert.throws(()=>acceptTaskPage({tasks:[],readBlock:1,nextOffset:0},firstTaskPage()),/cursor/);
});
test("aborted page failure cannot overwrite a newer filtered result; retry keeps cursor", async () => {
  const gate=requestGate(); let visible=null, error="";
  const stale=gate.next();
  gate.cancel();
  const fresh=gate.next();
  await Promise.resolve();
  if(fresh.current()) visible={tasks:[],readBlock:5};
  if(stale.current()) { visible={tasks:fixture}; error="stale failure"; }
  assert.equal(stale.signal.aborted,true); assert.equal(error,""); assert.deepEqual(visible.tasks,[]);
  const first=acceptTaskPage(server(firstTaskPage()),firstTaskPage());
  const retry=taskPageTarget(first,2);
  const again=acceptTaskPage(server(retry),retry);
  assert.equal(again.page,2); assert.equal(again.cursors[1],12); assert.equal(again.block,321);
});
test("UI wires replacement, retry and shared pagination while preserving handoff", async () => {
  const source=await readFile(new URL("../app/components/MarketplacePage.js",import.meta.url),"utf8");
  assert.ok(source.includes("setMarket(data)"));
  assert.doesNotMatch(source,/previous.tasks|loadMore|Load more tasks/);
  assert.ok(source.includes("readTaskPage(retryPage.current)"));
  assert.match(source,/PaginationControls label="Tasks"/);
  assert.ok(source.includes("listGate.current.cancel()"));
  assert.match(source,/agentInstructions/);
  assert.ok(source.includes("retryPage.current = { ...target, block: e.readBlock }"));
  assert.ok(source.includes("INDEX_BUILDING"));
  assert.ok(source.includes("phaseOf(task)"));
});
