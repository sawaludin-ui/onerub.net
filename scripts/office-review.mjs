#!/usr/bin/env node
// Approve office-playground submissions as the reviewer (ferta) through the
// Binance Agentic Wallet. Encodes review(id, accepted, feedback) and runs the
// baw contract-call preview -> execute flow. Pass --execute to broadcast.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { Interface } from "ethers";

const SHIM = "C:/Users/Dimas Sawaludin/.claude/skills/binance-agentic-wallet/scripts/doh-shim.js";
const CHAIN = "56";
const deployment = JSON.parse(fs.readFileSync("lib/deployment.json", "utf8"));
const OFFICE = deployment.address;
const office = new Interface(JSON.parse(fs.readFileSync("lib/office-abi.json", "utf8")));

const execute = process.argv.includes("--execute");

// id -> accepted + feedback (feedback must be <= 600 bytes)
const REVIEWS = [
  {
    id: "0x1e454f6affe8f1f8fc637c30f5e4182009ef4b5518c518d77e0849aa14962444",
    feedback: "Correct. Open records M3-M6 after dedup; 191 minutes total (research 28, support 78, engineering 85).",
  },
  {
    id: "0x720c2bcbbdb5790f4664b22afabac025b85e2fed16b243ec16d01a0246ed75d5",
    feedback: "Correct. Each event applied once; closing desk-a 72, desk-b 55, desk-c 66; 6 unique events, 2 retries ignored.",
  },
];

function baw(args) {
  const r = spawnSync("baw", args, {
    encoding: "utf8",
    shell: true,
    timeout: 120000,
    env: { ...process.env, NODE_OPTIONS: `--require "${SHIM}"` },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const s = out.indexOf("{"), e = out.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(out.slice(s, e + 1)); } catch {} }
  return { success: false, raw: out.slice(0, 400) };
}

function fromAddress() {
  const res = baw(["wallet", "address", "--json"]);
  const list = res?.data?.addresses || [];
  const evm = list.find((a) => a.binanceChainId === "1" || a.binanceChainId === CHAIN);
  if (!evm) throw Error("No EVM address from baw (is ferta signed in?)");
  return evm.address;
}

const from = fromAddress();
console.log(JSON.stringify({ reviewer: from, office: OFFICE, mode: execute ? "execute" : "dry-run" }));

for (const r of REVIEWS) {
  const data = office.encodeFunctionData("review", [r.id, true, r.feedback]);
  const preview = baw(["contract-call", "preview", "--binanceChainId", CHAIN, "--from", from, "--to", OFFICE, "--value", "0", "--inputData", data, "--json"]);
  const ok = !!preview?.success;
  console.log(JSON.stringify({ id: r.id, step: "preview", success: ok, requestId: preview?.data?.requestId, simCode: preview?.data?.simulationResult?.simulationCode, requireConfirmation: preview?.data?.requireConfirmation, error: ok ? undefined : (preview?.error || preview?.raw) }));
  if (!ok) continue;
  if (!execute) { console.log(JSON.stringify({ id: r.id, step: "dry-run", hint: "add --execute to broadcast" })); continue; }
  const exec = baw(["contract-call", "execute", "--requestId", preview.data.requestId, "--json"]);
  console.log(JSON.stringify({ id: r.id, step: "execute", success: !!exec?.success, status: exec?.data?.status, txHash: exec?.data?.txHash, orderId: exec?.data?.orderId, message: exec?.data?.message, error: exec?.success ? undefined : (exec?.error || exec?.raw) }));
}
