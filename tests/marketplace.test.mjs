import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { JsonRpcProvider, ContractFactory, Contract } from "ethers";
import { compile } from "../scripts/compile.mjs";

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
async function createTask(signer, { bounty = 5n * USDC_ONE, subIn = 3600n, reviewIn = 7200n } = {}) {
  const t = await now();
  await send(usdc.mint(await addr(signer), bounty));
  await send(usdc.connect(signer).approve(await escrow.getAddress(), bounty));
  const id = await escrow.connect(signer).createAndFund.staticCall(
    await usdc.getAddress(),
    bounty,
    H(1),
    t + subIn,
    t + reviewIn,
    H(2),
  );
  await send(
    escrow
      .connect(signer)
      .createAndFund(await usdc.getAddress(), bounty, H(1), t + subIn, t + reviewIn, H(2)),
  );
  return id;
}

before(async () => {
  compile({ writeAbi: false });
  const resolve = createRequire(new URL("../scripts/test-chain/package.json", import.meta.url)).resolve;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const binary = process.platform === "win32" ? "anvil.exe" : "anvil";
  const executable = resolve(`@foundry-rs/anvil-${process.platform}-${arch}/bin/${binary}`);
  chain = spawn(
    executable,
    ["--host", "127.0.0.1", "--port", "0", "--chain-id", "56", "--hardfork", "shanghai", "--accounts", "8"],
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
  provider = new JsonRpcProvider(endpoint, 56, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 20 });
  [deployer, requester, worker1, worker2, outsider, treasury] = await Promise.all(
    [0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)),
  );

  const reg = artifact("MockAgentID");
  registry = await new ContractFactory(reg.abi, reg.bytecode, deployer).deploy();
  await registry.waitForDeployment();
  const erc = artifact("MockERC20");
  usdc = await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy("USD Coin", "USDC", 18);
  await usdc.waitForDeployment();
  const esc = artifact("OneRubMarketplaceEscrow");
  escrow = await new ContractFactory(esc.abi, esc.bytecode, deployer).deploy(
    await registry.getAddress(),
    await addr(treasury),
    await usdc.getAddress(),
  );
  await escrow.waitForDeployment();

  // Grant Agent IDs to requester + both workers (not outsider).
  for (const s of [requester, worker1, worker2]) await send(registry.set(await addr(s), 1));
});

after(async () => {
  provider?.destroy();
  if (chain?.pid && chain.exitCode === null && chain.signalCode === null) {
    const stopped = once(chain, "exit");
    chain.kill();
    await stopped;
  }
});

test("fee math is exact at 10% on 18-decimal amounts and tiny amounts", async () => {
  let [fee, payout] = await escrow.quote(5n * USDC_ONE);
  assert.equal(fee, 5n * 10n ** 17n); // 0.5 USDC
  assert.equal(payout, 45n * 10n ** 17n); // 4.5 USDC
  assert.equal(fee + payout, 5n * USDC_ONE);
  [fee, payout] = await escrow.quote(10n); // smallest bounty that still carries a fee
  assert.equal(fee, 1n);
  assert.equal(payout, 9n);
});

test("only an Agent ID holder can create and fund a task, with a whitelisted token", async () => {
  await send(usdc.mint(await addr(outsider), 5n * USDC_ONE));
  await send(usdc.connect(outsider).approve(await escrow.getAddress(), 5n * USDC_ONE));
  const t = await now();
  await assert.rejects(
    send(
      escrow
        .connect(outsider)
        .createAndFund(await usdc.getAddress(), 5n * USDC_ONE, H(1), t + 3600n, t + 7200n, H(2)),
    ),
    /Agent ID required/,
  );
  // non-whitelisted token
  const erc = artifact("MockERC20");
  const other = await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy("Other", "OTH", 18);
  await other.waitForDeployment();
  await send(other.mint(await addr(requester), 5n * USDC_ONE));
  await send(other.connect(requester).approve(await escrow.getAddress(), 5n * USDC_ONE));
  await assert.rejects(
    send(
      escrow
        .connect(requester)
        .createAndFund(await other.getAddress(), 5n * USDC_ONE, H(1), t + 3600n, t + 7200n, H(2)),
    ),
    /token not allowed/,
  );
});

