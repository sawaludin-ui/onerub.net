import fs from "node:fs";
import {
  Wallet,
  JsonRpcProvider,
  ContractFactory,
  Contract,
  formatEther,
} from "ethers";
import { compile } from "./compile.mjs";
const config = JSON.parse(fs.readFileSync("lib/deployment.json"));
if (config.address)
  throw Error(
    `Office already configured at ${config.address}; refusing duplicate deployment`,
  );
compile();
const artifact = JSON.parse(fs.readFileSync("artifacts/OnerubOffice.json"));
const secret = JSON.parse(
  fs.readFileSync("D:/NXR/secrets/agentopia-oracle.json", "utf8"),
);
const provider = new JsonRpcProvider("https://bsc-dataseed.bnbchain.org", 56, {
  staticNetwork: true,
  batchMaxCount: 1,
});
const signer = new Wallet(secret.privateKey, provider);
const reviewer = "0x607cF25614065179a9238705E03E6590C082F56d";
try {
  const registry = new Contract(
    config.registry,
    [
      "function balanceOf(address) view returns(uint256)",
      "function handleOf(address) view returns(string)",
    ],
    provider,
  );
  if (
    (await registry.balanceOf(reviewer)) === 0n ||
    (await registry.handleOf(reviewer)) !== "ferta"
  )
    throw Error("Reviewer Agent ID verification failed");
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const tx = await factory.getDeployTransaction(config.registry, reviewer);
  const gas = await provider.estimateGas({ ...tx, from: signer.address });
  const gasPrice = (await provider.getFeeData()).gasPrice;
  const gasLimit = (gas * 120n) / 100n,
    balance = await provider.getBalance(signer.address);
  console.log(
    JSON.stringify({
      deployer: signer.address,
      reviewer,
      estimatedGas: gas.toString(),
      gasLimit: gasLimit.toString(),
      gasPriceWei: gasPrice.toString(),
      maxCostBNB: formatEther(gasLimit * gasPrice),
      balanceBNB: formatEther(balance),
    }),
  );
  if (balance < gasLimit * gasPrice)
    throw Error("Insufficient deployment gas. No transaction submitted.");
  fs.mkdirSync(".local", { recursive: true });
  const pendingPath = ".local/deployment-pending.json";
  if (fs.existsSync(pendingPath))
    throw Error(
      "Pending deployment exists. Inspect its receipt instead of deploying twice.",
    );
  const c = await factory.deploy(config.registry, reviewer, {
    gasLimit,
    gasPrice,
  });
  const hash = c.deploymentTransaction().hash,
    address = await c.getAddress();
  fs.writeFileSync(
    pendingPath,
    JSON.stringify({ hash, address, reviewer, deployer: signer.address }),
  );
  console.log(JSON.stringify({ submitted: hash, address }));
  let receipt;
  for (let i = 0; i < 90; i++) {
    receipt = await provider.getTransactionReceipt(hash);
    if (receipt && (await provider.getBlockNumber()) >= receipt.blockNumber + 1)
      break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!receipt)
    throw Error(
      "Receipt not yet available. Run scripts/recover-deployment.mjs, not a second deployment.",
    );
  if (receipt.status !== 1) throw Error("Deployment transaction failed");
  if ((await provider.getCode(address)).length < 100)
    throw Error("No contract code after confirmed receipt");
  const deployment = {
    ...config,
    address,
    reviewer,
    deployer: signer.address,
    blockNumber: receipt.blockNumber,
    transactionHash: hash,
    deployedWib:
      new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }) + " WIB",
    gasUsed: receipt.gasUsed.toString(),
    gasPriceWei: receipt.gasPrice.toString(),
    costBNB: formatEther(receipt.gasUsed * receipt.gasPrice),
    compiler: fs.readFileSync("artifacts/compiler-version.txt", "utf8"),
  };
  fs.writeFileSync("lib/deployment.json", JSON.stringify(deployment, null, 2));
  console.log(JSON.stringify({ verifiedDeployment: deployment }));
} finally {
  provider.destroy();
}
