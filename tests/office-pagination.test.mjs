// Synthetic fixtures only: no paid/live data, provider requests, or chain broadcasts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOfficePagination, officePageParams, officePageError, OfficePaginationError } from "../lib/office-pagination.mjs";
import { officePageSource } from "../lib/chain.mjs";
const address = n => "0x" + n.toString(16).padStart(40, "0");
const id = n => "0x" + n.toString(16).padStart(64, "0");
const params = (kind, query = "") => officePageParams(new URLSearchParams(query), kind);
function fixture(size = 1000) {
  const calls = { roster: 0, employee: 0, identity: 0, recent: 0, details: 0, blocks: [], maxRoster: 0, maxRecent: 0 };
  let head = 12345;
  const pin = call => { assert.equal(call.blockTag, 12345); calls.blocks.push(call.blockTag); };
  const records = Array.from({ length: size }, (_, i) => ({ joined: true, rank: i % 5, stageCorrect: 0, totalCorrect: i % 101, internStreak: 0, joinedAt: i }));
  const works = Array.from({ length: size }, (_, i) => ({ employee: address(i % 100 + 1), status: i % 4, rank: 0, day: 1, slot: 0, takenAt: 1, submittedAt: 1, reviewedAt: 0, tokenId: 0n, evidence: "synthetic evidence " + i, feedback: "" }));
  const c = {
    async employeeCount(call) { pin(call); return size; },
    async assignmentCount(call) { pin(call); return size; },
    async getEmployeeAddresses(start, limit, call) { pin(call); calls.roster++; calls.maxRoster = Math.max(calls.maxRoster, limit); return records.slice(start, start + limit).map((_, i) => address(start + i + 1)); },
    async employees(a, call) { pin(call); calls.employee++; return records[parseInt(a, 16) - 1]; },
    async getRecentAssignments(start, limit, call) { pin(call); calls.recent++; calls.maxRecent = Math.max(calls.maxRecent, limit); const rows = works.slice(start, start + limit); return [rows.map((_, i) => id(start + i + 1)), rows]; },
    async getAssignment(a, call) { pin(call); calls.details++; return works[parseInt(a, 16) - 1]; },
  };
  const identity = { async handleOf(a, call) { pin(call); calls.identity++; return "agent-" + parseInt(a, 16); } };
  return { calls, records, works, source: officePageSource(c, { getBlockNumber: async () => head }, identity), head: value => { head = value; } };
}
async function ready(index, kind, options, source) {
  for (let i = 0; i < 100; i++) {
    try { return await index.page(kind, options, source); }
    catch (error) {
      if (error.code !== "INDEX_BUILDING") throw error;
      assert.equal(error.status, 503);
      if (error.readBlock) options = { ...options, block: error.readBlock };
    }
  }
  throw Error("Fixture index did not complete within bounded attempts");
}
function sharedStore(now = Date.now) {
  const map = new Map();
  return { map,
    async get(key) { const item = map.get(key); return item && item.expires > now() ? structuredClone(item.value) : null; },
    async put(key, value, { ttl = 300, nx = false, lockKey, owner } = {}) {
      if (nx && await this.get(key) !== null) return false;
      if (lockKey && await this.get(lockKey) !== owner) return false;
      map.set(key, { value: structuredClone(value), expires: now() + ttl * 1000 }); return true;
    },
    async release(key, owner) { if (await this.get(key) === owner) map.delete(key); },
  };
}

