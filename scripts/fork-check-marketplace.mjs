// Mainnet-fork validation for OneRubMarketplaceEscrow. Forks BNB Smart Chain
// locally (no broadcast, no real funds) and exercises the contract against the
// REAL USDC token and the REAL Agent ID registry. Part A checks constructor
// wiring + the Agent ID gate against mainnet state. Part B runs a full
// create -> fund -> submit -> select -> settle with real USDC, controlling the
// Agent ID gate via a local mock registry so arbitrary test accounts qualify.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { JsonRpcProvider, ContractFactory, Contract, keccak256, AbiCoder, toBeHex, zeroPadValue } from "ethers";
import { compile } from "./compile.mjs";

const REGISTRY = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";
const FERTA = "0x607cF25614065179a9238705E03E6590C082F56d";
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const FORK_RPC = "https://bsc-dataseed.bnbchain.org";
const USDC_ONE = 10n ** 18n;
const abi = AbiCoder.defaultAbiCoder();
const artifact = (n) => JSON.parse(fs.readFileSync(`artifacts/${n}.json`));
const send = async (p) => (await p).wait();
const log = (o) => console.log(JSON.stringify(o));

compile({ writeAbi: false });

const resolve = createRequire(new URL("./test-chain/package.json", import.meta.url)).resolve;
const arch = process.arch === "x64" ? "amd64" : process.arch;
const binary = process.platform === "win32" ? "anvil.exe" : "anvil";
const executable = resolve(`@foundry-rs/anvil-${process.platform}-${arch}/bin/${binary}`);
const chain = spawn(
  executable,
  ["--host", "127.0.0.1", "--port", "0", "--chain-id", "56", "--fork-url", FORK_RPC],
  { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
);
const rl = createInterface({ input: chain.stdout });
const endpoint = await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(Error("Anvil fork not ready (RPC slow?)")), 60000);
  chain.once("error", (e) => (clearTimeout(timer), rej(e)));
  chain.once("exit", () => (clearTimeout(timer), rej(Error("Anvil exited"))));
  rl.on("line", (line) => {
    const m = line.match(/Listening on (127\.0\.0\.1:\d+)/);
    if (m) (clearTimeout(timer), res(`http://${m[1]}`));
  });
});

const provider = new JsonRpcProvider(endpoint, 56, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
const fund = async (a) => provider.send("anvil_setBalance", [a, toBeHex(10n ** 18n)]);
const impersonate = async (a) => {
  await provider.send("anvil_impersonateAccount", [a]);
  await fund(a);
  return provider.getSigner(a);
};
// Brute-force the ERC20 balance storage slot and credit `amount` to `holder`.
const creditUSDC = async (holder, amount) => {
  const token = new Contract(USDC, ["function balanceOf(address) view returns(uint256)"], provider);
  for (let slot = 0; slot < 40; slot++) {
    const key = keccak256(abi.encode(["address", "uint256"], [holder, slot]));
    const prev = await provider.send("eth_getStorageAt", [USDC, key, "latest"]);
    await provider.send("anvil_setStorageAt", [USDC, key, zeroPadValue(toBeHex(amount), 32)]);
    if ((await token.balanceOf(holder)) === amount) return slot;
    await provider.send("anvil_setStorageAt", [USDC, key, prev]); // restore
  }
  return -1;
};

let failures = 0;
const check = (cond, label) => {
  log({ check: label, pass: !!cond });
  if (!cond) failures++;
};

try {
  const deployer = await provider.getSigner(0);
  const esc = artifact("OneRubMarketplaceEscrow");

  // --- Part A: wiring + Agent ID gate against REAL registry + REAL USDC ---
  const aEscrow = await new ContractFactory(esc.abi, esc.bytecode, deployer).deploy(REGISTRY, FERTA, USDC);
  await aEscrow.waitForDeployment();
  check((await aEscrow.agentId()).toLowerCase() === REGISTRY.toLowerCase(), "A: registry wired");
  check((await aEscrow.treasury()).toLowerCase() === FERTA.toLowerCase(), "A: treasury = ferta");
  check(await aEscrow.allowedToken(USDC), "A: USDC whitelisted");
  check(await aEscrow.eligible(FERTA), "A: ferta eligible on real registry");
  check(!(await aEscrow.eligible("0x000000000000000000000000000000000000dEaD")), "A: random addr not eligible");
  const [fee, payout] = await aEscrow.quote(5n * USDC_ONE);
  check(fee === 5n * 10n ** 17n && payout === 45n * 10n ** 17n, "A: quote 5 USDC = 0.5/4.5");

  // --- Part B: full E2E with REAL USDC, mock registry for the gate ---
  const mock = artifact("MockAgentID");
  const registry = await new ContractFactory(mock.abi, mock.bytecode, deployer).deploy();
  await registry.waitForDeployment();
  const bEscrow = await new ContractFactory(esc.abi, esc.bytecode, deployer).deploy(
    await registry.getAddress(),
    FERTA,
    USDC,
  );
  await bEscrow.waitForDeployment();

  const reqAddr = "0x00000000000000000000000000000000000000A1";
  const workAddr = "0x00000000000000000000000000000000000000B2";
  await send(registry.set(reqAddr, 1));
  await send(registry.set(workAddr, 1));
  const req = await impersonate(reqAddr);
  const work = await impersonate(workAddr);

  const slot = await creditUSDC(reqAddr, 5n * USDC_ONE);
  check(slot >= 0, `B: credited real USDC to requester (slot ${slot})`);
  if (slot < 0) throw Error("could not locate USDC balance slot on fork");

  const usdc = new Contract(USDC, ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)"], provider);
  await send(usdc.connect(req).approve(await bEscrow.getAddress(), 5n * USDC_ONE));
  const block = await provider.getBlock("latest");
  const t = BigInt(block.timestamp);
  const H = (n) => `0x${String(n).padStart(2, "0").repeat(32)}`;
  const taskId = await bEscrow.connect(req).createAndFund.staticCall(USDC, 5n * USDC_ONE, H(1), t + 1800n, t + 7200n, H(2));
  await send(bEscrow.connect(req).createAndFund(USDC, 5n * USDC_ONE, H(1), t + 1800n, t + 7200n, H(2)));
  check((await usdc.balanceOf(await bEscrow.getAddress())) === 5n * USDC_ONE, "B: escrow holds 5 real USDC");

  await send(bEscrow.connect(work).submitCommitment(taskId, H(10), H(11)));
  await provider.send("evm_increaseTime", [2000]);
  await provider.send("evm_mine", []);

  const treBefore = await usdc.balanceOf(FERTA);
  await send(bEscrow.connect(req).selectWinner(taskId, workAddr));
  check((await usdc.balanceOf(workAddr)) === 45n * 10n ** 17n, "B: winner received 4.5 real USDC");
  check((await usdc.balanceOf(FERTA)) - treBefore === 5n * 10n ** 17n, "B: treasury received 0.5 real USDC");
  check((await bEscrow.phaseOf(taskId)) === 3n, "B: task Settled");

  log({ result: failures === 0 ? "FORK CHECK PASS" : "FORK CHECK FAIL", failures });
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  provider.destroy();
  if (chain.pid && chain.exitCode === null) {
    const stopped = once(chain, "exit");
    chain.kill();
    await stopped;
  }
}
