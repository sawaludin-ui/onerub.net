import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { JsonRpcProvider, ContractFactory, Contract } from "ethers";
import {
  hash,
  taskView,
  artifactKey,
  issueChallenge,
  verifyAuthorization,
} from "../lib/marketplace-core.mjs";
import {
  registerMetadata,
  uploadArtifact,
  evaluateTask,
  deliverArtifact,
  prepareWinner,
  getArtifactReceipt,
} from "../lib/marketplace-service.mjs";
import { compile } from "../scripts/compile.mjs";
import { DEFAULT_POLICY, policyHash } from "../lib/marketplace-policy.mjs";

let chain, provider;
let deployer, requester, worker1, worker2, outsider, treasury;
let registry, usdc, escrow;
const artifact = (n) => JSON.parse(fs.readFileSync(`artifacts/${n}.json`));
const ZERO = `0x${"00".repeat(32)}`;
const H = (n) => `0x${String(n).padStart(2, "0").repeat(32)}`;
const USDC_ONE = 10n ** 18n; // BSC USDC has 18 decimals
const send = async (p) => (await p).wait();

const now = async () => BigInt((await provider.getBlock("latest")).timestamp);
const warp = async (seconds) => {
  await provider.send("evm_increaseTime", [Number(seconds)]);
  await provider.send("evm_mine", []);
};
const addr = (s) => s.getAddress();

// Requester-funded task helper. Returns taskId.
async function createTask(
  signer,
  { bounty = 5n * USDC_ONE, subIn = 3600n, reviewIn = 7200n } = {},
) {
  const t = await now();
  await send(usdc.mint(await addr(signer), bounty));
  await send(usdc.connect(signer).approve(await escrow.getAddress(), bounty));
  const id = await escrow
    .connect(signer)
    .createAndFund.staticCall(
      await usdc.getAddress(),
      bounty,
      hash(metadata),
      t + subIn,
      t + reviewIn,
      policyHash(DEFAULT_POLICY),
    );
  await send(
    escrow
      .connect(signer)
      .createAndFund(
        await usdc.getAddress(),
        bounty,
        hash(metadata),
        t + subIn,
        t + reviewIn,
        policyHash(DEFAULT_POLICY),
      ),
  );
  return id;
}

before(async () => {
  process.env.MARKETPLACE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
    "base64",
  );
  process.env.MARKETPLACE_AUTH_SECRET =
    "a-test-secret-with-at-least-32-characters";
  process.env.MARKETPLACE_DECISION_KEY_ID = "test";
  process.env.MARKETPLACE_DECISION_KEY = "synthetic-independent-decision-key-32-bytes-minimum";
  compile({ writeAbi: false });
  const resolve = createRequire(
    new URL("../scripts/test-chain/package.json", import.meta.url),
  ).resolve;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const binary = process.platform === "win32" ? "anvil.exe" : "anvil";
  const executable = resolve(
    `@foundry-rs/anvil-${process.platform}-${arch}/bin/${binary}`,
  );
  chain = spawn(
    executable,
    [
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--chain-id",
      "56",
      "--hardfork",
      "shanghai",
      "--accounts",
      "8",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const output = createInterface({ input: chain.stdout });
  const endpoint = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(Error("Anvil not ready")), 15000);
    chain.once("error", (e) => (clearTimeout(timer), rej(e)));
    chain.once("exit", () => (clearTimeout(timer), rej(Error("Anvil exited"))));
    output.on("line", (line) => {
      const m = line.match(/Listening on (127\.0\.0\.1:\d+)/);
      if (m) (clearTimeout(timer), res(`http://${m[1]}`));
    });
  });
  provider = new JsonRpcProvider(endpoint, 56, {
    staticNetwork: true,
    cacheTimeout: -1,
    pollingInterval: 20,
  });
  [deployer, requester, worker1, worker2, outsider, treasury] =
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));

  const reg = artifact("MockAgentID");
  registry = await new ContractFactory(
    reg.abi,
    reg.bytecode,
    deployer,
  ).deploy();
  await registry.waitForDeployment();
  const erc = artifact("MockERC20");
  usdc = await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy(
    "USD Coin",
    "USDC",
    18,
  );
  await usdc.waitForDeployment();
  const esc = artifact("OneRubMarketplaceEscrow");
  escrow = await new ContractFactory(esc.abi, esc.bytecode, deployer).deploy(
    await registry.getAddress(),
    await addr(treasury),
    await usdc.getAddress(),
  );
  await escrow.waitForDeployment();

  // Grant Agent IDs to requester + both workers (not outsider).
  for (const s of [requester, worker1, worker2])
    await send(registry.set(await addr(s), 1));
});

