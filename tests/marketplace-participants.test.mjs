// Synthetic, read-only fixtures: no mainnet/provider/model requests, signing, or transactions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getAddress } from "ethers";
import { createParticipantReader, participantQuery } from "../lib/marketplace-participants.mjs";
import { MarketplaceError, deployment } from "../lib/marketplace-core.mjs";

const address = n => getAddress("0x" + n.toString(16).padStart(40, "0"));
const active = { chainId: 56, address: address(999), registry: address(998), blockNumber: 100 };
const SECRET = "PRIVATE_CONTENT_HASH_ARTIFACT_SCORE_PROMPT";
function fixture(size = 14, options = {}) {
  let time = 1000;
  const calls = { chain: 0, task: 0, page: 0, submission: 0, identity: 0, running: 0, max: 0, destroyed: 0 };
  const wallets = Array.from({ length: size }, (_, i) => address(size - i + 10));
  const record = { status: 1n, requester: address(1000), submissionCount: BigInt(size), candidatesHash: SECRET, winner: SECRET };
  const submission = { exists: true, submittedAt: 1700000000n, contentHash: SECRET, artifactPtrHash: SECRET, size: 19n, score: SECRET };
  const pin = tag => assert.equal(tag.blockTag, options.block ?? 197);
  async function counted(fn) {
    calls.running++; calls.max = Math.max(calls.max, calls.running);
    try { if (options.latency) await delay(options.latency); return await fn(); }
    finally { calls.running--; }
  }
  const contract = {
    async getTask(id, tag) { pin(tag); calls.task++; return counted(() => ({ ...record })); },
    async getSubmittersPage(id, offset, limit, tag) {
      pin(tag); calls.page++; assert.equal(offset, 0); assert.equal(limit, 64);
      return counted(() => [...wallets]);
    },
    async getSubmission(id, who, tag) { pin(tag); calls.submission++; assert.ok(wallets.includes(who)); return counted(() => ({ ...submission })); },
  };
  const identity = {
    async handleOf(who, tag) {
      pin(tag); calls.identity++;
      return counted(() => options.handle ? options.handle(who) : "fixture-agent-" + parseInt(who, 16));
    },
  };
  const provider = { getBlockNumber: async () => 200, destroy: () => { calls.destroyed++; } };
  const chain = async (fn, config) => {
    calls.chain++; assert.equal(config.confirmations, 3);
    return fn(contract, provider, config.block ?? options.block ?? 197);
  };
  const reader = createParticipantReader({ active, chain, registry: () => identity, now: () => time, ...options.reader });
  return { reader, calls, wallets, record, submission, contract, identity, provider, chain, tick: ms => { time += ms; } };
}
const code = expected => error => error instanceof MarketplaceError && error.code === expected;