test("deadlines and dust bounties are validated", async () => {
  const t = await now();
  await send(usdc.mint(await addr(requester), 5n * USDC_ONE));
  await send(usdc.connect(requester).approve(await escrow.getAddress(), 5n * USDC_ONE));
  // review before submission
  await assert.rejects(
    send(escrow.connect(requester).createAndFund(await usdc.getAddress(), 5n * USDC_ONE, H(1), t + 7200n, t + 3600n, H(2))),
    /review before submission/,
  );
  // bounty too small (fee would round to 0)
  await send(usdc.connect(requester).approve(await escrow.getAddress(), 5n));
  await assert.rejects(
    send(escrow.connect(requester).createAndFund(await usdc.getAddress(), 5n, H(1), t + 3600n, t + 7200n, H(2))),
    /bounty too small/,
  );
});

test("fee-on-transfer tokens are rejected so escrow accounting stays exact", async () => {
  const fot = artifact("FeeOnTransferERC20");
  const token = await new ContractFactory(fot.abi, fot.bytecode, deployer).deploy();
  await token.waitForDeployment();
  await send(escrow.connect(deployer).setAllowedToken(await token.getAddress(), true));
  await send(token.mint(await addr(requester), 5n * USDC_ONE));
  await send(token.connect(requester).approve(await escrow.getAddress(), 5n * USDC_ONE));
  const t = await now();
  await assert.rejects(
    send(escrow.connect(requester).createAndFund(await token.getAddress(), 5n * USDC_ONE, H(1), t + 3600n, t + 7200n, H(2))),
    /fee-on-transfer token/,
  );
});

test("workers must hold an Agent ID, cannot be the requester, cannot submit twice", async () => {
  const id = await createTask(requester);
  await assert.rejects(send(escrow.connect(outsider).submitCommitment(id, H(10), H(11))), /Agent ID required/);
  await assert.rejects(send(escrow.connect(requester).submitCommitment(id, H(10), H(11))), /requester cannot submit/);
  await assert.rejects(send(escrow.connect(worker1).submitCommitment(id, ZERO, H(11))), /empty content hash/);
  await send(escrow.connect(worker1).submitCommitment(id, H(10), H(11)));
  await assert.rejects(send(escrow.connect(worker1).submitCommitment(id, H(12), H(13))), /already submitted/);
  assert.equal(await escrow.submissionCount(id), 1n);
});

test("submissions are rejected once the submission window closes", async () => {
  const id = await createTask(requester, { subIn: 1800n, reviewIn: 7200n });
  await warp(2000n); // past submission deadline
  await assert.rejects(send(escrow.connect(worker1).submitCommitment(id, H(10), H(11))), /submission closed/);
  assert.equal(await escrow.phaseOf(id), 2n); // Review
});

test("winner-takes-all settlement pays 90/10 atomically and cannot repeat", async () => {
  const id = await createTask(requester, { subIn: 1800n, reviewIn: 7200n });
  await send(escrow.connect(worker1).submitCommitment(id, H(20), H(21)));
  await send(escrow.connect(worker2).submitCommitment(id, H(22), H(23)));
  // cannot select before submission window closes
  await assert.rejects(send(escrow.connect(requester).selectWinner(id, await addr(worker1))), /submission still open/);
  await warp(2000n);
  // only the requester can select
  await assert.rejects(send(escrow.connect(worker2).selectWinner(id, await addr(worker2))), /requester only/);
  // cannot pick someone who never submitted
  await assert.rejects(send(escrow.connect(requester).selectWinner(id, await addr(outsider))), /winner did not submit/);

  const w1Before = await usdc.balanceOf(await addr(worker1));
  const w2Before = await usdc.balanceOf(await addr(worker2));
  const treBefore = await usdc.balanceOf(await addr(treasury));
  await send(escrow.connect(requester).selectWinner(id, await addr(worker1)));
  assert.equal((await usdc.balanceOf(await addr(worker1))) - w1Before, 45n * 10n ** 17n); // 4.5
  assert.equal(await usdc.balanceOf(await addr(worker2)), w2Before); // loser gets 0
  assert.equal((await usdc.balanceOf(await addr(treasury))) - treBefore, 5n * 10n ** 17n); // 0.5
  assert.equal(await escrow.phaseOf(id), 3n); // Settled
  // no double settlement
  await assert.rejects(send(escrow.connect(requester).selectWinner(id, await addr(worker2))), /task not active/);
});

