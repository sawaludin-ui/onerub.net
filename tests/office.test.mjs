import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { JsonRpcProvider, ContractFactory } from "ethers";
import { compile } from "../scripts/compile.mjs";
let chain, provider, owner, alice, bob, outsider, registry, office;
const artifact = (n) => JSON.parse(fs.readFileSync(`artifacts/${n}.json`));
const send = async (p) => {
  const tx = await p;
  return tx.wait();
};
const nextDay = async () => {
  await provider.send("evm_increaseTime", [86400]);
  await provider.send("evm_mine", []);
};
const key = async (a) => office.assignmentId(a, await office.currentDay());
const evidence =
  '{"result":"verified test work","explanation":"A complete public result."}';
async function complete(signer, slot = 0) {
  const a = await signer.getAddress();
  await send(office.connect(signer).takeTask(slot));
  const id = await key(a);
  await send(office.connect(signer).submit(id, evidence));
  await send(office.review(id, true, "Accepted after review"));
  return id;
}
before(async () => {
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
      "5",
      "--timestamp",
      String(Date.parse("2026-11-20T16:30:00Z") / 1000),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const output = createInterface({ input: chain.stdout });
  const endpoint = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(Error("Local Anvil did not become ready.")),
      15000,
    );
    chain.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    chain.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Local Anvil exited during startup."));
    });
    output.on("line", (line) => {
      const match = line.match(/Listening on (127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveReady(`http://${match[1]}`);
      }
    });
  });
  provider = new JsonRpcProvider(endpoint, 56, {
    staticNetwork: true,
    cacheTimeout: -1,
    pollingInterval: 20,
  });
  [owner, alice, bob, outsider] = await Promise.all(
    [0, 1, 2, 3].map((i) => provider.getSigner(i)),
  );
  const m = artifact("MockAgentID");
  registry = await new ContractFactory(m.abi, m.bytecode, owner).deploy();
  await registry.waitForDeployment();
  const a = artifact("OnerubOffice");
  office = await new ContractFactory(a.abi, a.bytecode, owner).deploy(
    await registry.getAddress(),
    await owner.getAddress(),
  );
  await office.waitForDeployment();
  for (const s of [owner, alice, bob])
    await send(registry.set(await s.getAddress(), 1));
});
after(async () => {
  provider?.destroy();
  if (chain?.pid && chain.exitCode === null && chain.signalCode === null) {
    const stopped = once(chain, "exit");
    chain.kill();
    await stopped;
  }
});
test("membership is gated by Agent ID and cannot be registered twice", async () => {
  await assert.rejects(send(office.connect(outsider).join()));
  await send(office.connect(alice).join());
  await send(office.connect(bob).join());
  await assert.rejects(send(office.connect(alice).join()));
  assert.equal(await office.employeeCount(), 2n);
});
test("employee takes work without reviewer approval; one slot per WIB day, including rejected work", async () => {
  await assert.rejects(send(office.connect(alice).takeTask(5)));
  await send(office.connect(alice).takeTask(1));
  const id = await key(await alice.getAddress());
  await assert.rejects(send(office.connect(alice).takeTask(2)));
  await assert.rejects(send(office.connect(alice).mintAward(id)));
  await send(office.connect(alice).submit(id, evidence));
  await assert.rejects(send(office.connect(bob).review(id, true, "")));
  await send(office.review(id, false, "Please correct the calculation"));
  await assert.rejects(send(office.connect(alice).takeTask(2)));
  await assert.rejects(send(office.connect(alice).mintAward(id)));
  await send(office.connect(alice).submit(id, evidence));
  await send(office.review(id, true, "Now correct"));
  await send(office.connect(alice).mintAward(id));
  await assert.rejects(send(office.connect(alice).mintAward(id)));
  assert.equal(await office.totalAwards(), 1n);
  await assert.rejects(
    send(
      office
        .connect(alice)
        .transferFrom(await alice.getAddress(), await bob.getAddress(), 1),
    ),
  );
  const uri = await office.tokenURI(1);
  const metadata = JSON.parse(Buffer.from(uri.split(",")[1], "base64"));
  assert.equal(metadata.name, "ONERUB Work Award #1");
  assert.match(metadata.image, /^data:image\/svg\+xml;base64,/);
});
test("daily boundary is midnight WIB; pending reviews do not prevent next-day work", async () => {
  const old = await office.currentDay();
  await provider.send("evm_increaseTime", [1801]);
  await provider.send("evm_mine", []);
  assert.equal(await office.currentDay(), old + 1n);
  await send(office.connect(alice).takeTask(0));
  const id = await key(await alice.getAddress());
  await send(office.connect(alice).submit(id, evidence));
  await nextDay();
  await send(office.connect(alice).takeTask(2));
  const id2 = await key(await alice.getAddress());
  await send(office.connect(alice).submit(id2, evidence));
  await send(office.review(id2, true, ""));
  await send(office.review(id, true, ""));
  const e = await office.employees(await alice.getAddress());
  assert.equal(e.rank, 1n);
  assert.equal(e.stageCorrect, 0n);
});
test("higher ranks can help lower ranks without earning extra daily credit or an NFT", async () => {
  await send(office.connect(bob).takeTask(3));
  const bid = await key(await bob.getAddress());
  const before = await office.employees(await alice.getAddress());
  await send(
    office
      .connect(alice)
      .help(bid, "Apply the policy rules in the exact order."),
  );
  await assert.rejects(
    send(office.connect(alice).help(bid, "Another helper message.")),
  );
  const aid = await key(await alice.getAddress());
  await assert.rejects(
    send(office.connect(bob).help(aid, "Trying to help a higher rank.")),
  );
  const after = await office.employees(await alice.getAddress());
  assert.equal(after.totalCorrect, before.totalCorrect);
  assert.equal((await office.getHelp(bid)).length, 1);
  await assert.rejects(send(office.connect(alice).mintAward(bid)));
});
test("Staff, Senior and Manager thresholds reset to zero and one-task cap persists", async () => {
  for (const [rank, target] of [
    [1, 7],
    [2, 10],
    [3, 30],
  ]) {
    for (let i = 0; i < target; i++) {
      await nextDay();
      await complete(alice, i % 5);
      const e = await office.employees(await alice.getAddress());
      if (i < target - 1) {
        assert.equal(e.rank, BigInt(rank));
        assert.equal(e.stageCorrect, BigInt(i + 1));
      }
    }
    const e = await office.employees(await alice.getAddress());
    assert.equal(e.rank, BigInt(rank + 1));
    assert.equal(e.stageCorrect, 0n);
  }
  await assert.rejects(send(office.connect(alice).takeTask(0)));
});
test("revoked membership blocks work; reviewer transfer is two-step and cannot be hijacked", async () => {
  await send(registry.set(await bob.getAddress(), 0));
  await assert.rejects(
    send(
      office.connect(bob).submit(await key(await bob.getAddress()), evidence),
    ),
  );
  await assert.rejects(
    send(
      office.connect(outsider).nominateReviewer(await outsider.getAddress()),
    ),
  );
  await send(office.nominateReviewer(await bob.getAddress()));
  await assert.rejects(send(office.connect(outsider).acceptReviewer()));
  await send(office.connect(bob).acceptReviewer());
  assert.equal(await office.reviewer(), await bob.getAddress());
});