test("14 public participants retain append order, including equal timestamps and reverse lexical wallets", async () => {
  const f = fixture();
  const value = await f.reader("0001");
  assert.equal(value.taskId, "1"); assert.equal(value.total, 14); assert.equal(value.readBlock, 197);
  assert.equal(value.chainId, 56); assert.equal(value.escrowAddress, active.address);
  assert.equal(value.order, "on-chain-submission-append-order");
  assert.equal(value.identityBasis, "registry-at-read-block-not-historical");
  assert.deepEqual(value.participants.map(row => row.wallet), f.wallets);
  assert.deepEqual(value.participants.map(row => row.ordinal), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.ok(value.participants.every(row => row.submittedAt === 1700000000 && row.identityStatus === "resolved" && row.agentId.endsWith(".ai")));
  assert.notDeepEqual(value.participants.map(row => row.wallet), [...f.wallets].sort());
  assert.deepEqual(f.calls, { chain: 1, task: 1, page: 1, submission: 14, identity: 14, running: 0, max: 6, destroyed: 0 });
});

test("strict response allowlists omit all hashes, artifact data, metadata, winner and scores", async () => {
  const value = await fixture(2).reader("1");
  assert.deepEqual(Object.keys(value).sort(), ["taskId", "chainId", "escrowAddress", "readBlock", "total", "order", "identityBasis", "participants"].sort());
  for (const row of value.participants)
    assert.deepEqual(Object.keys(row).sort(), ["ordinal", "wallet", "agentId", "identityStatus", "submittedAt"].sort());
  assert.ok(!JSON.stringify(value).includes(SECRET));
});

test("empty and full64 lists use only one bounded task page, never an event/genesis scan", async () => {
  for (const count of [0, 64]) {
    const f = fixture(count), value = await f.reader("1");
    assert.equal(value.total, count); assert.equal(value.participants.length, count);
    assert.equal(f.calls.task, 1); assert.equal(f.calls.page, 1);
    assert.equal(f.calls.submission, count); assert.equal(f.calls.identity, count);
    assert.ok(f.calls.max <= 6);
  }
});

test("counts, duplicates, zero/invalid addresses, missing submissions and unsafe timestamps fail closed", async () => {
  const mutations = [
    f => { f.record.submissionCount = 65n; },
    f => { f.record.submissionCount = 1n; },
    f => { f.wallets[1] = f.wallets[0]; },
    f => { f.wallets[0] = address(0); },
    f => { f.wallets[0] = "not-an-address"; },
    f => { f.submission.exists = false; },
    f => { f.submission.submittedAt = 0n; },
    f => { f.submission.submittedAt = 9007199254740992n; },
  ];
  for (const mutate of mutations) {
    const f = fixture(2); mutate(f);
    await assert.rejects(f.reader("1"), code("PARTICIPANTS_INCONSISTENT"));
    assert.equal(f.calls.chain, 1);
  }
});

test("missing task and invalid IDs are explicit without fetching any unrelated tasks", async () => {
  const f = fixture(0); f.record.status = 0n;
  await assert.rejects(f.reader("1"), code("NOT_FOUND"));
  assert.equal(f.calls.page, 0);
  for (const value of ["0", "-1", "x", "1e3", "10000000000000000"])
    await assert.rejects(f.reader(value), code("INVALID_REQUEST"));
  assert.equal(f.calls.chain, 1);
});

test("registry failures keep wallets/timestamps unknown and trip a finite identity circuit", async () => {
  const f = fixture(64, { handle: () => { throw Error(SECRET); } });
  const value = await f.reader("1");
  assert.equal(value.total, 64);
  assert.ok(value.participants.every(row => row.agentId === null && row.identityStatus === "unknown" && row.submittedAt === 1700000000));
  assert.ok(f.calls.identity <= 6); assert.ok(!JSON.stringify(value).includes(SECRET));
  const constructFail = fixture(1, { reader: { registry: () => { throw Error(SECRET); } } });
  assert.equal((await constructFail.reader("1")).participants[0].identityStatus, "unknown");
});

test("empty and malformed registry handles never produce sample, truncated or invented identities", async () => {
  for (const [handle, status] of [["", "unregistered"], [null, "unknown"], ["a".repeat(257), "unknown"], ["hello.ai", "unknown"], ["<script>", "unknown"], ["space name", "unknown"]]) {
    const value = await fixture(1, { handle: () => handle }).reader("1");
    assert.equal(value.participants[0].agentId, null); assert.equal(value.participants[0].identityStatus, status);
  }
});

test("successful reads coalesce and cache45s, responses are isolated from caller mutation", async () => {
  const f = fixture(14, { latency: 1 });
  const [first, second] = await Promise.all([f.reader("1"), f.reader("01")]);
  assert.equal(f.calls.chain, 1); assert.deepEqual(first, second);
  first.participants[0].agentId = SECRET; second.participants.length = 0;
  const third = await f.reader("1"); assert.equal(third.total, 14); assert.equal(third.participants.length, 14);
  assert.ok(!JSON.stringify(third).includes(SECRET));
  f.tick(44999); await f.reader("1"); assert.equal(f.calls.chain, 1);
  f.tick(2); await f.reader("1"); assert.equal(f.calls.chain, 2);
});

test("unknown identities retry after5s, failed snapshots never cache", async () => {
  const f = fixture(1, { handle: () => { throw Error(SECRET); } });
  await f.reader("1"); f.tick(4999); await f.reader("1"); assert.equal(f.calls.chain, 1);
  f.tick(2); await f.reader("1"); assert.equal(f.calls.chain, 2);
  f.contract.getTask = async () => { throw Error(SECRET); };
  f.tick(5001);
  for (let i = 0; i < 2; i++) await assert.rejects(f.reader("1"), error => code("PARTICIPANTS_UNAVAILABLE")(error) && !error.message.includes(SECRET));
  assert.equal(f.calls.chain, 4);
});

test("cache has a bounded128-entry LRU", async () => {
  const f = fixture(0);
  for (let id = 1; id <= 128; id++) await f.reader(id);
  await f.reader(1); assert.equal(f.calls.chain, 128);
  await f.reader(129); await f.reader(1); assert.equal(f.calls.chain, 129);
  await f.reader(2); assert.equal(f.calls.chain, 130);
});

test("global concurrency6 applies across separate tasks, not just within each page", async () => {
  const f = fixture(14, { latency: 1 });
  await Promise.all(Array.from({ length: 4 }, (_, i) => f.reader(i + 1)));
  assert.equal(f.calls.chain, 4); assert.equal(f.calls.submission, 56); assert.equal(f.calls.identity, 56);
  assert.equal(f.calls.max, 6);
});

test("inflight admission is bounded8 and duplicate requests still coalesce", async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const reader = createParticipantReader({ active, chain: async () => { await gate; throw Error(SECRET); } });
  const pending = Array.from({ length: 8 }, (_, i) => reader(i + 1));
  const duplicate = reader(1);
  await assert.rejects(reader(9), code("PARTICIPANTS_BUSY"));
  finish();
  const outcomes = await Promise.allSettled([...pending, duplicate]);
  assert.ok(outcomes.every(row => row.status === "rejected" && row.reason.code === "PARTICIPANTS_UNAVAILABLE"));
});

