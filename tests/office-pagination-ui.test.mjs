// Frontend-only synthetic pagination tests: no network, wallets, or participant fixtures in production.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../app/components/OfficePlayground.js", import.meta.url), "utf8");
const hookSource = source.slice(source.indexOf("function validBlock("), source.indexOf("function useSectionMotion("));
const fixture = Array.from({ length: 1000 }, (_, index) => ({
  employeeNumber: index + 1, address: "0x" + String(index + 1).padStart(40, "0"),
  agentId: "synthetic-" + (index + 1), rank: index % 5, totalCorrect: index,
  id: String(index + 1), employee: "0x" + String(index % 20 + 1).padStart(40, "0"), status: index % 5,
}));
function server(url) {
  const params = new URL(url, "https://test.invalid").searchParams;
  let rows = fixture.toSorted((a, b) => b.totalCorrect - a.totalCorrect);
  if (params.get("rank") && params.get("rank") !== "All") rows = rows.filter((row) => row.rank === Number(params.get("rank")));
  if (params.get("q")) rows = rows.filter((row) => row.agentId.includes(params.get("q")) || row.address.includes(params.get("q")));
  if (params.get("view") === "pending") rows = rows.filter((row) => row.status === 1);
  if (params.get("view") === "mine") rows = rows.filter((row) => row.employee === params.get("address"));
  const offset = Number(params.get("offset")), limit = Number(params.get("limit"));
  return { employees: rows.slice(offset, offset + limit), assignments: rows.slice(offset, offset + limit), total: rows.length, readBlock: "123456" };
}
const response = (data, ok = true) => ({ ok, json: async () => data });
function harness({ endpoint = "/api/people", field = "employees", size = 12, filters = "q=&rank=All", fetcher, timers, signals = AbortSignal } = {}) {
  const slots = [], effects = [], calls = [];
  let index = 0, dirty = false, value, disposed = false;
  let args = [endpoint, field, size, filters, 0];
  const hook = runInNewContext(hookSource + "; useOfficePage", {
    URLSearchParams, AbortController, AbortSignal: signals, setTimeout: timers?.setTimeout || ((callback) => setImmediate(callback)), clearTimeout: timers?.clearTimeout || clearImmediate,
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher ? fetcher(url, options) : response(server(url)); },
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (next) => { assert.equal(disposed, false); slots[slot] = typeof next === "function" ? next(slots[slot]) : next; dirty = true; }];
    },
    useRef(initial) { const slot = index++; return slots[slot] ||= { current: initial }; },
    useEffect(effect, deps) {
      const slot = index++, previous = slots[slot];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        effects.push(() => { previous?.cleanup?.(); slots[slot] = { deps, cleanup: effect() }; });
      }
    },
  });
  function render() { index = 0; dirty = false; value = hook(...args); }
  function flush() {
    let rounds = 0;
    do { if (++rounds > 20) throw Error("Render loop"); render(); while (effects.length) effects.shift()(); } while (dirty);
    return value;
  }
  flush();
  return {
    calls, get value() { return value; }, flush,
    change(filters, revision = args[4]) { args = [endpoint, field, size, filters, revision]; return flush(); },
    async settle() { for (let i = 0; i < 5; i++) { await new Promise(setImmediate); flush(); } return value; },
    dispose() { for (const slot of slots) slot?.cleanup?.(); disposed = true; },
  };
}

test("Office JSX parses and uses summary + bounded lists without full roster or appended history", () => {
  const require = createRequire(import.meta.url);
  assert.doesNotThrow(() => require("next/dist/compiled/babel/parser").parse(source, { sourceType: "module", plugins: ["jsx"] }));
  assert.ok(source.includes('summary: "1"'));
  assert.ok(source.includes('useOfficePage("/api/people", "employees", 12'));
  assert.ok(source.includes('useOfficePage("/api/assignments", "assignments", 10'));
  for (const obsolete of ["office.employees", "office?.employees", "historyPage", "allWork", "loadOlder", "employeeNumber: i + 1"]) assert.ok(!source.includes(obsolete), obsolete);
  assert.ok(source.includes("employeeId={e.employeeNumber}"));
  assert.ok(source.includes("a.agentId || short(a.employee)"));
  assert.ok(source.includes("setListRevision((value) => value + 1)"));
});

