import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasTaskBrief, taskStatusLabel, formatDeadline, fundingHealthWarning, selfTaskNotice, isSelfTask, agentInstructions } from "../app/components/marketplace-view.mjs";
const account = "0x" + "a".repeat(40);
const task = { id: "1", phase: "Open", requester: account, policyVerified: true };
const metadata = { title: "Private isolated test", description: "This fixture is never published", rubric: "Exact criteria" };

test("missing briefs never advertise accepting work or hand off submission steps", () => {
  for (const missing of [null, undefined, {}, [], { title: "x", description: "x" }]) {
    const item = { ...task, metadata: missing };
    assert.equal(hasTaskBrief(item), false);
    assert.equal(taskStatusLabel(item), "Brief not published — do not start work");
    const worker = agentInstructions({ task: item, role: "worker", briefVerified: true });
    assert.match(worker, /Observe only; do not upload, submit or spend gas/);
    assert.doesNotMatch(worker, /upload the private artifact/);
    const requester = agentInstructions({ task: item, role: "requester" });
    assert.match(requester, /recover the original exact metadata JSON/);
    assert.match(requester, /Do not create or fund a duplicate task/);
  }
});
test("readable brief is insufficient without independent hash and verified policy", () => {
  const item = { ...task, metadata };
  assert.match(agentInstructions({ task: item }), /verification is incomplete/);
  assert.match(agentInstructions({ task: { ...item, policyVerified: false }, briefVerified: true }), /verification is incomplete/);
  assert.match(agentInstructions({ task: item, briefVerified: true }), /upload the private artifact/);
  assert.equal(taskStatusLabel(item), "Accepting work");
  assert.match(agentInstructions({ task: { ...task, phase: "Settled" } }), /authenticated delivery/);
});
test("deadlines include year and exact UTC", () => {
  assert.match(formatDeadline(1795528800), /24 Nov 2026.*21:00 WIB/);
  assert.equal(formatDeadline(1795528800, true), "2026-11-24T14:00:00Z · UTC");
  assert.equal(formatDeadline("invalid"), "Not available");
});
test("funding warnings name unknown checks without guessing health or leaking error text", () => {
  const warning = fundingHealthWarning({ status: "degraded", checks: { rpc: {status:"available"}, evaluator: {status:"cooldown"}, storage: {status:"unavailable", error:"PRIVATE"} } });
  for (const text of ["evaluator: cooldown", "uploads: unknown", "delivery: unknown", "storage: unavailable", "HEALTH_ACK_REQUIRED", "never auto-acknowledge", "Direct contract calls bypass"]) assert.ok(warning.includes(text));
  assert.doesNotMatch(warning, /PRIVATE/);
  assert.match(fundingHealthWarning(null), /Funding health is unknown/);
  assert.match(fundingHealthWarning({status:"healthy"}), /not fully verified/);
  assert.match(agentInstructions({role:"requester",newTasksEnabled:true}), /explicit acknowledgement/);
});
test("known requester cannot receive worker upload instructions, regardless of brief verification", () => {
  assert.equal(isSelfTask(task, account.toUpperCase()), true);
  assert.equal(isSelfTask(task, null), false);
  assert.equal(isSelfTask(task, "0x" + "b".repeat(40)), false);
  assert.match(selfTaskNotice(task, account.toUpperCase()), /requester cannot submit/);
  assert.match(selfTaskNotice(task, account), /commitment will revert, wasting gas/);
  assert.match(selfTaskNotice(task, null), /compare your worker wallet/);
  for (const brief of [null, metadata]) {
    const prompt = agentInstructions({task:{...task,metadata:brief},account,briefVerified:true});
    assert.match(prompt, /Stop: requester cannot submit/);
    assert.match(prompt, /Do not upload, submit a commitment or spend gas/);
    assert.doesNotMatch(prompt, /upload the private artifact|complete this task/);
  }
  assert.match(agentInstructions({task:{...task,metadata:null},account,role:"requester"}), /recover the original exact metadata JSON/);
  assert.match(agentInstructions({task:{...task,phase:"Settled"},account}), /authenticated delivery/);
});
test("parent integrates recovery and proof while preserving pagination and motion", () => {
  const source = readFileSync(new URL("../app/components/MarketplacePage.js", import.meta.url), "utf8");
  for (const text of ["import MetadataPublisher, { MetadataIntegrity }", "onVerificationChange={setBriefVerified}", "onAccountChange={setKnownAccount}", "refresh(); showTask(selected);", "aria-describedby=\"worker-brief-status\"", "<PaginationControls", "<MotionLayer", "title={deadline(task.submissionDeadline, true)}", "!briefVerified || selected.policyVerified !== true", "isSelfTask(selected, knownAccount) || !hasTaskBrief(selected)", "isSelfTask(task, knownAccount) || !hasTaskBrief(task)", "Requester cannot submit to their own task. Worker handoff blocked"]) assert.ok(source.includes(text), text);
  assert.doesNotMatch(source, /eth_requestAccounts|eth_sendTransaction|Today[ <]/);
});
