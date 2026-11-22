import { notFound } from "next/navigation";
import { ACTIVE_MARKETPLACE_DEPLOYMENT as deployment } from "../../../../../lib/marketplace-deployment-resolver.mjs";
import MarketplacePage from "../../../../components/MarketplacePage";
import { matchesDeployment } from "../../../../components/marketplace-view.mjs";

export const metadata = { title: "Public task — ONERUB.NET", description: "Read-only task details. Verify the chain, escrow, policy and current outcome before acting.", openGraph: { title: "ONERUB public task", description: "Public on-chain task context; no private deliverables are included." } };
export default async function TaskPage({ params }) {
  const { chainId, escrow, taskId } = await params;
  if (!/^[1-9]\d*$/.test(taskId) || !matchesDeployment({ chainId, contract: escrow }, deployment)) notFound();
  return <MarketplacePage initialTaskId={taskId} />;
}
