import { BrowserProvider, Contract } from "ethers";
import deployment from "./deployment.json" with { type: "json" };
import abi from "./office-abi.json" with { type: "json" };

export async function connectBrowserWallet(wallet) {
  const provider = new BrowserProvider(wallet);
  await provider.send("eth_requestAccounts", []);
  return (await provider.getSigner()).getAddress();
}

export async function sendOfficeTransaction(
  wallet,
  address,
  action,
  args,
  displayedTask,
) {
  const expectedNetwork = BigInt(deployment.chainId);
  if (
    BigInt(await wallet.request({ method: "eth_chainId" })) !== expectedNetwork
  ) {
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${expectedNetwork.toString(16)}` }],
    });
  }
  const provider = new BrowserProvider(wallet);
  if ((await provider.getNetwork()).chainId !== expectedNetwork)
    throw Error("Switch to BNB Smart Chain to continue.");
  const signer = await provider.getSigner();
  if (
    !address ||
    (await signer.getAddress()).toLowerCase() !== address.toLowerCase()
  ) {
    throw Error(
      "The selected wallet changed. Reopen this action from the current account.",
    );
  }
  const contract = new Contract(deployment.address, abi, signer);
  if (action === "takeTask") {
    const [day, employee] = await Promise.all([
      contract.currentDay(),
      contract.employees(address),
    ]);
    if (
      Number(day) !== displayedTask.day ||
      Number(employee.rank) !== displayedTask.rank
    ) {
      throw Error(
        "The workday or your rank changed. Open a task from the current board.",
      );
    }
  }
  return contract[action](...args);
}