after(async () => {
  provider?.destroy();
  if (chain?.pid && chain.exitCode === null && chain.signalCode === null) {
    const stopped = once(chain, "exit");
    chain.kill();
    await stopped;
  }
});

const metadata = {
  title: "Review a sample algorithm",
  description:
    "Compare the algorithm against the supplied acceptance criteria.",
  category: "Code review",
  rubric: "Prefer a correct solution backed by reproducible test evidence.",
};
class MemoryStore {
  m = new Map();
  reservations = new Map();
  async retain(k) { return this.m.has(k); }
  async putArtifact(k, value, { id, worker, maxParticipants, maxTotalBytes }) {
    if (this.m.has(k)) return false;
    const entries = [...this.reservations.entries()].filter(([key]) => key.startsWith(id + ':'));
    if (entries.length >= maxParticipants || entries.reduce((total, [, bytes]) => total + bytes, 0) + value.size > maxTotalBytes) throw Error('Synthetic admission full');
    this.reservations.set(id + ':' + worker.toLowerCase(), value.size);
    this.m.set(k, value); return true;
  }
  async release(k,owner){if(this.m.get(k)!==owner)return false;return this.m.delete(k);}
  async get(k) {
    return this.m.get(k) || null;
  }
  async put(k, v, { nx = false } = {}) {
    if (nx && this.m.has(k)) return false;
    this.m.set(k, v);
    return true;
  }
}

test("full local escrow + private delivery: two worker commitments, bounded agent choice, payout, winner-only release", async () => {
  const storage = new MemoryStore();
  await storage.put("policy:" + policyHash(DEFAULT_POLICY), { policy: DEFAULT_POLICY });
  const id = String(await createTask(requester));
  const readTask = async () => {
    const t = await escrow.getTask(id);
    return {
      ...taskView(id, t, await escrow.phaseOf(id)),
      readBlock: await provider.getBlockNumber(),
    };
  };
  const readSubmission = (id, w) => escrow.getSubmission(id, w);
  await registerMetadata(
    id,
    await addr(requester),
    { metadata },
    { storage, readTask },
  );
  const payload = (n) => ({
    filename: "report.md",
    mimeType: "text/markdown",
    contentBase64: Buffer.from(
      "Private work report " + n + " with reproducible evidence.",
    ).toString("base64"),
  });
  const r1 = await uploadArtifact(id, await addr(worker1), payload("one"), {
    storage,
    readTask,
  });
  const r2 = await uploadArtifact(id, await addr(worker2), payload("two"), {
    storage,
    readTask,
  });
  assert.equal(
    JSON.stringify(
      storage.m.get(artifactKey(id, await addr(worker1))),
    ).includes("Private work report"),
    false,
  );
  const recovered = await getArtifactReceipt(id, await addr(worker1), {
    storage,
  });
  assert.equal(recovered.contentHash, r1.contentHash);
  await send(
    escrow
      .connect(worker1)
      .submitCommitment(id, r1.contentHash, r1.artifactPtrHash),
  );
  await send(
    escrow
      .connect(worker2)
      .submitCommitment(id, r2.contentHash, r2.artifactPtrHash),
  );
  await assert.rejects(
    deliverArtifact(id, await addr(requester), {
      storage,
      readTask,
      readSubmission,
    }),
    /confirmed settlement/,
  );
  await warp(3601);
  const evaluateOptions = {
    storage,
    readTask,
    readSubmission,
    getWorkers: () => escrow.getSubmitters(id),
    evaluator: async (task,records) => ({ winner: records[0].worker, score: records[0].worker===(await addr(worker2))?94:30 }),
  };
  let choice;for(let i=0;i<10;i++){choice=await evaluateTask(id,await addr(requester),evaluateOptions);if(choice.outcome!=='pending')break;}
  assert.equal(choice.winner, await addr(worker2));
  assert.equal(JSON.stringify(choice).includes("Private work report"), false);
  const prepared = await prepareWinner(id, {
    storage,
    readTask,
    readSubmission,
  });
  assert.equal(prepared.winner, choice.winner);
  await send(escrow.connect(requester).selectWinner(id, choice.winner));
  assert.equal(await usdc.balanceOf(await addr(worker2)), 45n * 10n ** 17n);
  assert.equal(await usdc.balanceOf(await addr(worker1)), 0n);
  assert.equal(await usdc.balanceOf(await addr(treasury)), 5n * 10n ** 17n);
  const delivery = await deliverArtifact(id, await addr(requester), {
    storage,
    readTask,
    readSubmission,
  });
  assert.equal(
    Buffer.from(delivery.contentBase64, "base64").toString(),
    "Private work report two with reproducible evidence.",
  );
  await assert.rejects(
    deliverArtifact(id, await addr(worker1), {
      storage,
      readTask,
      readSubmission,
    }),
    /access denied/,
  );
});
