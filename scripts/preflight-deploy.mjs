import fs from "node:fs";
import { Wallet, JsonRpcProvider, formatEther, Contract } from "ethers";
const secret = JSON.parse(
  fs.readFileSync("D:/NXR/secrets/agentopia-oracle.json", "utf8"),
);
const wallet = new Wallet(secret.privateKey);
if (
  secret.address &&
  secret.address.toLowerCase() !== wallet.address.toLowerCase()
)
  throw Error("Stored wallet address does not match signing key");
const provider = new JsonRpcProvider("https://bsc-rpc.publicnode.com", 56, {
  staticNetwork: true,
});
try {
  const [balance, fee, block, identity] = await Promise.all([
    provider.getBalance(wallet.address),
    provider.getFeeData(),
    provider.getBlockNumber(),
    new Contract(
      "0x60b9262456de011f7d15a54cdd8c48baaa8b022f",
      [
        "function balanceOf(address) view returns(uint256)",
        "function handleOf(address) view returns(string)",
      ],
      provider,
    ).handleOf("0x607cF25614065179a9238705E03E6590C082F56d"),
  ]);
  console.log(
    JSON.stringify({
      deployer: wallet.address,
      balanceBNB: formatEther(balance),
      gasPriceWei: fee.gasPrice?.toString(),
      block,
      reviewer: "0x607cF25614065179a9238705E03E6590C082F56d",
      reviewerHandle: identity + ".ai",
    }),
  );
} finally {
  provider.destroy();
}