test("1000 synthetic People are replaced 12 at a time, with stable IDs and snapshot-pinned next/previous", async () => {
  const h = harness();
  try {
    await h.settle();
    const seen = new Set();
    for (let page = 1; page <= 84; page++) {
      assert.equal(h.value.page, page);
      assert.equal(h.value.total, 1000);
      assert.equal(h.value.rows.length, page === 84 ? 4 : 12);
      for (const row of h.value.rows) { seen.add(row.employeeNumber); assert.equal(row.agentId, "synthetic-" + row.employeeNumber); }
      if (page < 84) { h.value.onPageChange(page + 1); h.flush(); assert.equal(h.value.rows.length, 0); await h.settle(); }
    }
    assert.equal(seen.size, 1000);
    assert.equal(h.calls.length, 84);
    assert.equal(new URL(h.calls[0].url, "https://test.invalid").searchParams.has("block"), false);
    for (const call of h.calls.slice(1)) assert.equal(new URL(call.url, "https://test.invalid").searchParams.get("block"), "123456");
    h.value.onPageChange(83); h.flush(); await h.settle();
    assert.equal(h.value.rows.length, 12);
    assert.equal(h.value.rows[0].employeeNumber, 16);
  } finally { h.dispose(); }
});

test("search and rank changes reset page and block, including switching back to an earlier filter", async () => {
  const h = harness();
  try {
    await h.settle(); h.value.onPageChange(4); h.flush(); await h.settle();
    h.change("q=synthetic-9&rank=4");
    assert.equal(h.value.page, 1); assert.equal(h.value.rows.length, 0);
    await h.settle();
    assert.ok(h.value.rows.every((row) => row.rank === 4 && row.agentId.includes("synthetic-9")));
    assert.equal(new URL(h.calls.at(-1).url, "https://test.invalid").searchParams.has("block"), false);
    h.change("q=&rank=All"); await h.settle();
    assert.equal(h.value.page, 1);
    assert.equal(new URL(h.calls.at(-1).url, "https://test.invalid").searchParams.has("block"), false);
  } finally { h.dispose(); }
});

test("Review uses 10 replaceable rows and filters pending/mine before paging", async () => {
  const mine = fixture[0].employee;
  const h = harness({ endpoint: "/api/assignments", field: "assignments", size: 10, filters: "view=all" });
  try {
    await h.settle(); assert.equal(h.value.rows.length, 10); assert.equal(h.value.total, 1000);
    h.change("view=pending"); await h.settle(); assert.equal(h.value.total, 200); assert.ok(h.value.rows.every((row) => row.status === 1));
    h.value.onPageChange(2); h.flush(); await h.settle(); assert.equal(h.value.rows.length, 10);
    h.change(new URLSearchParams({ view: "mine", address: mine }).toString()); await h.settle();
    assert.equal(h.value.page, 1); assert.equal(h.value.total, 50); assert.ok(h.value.rows.every((row) => row.employee === mine));
    h.change("view=all", 1); await h.settle(); assert.equal(h.value.page, 1);
    assert.equal(new URL(h.calls.at(-1).url, "https://test.invalid").searchParams.has("block"), false);
  } finally { h.dispose(); }
});

test("aborted old fetch cannot overwrite a newer filter even when transport ignores abort", async () => {
  let resolveOld;
  const h = harness({ fetcher: (url) => url.includes("q=old") ? new Promise((resolve) => { resolveOld = resolve; }) : response(server(url)), filters: "q=old&rank=All" });
  try {
    await h.settle(); h.change("q=synthetic-1&rank=All"); await h.settle();
    const latest = h.value.rows[0].employeeNumber;
    assert.equal(h.calls[0].options.signal.aborted, true);
    resolveOld(response({ ...server("/api/people?offset=0&limit=12"), readBlock: "999" })); await h.settle();
    assert.equal(h.value.rows[0].employeeNumber, latest);
    h.value.onPageChange(2); h.flush(); await h.settle();
    assert.equal(new URL(h.calls.at(-1).url, "https://test.invalid").searchParams.get("block"), "123456");
  } finally { h.dispose(); }
});

