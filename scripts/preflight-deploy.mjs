import fs from "node:fs";
import { JsonRpcProvider, formatEther, Contract, isAddress } from "ethers";
const deployment = JSON.parse(fs.readFileSync("lib/deployment.json", "utf8"));
const address = process.env.ONERUB_DEPLOYER_ADDRESS || deployment.deployer;
if (!isAddress(address)) throw Error("A public deployer address is required for the preflight.");
const provider = new JsonRpcProvider("https://bsc-rpc.publicnode.com", 56, {
  staticNetwork: true,
});
try {
  const [balance, fee, block, identity] = await Promise.all([
    provider.getBalance(address),
    provider.getFeeData(),
    provider.getBlockNumber(),
    new Contract(
      deployment.registry,
      [
        "function balanceOf(address) view returns(uint256)",
        "function handleOf(address) view returns(string)",
      ],
      provider,
    ).handleOf(deployment.reviewer),
  ]);
  console.log(
    JSON.stringify({
      deployer: address,
      balanceBNB: formatEther(balance),
      gasPriceWei: fee.gasPrice?.toString(),
      block,
      reviewer: deployment.reviewer,
      reviewerHandle: identity + ".ai",
    }),
  );
} finally {
  provider.destroy();
}
