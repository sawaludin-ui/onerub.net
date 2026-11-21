import fs from "node:fs";
import {
  Wallet,
  JsonRpcProvider,
  ContractFactory,
  Contract,
  formatEther,
  isAddress,
} from "ethers";
import { compile } from "./compile.mjs";

// Constructor configuration for BNB Smart Chain (chain 56).
const REGISTRY = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f"; // Agent ID registry
const TREASURY = "0x607cF25614065179a9238705E03E6590C082F56d"; // ferta (fee recipient, owner-settable)
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"; // BSC USDC (18 decimals)
const DEPLOYMENT_PATH = "lib/marketplace-deployment.json";
const SECRET_PATH = "D:/NXR/secrets/agentopia-oracle.json";

for (const a of [REGISTRY, TREASURY, USDC])
  if (!isAddress(a)) throw Error(`Bad constructor address ${a}`);

if (fs.existsSync(DEPLOYMENT_PATH)) {
  const existing = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH));
  if (existing.address)
    throw Error(`Marketplace already at ${existing.address}; refusing duplicate deployment`);
}

compile();
const artifact = JSON.parse(fs.readFileSync("artifacts/OneRubMarketplaceEscrow.json"));
const secret = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
const provider = new JsonRpcProvider("https://bsc-dataseed.bnbchain.org", 56, {
  staticNetwork: true,
  batchMaxCount: 1,
});
const signer = new Wallet(secret.privateKey, provider);

try {
  // Sanity: registry must be a contract; USDC must be a contract.
  for (const [label, a] of [["registry", REGISTRY], ["USDC", USDC]]) {
    if ((await provider.getCode(a)).length < 4) throw Error(`${label} has no code on chain 56`);
  }
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const tx = await factory.getDeployTransaction(REGISTRY, TREASURY, USDC);
  const gas = await provider.estimateGas({ ...tx, from: signer.address });
  const gasPrice = (await provider.getFeeData()).gasPrice;
  const gasLimit = (gas * 120n) / 100n;
  const balance = await provider.getBalance(signer.address);
  console.log(
    JSON.stringify({
      deployer: signer.address,
      registry: REGISTRY,
      treasury: TREASURY,
      token: USDC,
      estimatedGas: gas.toString(),
      gasLimit: gasLimit.toString(),
      gasPriceWei: gasPrice.toString(),
      maxCostBNB: formatEther(gasLimit * gasPrice),
      balanceBNB: formatEther(balance),
    }),
  );
  if (balance < gasLimit * gasPrice) throw Error("Insufficient deployment gas. No transaction submitted.");

  fs.mkdirSync(".local", { recursive: true });
  const pendingPath = ".local/marketplace-pending.json";
  if (fs.existsSync(pendingPath))
    throw Error("Pending marketplace deployment exists. Inspect its receipt before deploying again.");

  const c = await factory.deploy(REGISTRY, TREASURY, USDC, { gasLimit, gasPrice });
  const hash = c.deploymentTransaction().hash;
  const address = await c.getAddress();
  fs.writeFileSync(pendingPath, JSON.stringify({ hash, address, deployer: signer.address }));
  console.log(JSON.stringify({ submitted: hash, address }));

  let receipt;
  for (let i = 0; i < 90; i++) {
    receipt = await provider.getTransactionReceipt(hash);
    if (receipt && (await provider.getBlockNumber()) >= receipt.blockNumber + 1) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!receipt) throw Error("Receipt not yet available. Inspect .local/marketplace-pending.json, do not redeploy.");
  if (receipt.status !== 1) throw Error("Deployment transaction failed");
  if ((await provider.getCode(address)).length < 100) throw Error("No contract code after confirmed receipt");

  // Post-deploy read-back of wiring.
  const deployed = new Contract(
    address,
    [
      "function agentId() view returns(address)",
      "function treasury() view returns(address)",
      "function allowedToken(address) view returns(bool)",
      "function FEE_BPS() view returns(uint16)",
    ],
    provider,
  );
  const checks = {
    agentId: await deployed.agentId(),
    treasury: await deployed.treasury(),
    usdcAllowed: await deployed.allowedToken(USDC),
    feeBps: (await deployed.FEE_BPS()).toString(),
  };
  if (checks.agentId.toLowerCase() !== REGISTRY.toLowerCase()) throw Error("registry mismatch after deploy");
  if (checks.treasury.toLowerCase() !== TREASURY.toLowerCase()) throw Error("treasury mismatch after deploy");
  if (!checks.usdcAllowed) throw Error("USDC not whitelisted after deploy");

  const deployment = {
    chainId: 56,
    contract: "OneRubMarketplaceEscrow",
    address,
    registry: REGISTRY,
    treasury: TREASURY,
    token: USDC,
    deployer: signer.address,
    blockNumber: receipt.blockNumber,
    transactionHash: hash,
    deployedWib: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }) + " WIB",
    gasUsed: receipt.gasUsed.toString(),
    gasPriceWei: receipt.gasPrice.toString(),
    costBNB: formatEther(receipt.gasUsed * receipt.gasPrice),
    compiler: fs.readFileSync("artifacts/compiler-version.txt", "utf8"),
    readBack: checks,
  };
  fs.writeFileSync(DEPLOYMENT_PATH, JSON.stringify(deployment, null, 2));
  fs.rmSync(pendingPath, { force: true });
  console.log(JSON.stringify({ verifiedDeployment: deployment }));
} finally {
  provider.destroy();
}