test("expired snapshot never shows stale rows as a new page; reload starts fresh at page1", async () => {
  let expired = false;
  const h = harness({ fetcher: (url) => expired ? response({ code: "SNAPSHOT_EXPIRED", error: "Snapshot expired" }, false) : response(server(url)) });
  try {
    await h.settle(); expired = true;
    h.value.onPageChange(2); h.flush(); assert.equal(h.value.rows.length, 0); await h.settle();
    assert.equal(h.value.error, "Snapshot expired"); assert.equal(h.value.rows.length, 0);
    h.value.onPageChange(3); h.flush(); assert.equal(h.value.page, 2);
    expired = false; h.value.reload(); h.flush(); await h.settle();
    assert.equal(h.value.page, 1); assert.equal(h.value.error, "");
    assert.equal(new URL(h.calls.at(-1).url, "https://test.invalid").searchParams.has("block"), false);
  } finally { h.dispose(); }
});

test("shrinking totals recover to the last valid page and empty results remain page1", async () => {
  let total = 1000;
  const h = harness({ fetcher: (url) => response({ ...server(url), total }) });
  try {
    await h.settle(); total = 13; h.value.onPageChange(80); h.flush(); await h.settle();
    assert.equal(h.value.page, 2);
    total = 0; h.change("q=not-found&rank=All"); await h.settle();
    assert.equal(h.value.page, 1); assert.equal(h.value.total, 0); assert.equal(h.value.rows.length, 0);
  } finally { h.dispose(); }
});

test("cold index retries are bounded20 and aborting during retry cancels further work", async () => {
  let indexed = 0;
  const timers = { setTimeout(callback) { return setImmediate(callback); }, clearTimeout: clearImmediate };
  const h = harness({ timers, fetcher: () => response({ code: "INDEX_BUILDING", error: "Index warming", indexed: ++indexed, total: 1000, readBlock: "123456" }, false) });
  try {
    for (let i = 0; i < 30; i++) await h.settle();
    assert.equal(h.calls.length, 20); assert.match(h.value.error, /Reload to continue/); assert.equal(h.value.rows.length, 0);
    for (const call of h.calls.slice(1)) assert.equal(new URL(call.url, "https://test.invalid").searchParams.get("block"), "123456");
    h.value.reload(); h.flush(); h.change("q=new&rank=All");
    assert.equal(h.calls.at(-1).options.signal.aborted, true);
    await h.settle();
  } finally { h.dispose(); }
});

test("stalled cold-index progress stops and respects Retry-After without claiming an empty result", async () => {
  const delays = [];
  const timers = { setTimeout(callback, delay) { delays.push(delay); return setImmediate(callback); }, clearTimeout: clearImmediate };
  const h = harness({ timers, fetcher: () => ({ ...response({ code: "INDEX_BUILDING", indexed: 25, total: 1000, readBlock: "123456" }, false), headers: { get: () => "2" } }) });
  try {
    for (let i = 0; i < 10; i++) await h.settle();
    assert.equal(h.calls.length, 4);
    assert.ok(delays.filter((delay) => delay !== 300).every((delay) => delay === 2000));
    assert.ok(h.value.error.includes("25/1000"));
    assert.match(h.value.error, /Reload to continue/);
    assert.equal(h.value.total, null);
    assert.equal(h.value.rows.length, 0);
  } finally { h.dispose(); }
});

test("cold-index Continue preserves pinned snapshot while true Refresh drops it", async () => {
  let indexed = 0;
  const h = harness({ fetcher: () => response({ code: "INDEX_BUILDING", indexed: ++indexed, total: 1000, readBlock: "123456" }, false) });
  try {
    for (let i = 0; i < 30; i++) await h.settle();
    assert.equal(h.value.errorCode, "INDEX_BUILDING");
    h.value.retry(); h.flush(); await h.settle();
    assert.equal(new URL(h.calls[20].url, "https://test.invalid").searchParams.get("block"), "123456");
    const count = h.calls.length;
    h.value.reload(); h.flush(); await h.settle();
    assert.equal(new URL(h.calls[count].url, "https://test.invalid").searchParams.has("block"), false);
  } finally { h.dispose(); }
});

