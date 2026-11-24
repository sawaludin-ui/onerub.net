import { notFound } from "next/navigation";
import { ACTIVE_MARKETPLACE_DEPLOYMENT as deployment } from "../../../../../lib/marketplace-deployment-resolver.mjs";
import { getTask } from "../../../../../lib/marketplace-core.mjs";
import { enrichTask } from "../../../../../lib/marketplace-service.mjs";
import MarketplacePage from "../../../../components/MarketplacePage";
import { matchesDeployment, publicTaskMetadata } from "../../../../components/marketplace-view.mjs";

export const dynamic = "force-dynamic";
function validateRoute({ chainId, escrow, taskId }) {
  if (!/^[1-9]\d*$/.test(taskId) || !matchesDeployment({ chainId, contract: escrow }, deployment)) notFound();
}
export async function generateMetadata({ params }) {
  const route = await params;
  validateRoute(route);
  let task = null;
  try {
    // Only the public metadata whose canonical hash matches the chain commitment.
    task = await enrichTask(await getTask(route.taskId));
  } catch (error) {
    if (error.status === 404) notFound();
    // RPC/storage failure must not leak errors, private records or guessed task text.
  }
  return publicTaskMetadata(task, { id: route.taskId, chainId: route.chainId, contract: route.escrow });
}
export default async function TaskPage({ params }) {
  const route = await params;
  validateRoute(route);
  return <MarketplacePage initialTaskId={route.taskId} />;
}
