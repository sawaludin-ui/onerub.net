import test from "node:test";
import assert from "node:assert/strict";
import {
  agentInstructions,
  taskToken,
  formatAmount,
  listQuery,
  requestGate,
  taskPermalink,
  matchesDeployment,
  publicErrorMessage,
  taskTimeline,
} from "../app/components/marketplace-view.mjs";
const contract = "0x" + "a".repeat(40),
  usdc = { address: "0x" + "b".repeat(40), symbol: "USDC", decimals: 18 };
test("task handoff binds selected task, role, phase, chain and API URL", () => {
  const a = agentInstructions({
    task: { id: "11", phase: "Open", metadata: { title: "Local test brief", description: "Local test description", rubric: "Local test rubric" }, policyVerified: true },
    briefVerified: true,
    role: "worker",
    contract,
  });
  assert.match(a, /task #11/);
  assert.match(a, /\/tasks\/11/);
  assert.match(a, /as worker/);
  assert.match(a, /chain 56/);
  assert.match(a, /private artifact/);
  const b = agentInstructions({
    task: { id: "12", phase: "Settled" },
    role: "requester",
    contract,
  });
  assert.match(b, /task #12/);
  assert.match(b, /authenticated delivery/);
  assert.doesNotMatch(b, /upload the private artifact/);
  assert.match(
    agentInstructions({
      task: { id: "12", phase: "Review" },
      role: "requester",
      contract,
    }),
    /no-acceptable-submission/,
  );
});
test("token amounts use matching per-task decimals and never a global label for unknown token", () => {
  assert.equal(taskToken({ token: usdc.address }, usdc).supported, true);
  const unknown = taskToken({ token: contract }, usdc);
  assert.equal(unknown.supported, false);
  assert.equal(unknown.decimals, null);
  assert.notEqual(unknown.symbol, "USDC");
  const six = taskToken(
    {
      token: contract,
      tokenInfo: {
        address: contract,
        symbol: "SIX",
        decimals: 6,
        supported: true,
      },
    },
    usdc,
  );
  assert.equal(formatAmount("1234567", six.decimals), "1.234567");
  assert.equal(formatAmount("1", 18), "0.000000000000000001");
  assert.equal(formatAmount("1", null), "—");
});
test("search pagination keeps the same chain block and server filters", () => {
  const query = listQuery({
    q: " old task ",
    phase: "Paid",
    offset: 48,
    block: 134,
  });
  const url = new URL(query, "https://onerub.net");
  assert.equal(url.searchParams.get("block"), "134");
  assert.equal(url.searchParams.get("q"), "old task");
  assert.equal(url.searchParams.get("phase"), "Settled");
  assert.equal(url.searchParams.get("offset"), "48");
  assert.equal(url.searchParams.get("limit"), "12");
});
test("a newer selection and dialog dismissal invalidate late responses", () => {
  const gate = requestGate(),
    a = gate.next(),
    b = gate.next();
  assert.equal(a.signal.aborted, true);
  assert.equal(a.current(), false);
  assert.equal(b.current(), true);
  gate.cancel();
  assert.equal(b.current(), false);
  assert.equal(b.signal.aborted, true);
});

test("permalinks bind chain escrow id and reject invalid identity", () => {
  const path = taskPermalink({ chainId: 56, contract, id: "11" });
  assert.equal(path, `/tasks/56/${contract}/11`);
  assert.equal(taskPermalink({ chainId: 56, contract, id: "../secret" }), "/#tasks");
  assert.equal(taskPermalink({ chainId: 56, contract: "bad", id: "11" }), "/#tasks");
  assert.equal(matchesDeployment({ chainId: "56", contract }, { chainId: 56, escrowAddress: contract.toUpperCase() }), true);
  assert.equal(matchesDeployment({ chainId: "1", contract }, { chainId: 56, escrowAddress: contract }), false);
  assert.equal(matchesDeployment({ chainId: 56, contract: usdc.address }, { chainId: 56, escrowAddress: contract }), false);
});
test("handoff states economic risk and does not imply wallet connection", () => {
  for (const role of ["requester", "worker"]) {
    const prompt = agentInstructions({ role, contract });
    assert.match(prompt, /handoff, not a connection or wallet authorization/);
    assert.match(prompt, /other workers receive 0/);
    assert.match(prompt, /BNB gas and model costs/);
    assert.match(prompt, /Timeout may refund the requester/);
    assert.match(prompt, /refresh active deployment/);
  }
  const taskPrompt = agentInstructions({ role:"worker", contract, task:{id:"11", phase:"Review"} });
  assert.match(taskPrompt, /Submissions are closed/);
  assert.match(taskPrompt, new RegExp(`/tasks/56/${contract}/11`));
  assert.match(taskPrompt, /escrowAddress=/);
});
test("public error copy is allowlisted and never echoes provider private text", () => {
  const raw = "PRIVATE_REPORT_SECRET";
  assert.doesNotMatch(publicErrorMessage({error:raw},500), /PRIVATE_REPORT_SECRET/);
  assert.match(publicErrorMessage({error:{code:"STORAGE_UNAVAILABLE",message:raw}},503), /Do not upload/);
  assert.match(publicErrorMessage({},404), /not found/);
  assert.match(publicErrorMessage({},429), /do not resend wallet transactions/);
  assert.match(publicErrorMessage({ code: "EVALUATOR_COOLDOWN", error: raw }, 503), /pending, not failed|waiting for shared provider capacity, not rejected/);
  assert.match(publicErrorMessage({ code: "EVALUATOR_RATE_LIMIT", error: raw }, 503), /Saved progress is retained/);
});
test("timeline never turns payment into proof of artifact retrieval", () => {
 const timeline = Object.fromEntries(taskTimeline({phase:"Settled",submissionCount:2,readBlock:123,observation:{paymentStatus:"paid-on-chain",deliveryStatus:"recovery-required",events:[{event:"TaskCreated",blockNumber:100}]}}));
 assert.equal(timeline["Escrow funded"],"Confirmed at block 100");
 assert.equal(timeline.Payment,"paid-on-chain");
 assert.equal(timeline["Delivery availability"],"recovery-required");
 assert.match(timeline["Delivery retrieved"],/Not publicly reported/);
 assert.match(timeline["Artifact stored"],/Private status/);
});
test("new requester handoff cannot instruct V1 funding or unknown availability", () => {
 const setup = agentInstructions({role:"requester",contract,newTasksEnabled:false});
 assert.match(setup,/setup only, do not fund/);
 assert.match(setup,/newTasksEnabled=true for verified active V2/);
 assert.match(setup,/if false or unknown stop after setup/);
 assert.match(publicErrorMessage({code:"ESCROW_UPGRADE_REQUIRED"},409),/paused until verified V2/);
});
