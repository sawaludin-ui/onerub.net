import test from "node:test";
import assert from "node:assert/strict";
import { POST as prepare } from "../app/api/prepare/route.js";
import { GET as taskBoard } from "../app/api/tasks/route.js";
import { GET as office } from "../app/api/office/route.js";
import { GET as assignments } from "../app/api/assignments/route.js";
import { GET as assignment } from "../app/api/assignment/[id]/route.js";
import { sendOfficeTransaction } from "../lib/browser-wallet.mjs";
import {
  deployment,
  officeInterface,
  publicText,
  readRoster,
} from "../lib/chain.mjs";

const address = "0x1111111111111111111111111111111111111111";
const id = `0x${"11".repeat(32)}`;
const get = (path) => new Request(`https://onerub.test${path}`);

test("a browser wallet must actually switch to chain 56 before an office write", async () => {
  const methods = [];
  const wallet = { async request({ method }) {
    methods.push(method);
    return method === "wallet_switchEthereumChain" ? null : "0x1";
  } };
  await assert.rejects(sendOfficeTransaction(wallet, address, "join", []), /Switch to BNB/);
  assert.ok(methods.includes("wallet_switchEthereumChain"));
  assert.ok(!methods.includes("eth_sendTransaction"));
});

test("a newly selected account cannot sign an action shown for the previous account", async () => {
  const methods = [];
  const otherAddress = "0x2222222222222222222222222222222222222222";
  const wallet = { async request({ method }) {
    methods.push(method);
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_accounts") return [otherAddress];
    throw Error("Unexpected wallet request");
  } };
  await assert.rejects(sendOfficeTransaction(wallet, address, "join", []), /selected wallet changed/);
  assert.ok(!methods.includes("eth_sendTransaction"));
});
function post(body, type = "application/json") {
  return prepare(
    new Request("https://onerub.test/api/prepare", {
      method: "POST",
      headers: { "Content-Type": type },
      body,
    }),
  );
}

test("all six public workflows encode only the fixed office contract with zero value", async () => {
  for (const extra of [
    { action: "join" },
    { action: "takeTask", slot: 4 },
    { action: "submit", id, evidence: "Dokumen selesai." },
    { action: "help", id, evidence: "Periksa semua baris." },
    { action: "review", id, accepted: false, feedback: "Perbaiki total." },
    { action: "mintAward", id },
  ]) {
    const response = await post(JSON.stringify({ address, ...extra }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.to, deployment.address);
    assert.equal(result.chainId, 56);
    assert.equal(result.value, "0");
    assert.equal(result.from, address);
    const decoded = officeInterface.parseTransaction({ data: result.data });
    assert.equal(decoded.name, extra.action);
    assert.equal(
      result.data,
      officeInterface.encodeFunctionData(extra.action, result.args),
    );
  }
});

test("JSON input, wallet, id and decision errors return bounded messages", async () => {
  assert.equal((await post("{}", "text/plain")).status, 415);
  for (const text of ["", "{", "null", "[]", "7"])
    assert.equal((await post(text)).status, 400);
  assert.equal(
    (await post(JSON.stringify({ address, action: "unknown" }))).status,
    400,
  );
  for (const invalid of [
    { address: "unknown", action: "join" },
    { address, action: "takeTask", slot: 5 },
    { address, action: "mintAward", id: "short" },
    { address, action: "review", id, accepted: "false" },
  ])
    assert.equal((await post(JSON.stringify(invalid))).status, 400);
});

test("submission, assistance and reviewer limits count UTF-8 bytes", async () => {
  for (const [action, key, max] of [
    ["submit", "evidence", 2400],
    ["help", "evidence", 1000],
    ["review", "feedback", 600],
  ]) {
    const exact = "🟢".repeat(max / 4);
    const send = (text) =>
      post(
        JSON.stringify({ address, action, id, accepted: true, [key]: text }),
      );
    assert.equal((await send(exact)).status, 200);
    assert.equal((await send(exact + "a")).status, 400);
    assert.equal((await send(null)).status, 400);
    assert.equal((await send("\ud800")).status, 400);
    if (action !== "review") assert.equal((await send("1")).status, 400);
  }
});

test("the body byte limit applies to declared and streamed bodies", async () => {
  const payload = JSON.stringify({
    action: "submit",
    address,
    id,
    evidence: "x".repeat(17_000),
  });
  assert.equal((await post(payload)).status, 413);
  const request = new Request("https://onerub.test/api/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "17000" },
    body: "{}",
  });
  assert.equal((await prepare(request)).status, 413);
});

test("public reads reject invalid route inputs before contacting a chain provider", async () => {
  assert.equal((await office(get("/api/office?address=bad"))).status, 400);
  assert.equal(
    (await assignments(get("/api/assignments?offset=9007199254740992"))).status,
    400,
  );
  assert.equal(
    (await assignments(get("/api/assignments?limit=51"))).status,
    400,
  );
  assert.equal(
    (
      await assignment(get("/api/assignment/short"), {
        params: Promise.resolve({ id: "short" }),
      })
    ).status,
    400,
  );
  assert.equal((await taskBoard(get("/api/tasks?rank=1.5"))).status, 400);
});

test("daily API serves five choices for one WIB day and each supported rank", async () => {
  for (let rank = 0; rank < 5; rank++) {
    const response = await taskBoard(get(`/api/tasks?rank=${rank}`));
    const board = await response.json();
    assert.equal(board.dailyLimit, 1);
    assert.equal(board.tasks.length, 5);
    assert.ok(
      board.tasks.every(
        (task) =>
          task.rank === rank &&
          task.day === board.day &&
          !("expectedAnswer" in task),
      ),
    );
  }
});

test("a single unreadable on-chain text field does not break the office feed", () => {
  const record = {
    get evidence() {
      throw Error("Invalid text");
    },
    feedback: "Accepted",
  };
  assert.equal(publicText(record, "evidence"), "[Unreadable on-chain text]");
  assert.equal(publicText(record, "feedback"), "Accepted");
});

test("the complete roster spans multiple pages with at most six member lookups in flight", async () => {
  const records = Array.from(
    { length: 131 },
    (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
  );
  const calls = [];
  let active = 0;
  let peak = 0;
  const contract = {
    async getEmployeeAddresses(start, limit) {
      calls.push(start);
      return records.slice(start, start + limit);
    },
    async employees() {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return {
        joined: true,
        rank: 0,
        stageCorrect: 0,
        totalCorrect: 0,
        internStreak: 0,
        joinedAt: 1,
      };
    },
  };
  const identity = { handleOf: async () => null };
  const roster = await readRoster(contract, identity, records.length, {
    blockTag: 10,
  });
  assert.deepEqual(
    roster.map((employee) => employee.address),
    records,
  );
  assert.deepEqual(calls, [0, 100]);
  assert.ok(peak > 1 && peak <= 6);
});