test("invalid row bounds, totals, blocks and snapshot mismatches are rejected without stale content", async () => {
  for (const patch of [
    { employees: {} }, { employees: fixture.slice(0, 13) }, { total: -1 }, { total: null },
    { total: Number.MAX_SAFE_INTEGER + 1 }, { readBlock: null }, { readBlock: "0" }, { readBlock: true }, { readBlock: "1.2" },
  ]) {
    const h = harness({ fetcher: (url) => response({ ...server(url), ...patch }) });
    try { await h.settle(); assert.ok(h.value.error, JSON.stringify(patch)); assert.equal(h.value.rows.length, 0); }
    finally { h.dispose(); }
  }
  let changed = false;
  const h = harness({ fetcher: (url) => response({ ...server(url), ...(changed ? { readBlock: "654321" } : {}) }) });
  try {
    await h.settle(); changed = true; h.value.onPageChange(2); h.flush(); await h.settle();
    assert.ok(h.value.error.includes("invalid chain snapshot")); assert.equal(h.value.rows.length, 0);
  } finally { h.dispose(); }
});

test("People search debounces300ms and cancels earlier queries before issuing requests", async () => {
  const timers = [], callbacks = new Map(); let next = 0;
  const h = harness({ timers: { setTimeout(callback, delay) { timers.push(delay); callbacks.set(++next, callback); return next; }, clearTimeout(id) { callbacks.delete(id); } } });
  try {
    h.change("q=s&rank=All"); h.change("q=sy&rank=All"); h.change("q=synthetic-9&rank=All");
    assert.equal(h.calls.length, 0); assert.equal(callbacks.size, 1); assert.ok(timers.every((delay) => delay === 300));
    [...callbacks.values()][0](); await h.settle();
    assert.equal(h.calls.length, 1); assert.equal(new URL(h.calls[0].url, "https://test.invalid").searchParams.get("q"), "synthetic-9");
  } finally { h.dispose(); }
});

test("next/previous scroll to section start and respect reduced motion without changing other animations", () => {
  const helper = source.slice(source.indexOf("function changeOfficePage("), source.indexOf("function validBlock("));
  for (const reduce of [false, true]) {
    const events = [];
    const change = runInNewContext(helper + "; changeOfficePage", {
      document: { getElementById(id) { return { scrollIntoView(options) { events.push({ id, ...options }); } }; } },
      window: { matchMedia(query) { assert.equal(query, "(prefers-reduced-motion: reduce)"); return { matches: reduce }; } },
    });
    const list = { page: 2, loading: false, error: "", onPageChange: (page) => events.push({ page }) };
    change(list, 3, "people");
    assert.equal(events[0].page, 3);
    assert.equal(events[1].id, "people"); assert.equal(events[1].block, "start");
    assert.equal(events[1].behavior, reduce ? "instant" : "smooth");
    change({ ...list, loading: true }, 3, "people");
    change({ ...list, error: "Unavailable" }, 3, "people");
    change(list, 2, "people");
    assert.equal(events.length, 2);
    change(list, 1, "review"); assert.equal(events[3].id, "review");
  }
  assert.ok(source.includes('changeOfficePage(people, page, "people")'));
  assert.ok(source.includes('changeOfficePage(review, page, "review")'));
});

test("older mobile without AbortSignal.any/timeout retains cancellation-only fetch fallback", async () => {
  const h = harness({ signals: {} });
  try {
    await h.settle(); assert.equal(h.value.rows.length, 12);
    const signal = h.calls[0].options.signal;
    h.value.onPageChange(2); h.flush(); await h.settle();
    assert.equal(signal.aborted, true); assert.equal(h.value.page, 2); assert.equal(h.value.rows.length, 12);
  } finally { h.dispose(); }
});