test("1000 People: globally accepted-work sorted, stable employee numbers, 12 rows, no per-page chain scan", async () => {
  const f = fixture(), index = createOfficePagination();
  const first = await ready(index, "people", params("people"), f.source);
  assert.equal(first.total, 1000); assert.equal(first.employees.length, 12); assert.equal(first.nextOffset, 12);
  assert.equal(f.calls.employee, 1000); assert.equal(f.calls.identity, 1000); assert.equal(f.calls.roster, 40); assert.equal(f.calls.maxRoster, 25);
  const expected = f.records.map((e, i) => ({ ...e, employeeNumber: i + 1 })).toSorted((a, b) => b.totalCorrect - a.totalCorrect || a.employeeNumber - b.employeeNumber);
  assert.deepEqual(first.employees.map(e => e.employeeNumber), expected.slice(0, 12).map(e => e.employeeNumber));
  const seen = new Set(first.employees.map(e => e.address));
  for (let offset = 12; offset < 1000; offset += 12) {
    const page = await index.page("people", params("people", "offset=" + offset + "&block=" + first.readBlock), f.source);
    assert.ok(page.employees.length <= 12); page.employees.forEach(e => seen.add(e.address));
    assert.deepEqual(page.employees.map(e => e.employeeNumber), expected.slice(offset, offset + 12).map(e => e.employeeNumber));
    if (offset === 996) assert.equal(page.nextOffset, null);
  }
  assert.equal(seen.size, 1000); assert.equal(f.calls.employee, 1000); assert.equal(f.calls.roster, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 6000);
});
test("People name/wallet/rank filters apply globally before paging", async () => {
  const f = fixture(), index = createOfficePagination();
  const first = await ready(index, "people", params("people"), f.source);
  const page = await index.page("people", params("people", "q=agent-999.ai&rank=3&block=" + first.readBlock), f.source);
  assert.equal(page.total, 1); assert.equal(page.employees[0].employeeNumber, 999);
  const none = await index.page("people", params("people", "q=no-match&block=" + first.readBlock), f.source);
  assert.equal(none.total, 0); assert.equal(none.nextOffset, null); assert.deepEqual(none.employees, []);
  const beyond = await index.page("people", params("people", "offset=9007199254740991&block=" + first.readBlock), f.source);
  assert.deepEqual(beyond.employees, []); assert.equal(beyond.nextOffset, null);
  assert.equal(f.calls.identity, 1000);
});
test("1000 Review: status/mine filtering before 10-row pages; evidence/names resolved page-only", async () => {
  const f = fixture(), index = createOfficePagination();
  const page = await ready(index, "assignments", params("assignments", "view=pending"), f.source);
  assert.equal(page.total, 250); assert.equal(page.pendingTotal, 250); assert.equal(page.assignments.length, 10);
  assert.equal(f.calls.recent, 20); assert.equal(f.calls.maxRecent, 50); assert.equal(f.calls.details, 10); assert.equal(f.calls.identity, 10);
  assert.ok(page.assignments.every(a => a.status === 1 && a.agentId && Number.isInteger(a.employeeRank)));
  const mine = await index.page("assignments", params("assignments", "view=mine&address=" + address(100) + "&block=" + page.readBlock), f.source);
  assert.equal(mine.total, 10); assert.ok(mine.assignments.every(a => a.employee === address(100))); assert.equal(f.calls.recent, 20);
  const second = await index.page("assignments", params("assignments", "view=pending&offset=10&block=" + page.readBlock), f.source);
  assert.equal(second.nextOffset, 20); assert.notEqual(second.assignments[0].id, page.assignments[0].id); assert.equal(f.calls.recent, 20);
});
test("Redis-like persisted checkpoints resume across 40 cold instances and completed cold reads do not rescan", async () => {
  const f = fixture(), storage = sharedStore(); let first;
  for (let i = 0; i < 40; i++) {
    const index = createOfficePagination({ storage, namespace: "cold" });
    try { first = await index.page("people", params("people"), f.source); }
    catch (error) { assert.equal(error.code, "INDEX_BUILDING"); assert.equal(error.indexed, (i + 1) * 25); }
  }
  assert.equal(first.total, 1000); assert.equal(f.calls.roster, 40);
  const cold = createOfficePagination({ storage, namespace: "cold" });
  const second = await cold.page("people", params("people", "offset=12&block=" + first.readBlock), f.source);
  assert.equal(second.employees.length, 12); assert.equal(f.calls.roster, 40);
  assert.ok(storage.map.size <= 4);
});
test("Invalid/future/expired snapshots fail explicitly and never scan arbitrary blocks", async () => {
  const f = fixture(); let clock = 1000; const index = createOfficePagination({ now: () => clock });
  const first = await ready(index, "people", params("people"), f.source);
  await assert.rejects(index.page("people", params("people", "block=999999"), f.source), e => e.status === 400);
  await assert.rejects(index.page("people", params("people", "block=100"), f.source), e => e.code === "SNAPSHOT_EXPIRED");
  clock += 300001;
  await assert.rejects(index.page("people", params("people", "block=" + first.readBlock), f.source), e => e.status === 409);
  assert.equal(f.calls.roster, 40);
  for (const query of ["limit=13", "offset=-1", "offset=9007199254740992", "block=0", "block=1e9", "rank=5", "q=" + "x".repeat(129)])
    assert.throws(() => params("people", query), OfficePaginationError);
  for (const query of ["limit=51", "view=review", "view=mine", "address=not-a-wallet"])
    assert.throws(() => params("assignments", query), OfficePaginationError);
  assert.equal(params("assignments").limit, 10); assert.equal(params("assignments", "limit=30").limit, 30);
});
test("Capacity, failure cleanup, owned lease and bounded index-building responses", async () => {
  const f = fixture(0), storage = sharedStore(), index = createOfficePagination({ storage });
  f.source.count = async () => 20001;
  await assert.rejects(index.page("people", params("people"), f.source), e => e.code === "INDEX_CAPACITY");
  assert.equal([...storage.map.keys()].filter(k => k.endsWith(":lock")).length, 0);
  const f2 = fixture(); let expireLease = false;
  const oldPut = storage.put;
  storage.put = async function(k, v, options) { if (expireLease && options?.lockKey) return false; return oldPut.call(this, k, v, options); };
  expireLease = true;
  await assert.rejects(index.page("people", params("people"), f2.source), e => e.code === "INDEX_BUILDING");
  assert.equal([...storage.map.keys()].filter(k => k.endsWith(":build")).length, 0);
  const response = officePageError(new OfficePaginationError("building", 503, "INDEX_BUILDING", { indexed: 25, total: 1000, readBlock: 12345 }));
  assert.equal(response.status, 503); assert.equal(response.headers.get("Retry-After"), "1"); assert.equal((await response.json()).readBlock, 12345);
});
test("Summary path skips roster/history; default remains legacy; dynamic routes use strict page validation", async () => {
  const chain = await readFile(new URL("../lib/chain.mjs", import.meta.url), "utf8");
  assert.ok(chain.includes("officeState(address, { summary = false }"));
  assert.ok(chain.includes("summary ? null : c.getRecentAssignments(0, 30, call)"));
  assert.ok(chain.includes("summary ? null : await rosterFor"));
  assert.ok(chain.includes("...(!summary ? { employees, assignments:"));
  for (const kind of ["people", "assignments"]) {
    const route = await readFile(new URL("../app/api/" + kind + "/route.js", import.meta.url), "utf8");
    assert.ok(route.includes('dynamic = "force-dynamic"')); assert.ok(route.includes("officePageParams"));
  }
});
