import fs from "node:fs";
import { JsonRpcProvider, Contract, formatEther } from "ethers";
const pending = JSON.parse(fs.readFileSync(".local/deployment-pending.json"));
const old = JSON.parse(fs.readFileSync("lib/deployment.json"));
const abi = JSON.parse(fs.readFileSync("lib/office-abi.json"));
let recovered = false;
for (const rpc of [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-rpc.publicnode.com",
]) {
  const provider = new JsonRpcProvider(rpc, 56, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
  try {
    const receipt = await provider.getTransactionReceipt(pending.hash);
    if (!receipt) {
      console.log(JSON.stringify({ rpc, pending: true }));
      continue;
    }
    if (receipt.status !== 1) throw Error("Deployment reverted");
    if (receipt.to !== null || receipt.contractAddress?.toLowerCase() !== pending.address.toLowerCase() ||
        receipt.from.toLowerCase() !== pending.deployer.toLowerCase() ||
        (old.address && old.address.toLowerCase() !== pending.address.toLowerCase())) {
      throw Error("Receipt does not match the configured deployment");
    }
    const code = await provider.getCode(pending.address);
    const contract = new Contract(pending.address, abi, provider);
    const [reviewer, registry] = await Promise.all([
      contract.reviewer(),
      contract.agentId(),
    ]);
    if (
      code.length < 100 ||
      reviewer.toLowerCase() !== pending.reviewer.toLowerCase() ||
      registry.toLowerCase() !== old.registry.toLowerCase()
    )
      throw Error("Deployment configuration mismatch");
    const block = await provider.getBlock(receipt.blockNumber);
    if (!block) throw Error("Deployment block unavailable");
    const d = {
      ...old,
      address: pending.address,
      reviewer,
      deployer: pending.deployer,
      blockNumber: receipt.blockNumber,
      transactionHash: pending.hash,
      deployedWib:
        new Date(block.timestamp * 1000).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }) +
        " WIB",
      gasUsed: receipt.gasUsed.toString(),
      gasPriceWei: receipt.gasPrice.toString(),
      costBNB: formatEther(receipt.gasUsed * receipt.gasPrice),
      compiler: fs.readFileSync("artifacts/compiler-version.txt", "utf8"),
    };
    fs.writeFileSync("lib/deployment.json", JSON.stringify(d, null, 2));
    console.log(
      JSON.stringify({
        receiptStatus: receipt.status,
        codeBytes: (code.length - 2) / 2,
        deployment: d,
      }),
    );
    recovered = true;
    break;
  } catch (e) {
    console.log(JSON.stringify({ rpc, error: e.shortMessage || e.message }));
  } finally {
    provider.destroy();
  }
}
if (!recovered) process.exitCode = 1;