test("refund returns the full bounty when no one submits before the deadline", async () => {
  const id = await createTask(requester, { subIn: 1800n, reviewIn: 3600n });
  await warp(2000n);
  const before = await usdc.balanceOf(await addr(requester));
  await send(escrow.connect(requester).refund(id));
  assert.equal((await usdc.balanceOf(await addr(requester))) - before, 5n * USDC_ONE);
  assert.equal(await escrow.phaseOf(id), 4n); // Refunded
  await assert.rejects(send(escrow.connect(requester).refund(id)), /task not active/); // no double refund
});

test("refund is permissionless after the review window and always pays the requester", async () => {
  const id = await createTask(requester, { subIn: 1800n, reviewIn: 3600n });
  await send(escrow.connect(worker1).submitCommitment(id, H(30), H(31)));
  await warp(4000n); // past review deadline, no winner selected
  await assert.rejects(send(escrow.connect(requester).selectWinner(id, await addr(worker1))), /review window passed/);
  const before = await usdc.balanceOf(await addr(requester));
  await send(escrow.connect(outsider).refund(id)); // anyone can trigger
  assert.equal((await usdc.balanceOf(await addr(requester))) - before, 5n * USDC_ONE);
});

test("cancel only works before any submission and returns the bounty", async () => {
  const id = await createTask(requester);
  const other = await createTask(requester);
  await send(escrow.connect(worker1).submitCommitment(other, H(40), H(41)));
  await assert.rejects(send(escrow.connect(worker1).cancel(id)), /requester only/);
  await assert.rejects(send(escrow.connect(requester).cancel(other)), /work already submitted/);
  const before = await usdc.balanceOf(await addr(requester));
  await send(escrow.connect(requester).cancel(id));
  assert.equal((await usdc.balanceOf(await addr(requester))) - before, 5n * USDC_ONE);
  assert.equal(await escrow.phaseOf(id), 5n); // Cancelled
});

test("settling one task cannot touch another task's escrow", async () => {
  const a = await createTask(requester, { subIn: 1800n, reviewIn: 7200n });
  const b = await createTask(requester, { subIn: 1800n, reviewIn: 7200n });
  await send(escrow.connect(worker1).submitCommitment(a, H(50), H(51)));
  await send(escrow.connect(worker2).submitCommitment(b, H(52), H(53)));
  await warp(2000n);
  await send(escrow.connect(requester).selectWinner(a, await addr(worker1)));
  // task b bounty is still fully held
  const held = await usdc.balanceOf(await escrow.getAddress());
  assert.ok(held >= 5n * USDC_ONE, "task b escrow must remain");
  const tb = await escrow.getTask(b);
  assert.equal(tb.bounty, 5n * USDC_ONE);
  await send(escrow.connect(requester).selectWinner(b, await addr(worker2)));
});

test("owner can set the treasury and token whitelist but has no path to task funds", async () => {
  const esc = artifact("OneRubMarketplaceEscrow");
  const iface = new Contract(await escrow.getAddress(), esc.abi, provider).interface;
  const names = iface.fragments.filter((f) => f.type === "function").map((f) => f.name);
  // There must be no withdraw/sweep/rescue style function.
  for (const banned of ["withdraw", "sweep", "rescue", "drain", "emergencyWithdraw"])
    assert.ok(!names.includes(banned), `unexpected admin fund function: ${banned}`);
  // Non-owner cannot change treasury.
  await assert.rejects(send(escrow.connect(outsider).setTreasury(await addr(outsider))));
  await send(escrow.connect(deployer).setTreasury(await addr(treasury)));
  assert.equal(await escrow.treasury(), await addr(treasury));
});