test("absolute and per-call deadlines release admission and sanitize hung providers", async () => {
  const hung = createParticipantReader({ active, chain: () => new Promise(() => {}), budgetMs: 15 });
  await assert.rejects(hung(1), code("PARTICIPANTS_UNAVAILABLE"));
  await assert.rejects(hung(1), code("PARTICIPANTS_UNAVAILABLE"));
  const f = fixture(1, { reader: { budgetMs: 100, callTimeoutMs: 5 } });
  f.contract.getTask = () => new Promise(() => {});
  await assert.rejects(f.reader(1), code("PARTICIPANTS_UNAVAILABLE"));
  assert.equal(f.calls.destroyed, 1);
  const identities = fixture(64, { reader: { budgetMs: 100, callTimeoutMs: 5 } });
  identities.identity.handleOf = () => new Promise(() => {});
  const value = await identities.reader(1);
  assert.ok(value.participants.every(row => row.identityStatus === "unknown"));
  assert.ok(identities.calls.destroyed <= 6);
});

test("pinned snapshots are validated against head minus3 and every contract call shares one block", async () => {
  const f = fixture(2);
  assert.equal((await f.reader(1, { block: 197 })).readBlock, 197);
  await assert.rejects(f.reader(1, { block: 198 }), code("INVALID_SNAPSHOT"));
  for (const block of [99, 0, "", "1e3", 1.1, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.reader(1, { block }), code("INVALID_SNAPSHOT"));
});

test("query deployment selectors reject mismatches/duplicates and optional block is strict", () => {
  assert.deepEqual(participantQuery(new URLSearchParams("chainId=56&escrowAddress=" + active.address + "&block=197"), active), { block: 197 });
  for (const query of ["chainId=1", "escrowAddress=" + address(3), "contract=" + address(3), "chainId="])
    assert.throws(() => participantQuery(new URLSearchParams(query), active), code("DEPLOYMENT_MISMATCH"));
  for (const query of ["chainId=56&chainId=56", "block=197&block=198", "contract=x&contract=x"])
    assert.throws(() => participantQuery(new URLSearchParams(query), active), code("INVALID_REQUEST"));
  assert.throws(() => participantQuery(new URLSearchParams("block="), active), code("INVALID_SNAPSHOT"));
});

test("actual GET route imports six-level shared HTTP wrapper and rejects invalid requests before RPC", async () => {
  const routePath = "../app/api/marketplace/tasks/[id]/participants/route.js";
  const source = await readFile(new URL(routePath, import.meta.url), "utf8");
  assert.match(source, /from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/marketplace-http\.mjs'/);
  const route = await import(routePath);
  assert.equal(route.runtime, "nodejs"); assert.equal(route.dynamic, "force-dynamic"); assert.equal(route.maxDuration, 60);
  for (const [id, query, expected, status] of [["1", "chainId=1", "DEPLOYMENT_MISMATCH", 409], ["0", "chainId=" + deployment.chainId, "INVALID_REQUEST", 400], ["1", "block=", "INVALID_SNAPSHOT", 400]]) {
    const response = await route.GET(new Request("https://fixture.invalid/api/marketplace/tasks/" + id + "/participants?" + query), { params: Promise.resolve({ id }) });
    assert.equal(response.status, status); assert.match(response.headers.get("cache-control"), /no-store/);
    const body = await response.json(); assert.equal(body.code, expected); assert.ok(!JSON.stringify(body).includes(SECRET));
  }
});
