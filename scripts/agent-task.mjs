#!/usr/bin/env node
// Drives the OneRubMarketplaceEscrow from an agent's Binance Agentic Wallet
// (ferta.ai) through the `baw` CLI, using the two-step contract-call flow
// (preview -> execute). Preview only simulates; nothing is broadcast unless you
// pass --execute, and the CLI still routes high-value calls through the Binance
// App for confirmation.
//
// Usage (always previews first; add --execute to broadcast):
//   node scripts/agent-task.mjs approve <amountUSDC>
//   node scripts/agent-task.mjs create <amountUSDC> <submitMins> <reviewMins> [criteria] [policy]
//   node scripts/agent-task.mjs submit <taskId> <contentHash> <artifactPtrHash>
//   node scripts/agent-task.mjs select <taskId> <winnerAddress>
//   node scripts/agent-task.mjs cancel <taskId>
//   node scripts/agent-task.mjs refund <taskId>
//
// The wallet that signs is whichever agent is signed into `baw` (expected: ferta).
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { Interface, parseUnits, keccak256, toUtf8Bytes, isAddress } from "ethers";

const SHIM = "C:/Users/Dimas Sawaludin/.claude/skills/binance-agentic-wallet/scripts/doh-shim.js";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const USDC_DECIMALS = 18;
const CHAIN = "56";

const deployment = JSON.parse(fs.readFileSync("lib/marketplace-deployment.json", "utf8"));
const ESCROW = deployment.address;
const escrowAbi = JSON.parse(fs.readFileSync("lib/marketplace-abi.json", "utf8"));
const escrow = new Interface(escrowAbi);
const erc20 = new Interface([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const rest = args.filter((a) => a !== "--execute");
const [cmd, ...p] = rest;

function baw(cmdArgs) {
  const r = spawnSync("baw", cmdArgs, {
    encoding: "utf8",
    shell: true,
    timeout: 90000,
    env: { ...process.env, NODE_OPTIONS: `--require "${SHIM}"` },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(out.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return { success: false, raw: out };
}

function fromAddress() {
  const res = baw(["wallet", "address", "--json"]);
  const list = res?.data?.addresses || [];
  const evm = list.find((a) => a.binanceChainId === CHAIN || a.chainName === "BNB Smart Chain" || a.binanceChainId === "1");
  if (!evm) throw Error("No EVM address from baw wallet; is ferta signed in?");
  return evm.address;
}

function h32(s) {
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
  return keccak256(toUtf8Bytes(s)); // hash arbitrary text to a bytes32 commitment
}

function build() {
  switch (cmd) {
    case "approve": {
      const amount = parseUnits(p[0] ?? "0", USDC_DECIMALS);
      return { to: USDC, data: erc20.encodeFunctionData("approve", [ESCROW, amount]), note: `approve ${p[0]} USDC to escrow` };
    }
    case "create": {
      const amount = parseUnits(p[0] ?? "0", USDC_DECIMALS);
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const subDl = nowSec + BigInt(Number(p[1] ?? 60)) * 60n;
      const revDl = nowSec + BigInt(Number(p[2] ?? 120)) * 60n;
      const criteria = h32(p[3] ?? "criteria");
      const policy = h32(p[4] ?? "policy");
      return {
        to: ESCROW,
        data: escrow.encodeFunctionData("createAndFund", [USDC, amount, criteria, subDl, revDl, policy]),
        note: `createAndFund ${p[0]} USDC, submit +${p[1]}m, review +${p[2]}m`,
      };
    }
    case "submit":
      return { to: ESCROW, data: escrow.encodeFunctionData("submitCommitment", [BigInt(p[0]), h32(p[1]), h32(p[2])]), note: `submit task ${p[0]}` };
    case "select":
      if (!isAddress(p[1])) throw Error("winner must be an address");
      return { to: ESCROW, data: escrow.encodeFunctionData("selectWinner", [BigInt(p[0]), p[1]]), note: `select winner ${p[1]} for task ${p[0]}` };
    case "cancel":
      return { to: ESCROW, data: escrow.encodeFunctionData("cancel", [BigInt(p[0])]), note: `cancel task ${p[0]}` };
    case "refund":
      return { to: ESCROW, data: escrow.encodeFunctionData("refund", [BigInt(p[0])]), note: `refund task ${p[0]}` };
    default:
      throw Error(`Unknown command: ${cmd}. See header for usage.`);
  }
}

const from = fromAddress();
const call = build();
console.log(JSON.stringify({ step: "plan", from, to: call.to, note: call.note, inputData: call.data }));

const preview = baw(["contract-call", "preview", "--binanceChainId", CHAIN, "--from", from, "--to", call.to, "--value", "0", "--inputData", call.data, "--json"]);
console.log(JSON.stringify({ step: "preview", preview }));

if (!preview?.success) {
  console.log(JSON.stringify({ step: "stop", reason: "preview failed; not executing" }));
  process.exitCode = 1;
} else if (!execute) {
  console.log(JSON.stringify({ step: "dry-run", requestId: preview.data?.requestId, hint: "re-run with --execute to broadcast" }));
} else {
  const exec = baw(["contract-call", "execute", "--requestId", preview.data.requestId, "--json"]);
  console.log(JSON.stringify({ step: "execute", exec }));
  process.exitCode = exec?.success ? 0 : 1;
}
