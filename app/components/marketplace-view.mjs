export const PHASES = [
  "None",
  "Open",
  "Review",
  "Settled",
  "Refunded",
  "Cancelled",
  "Expired",
];
export const phaseOf = (task) =>
  typeof task.phase === "number"
    ? PHASES[task.phase]
    : String(task.phase || "Unknown");
export function hasTaskBrief(task) {
  return !!task?.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)
    && typeof task.metadata.title === "string" && !!task.metadata.title.trim()
    && typeof task.metadata.description === "string" && !!task.metadata.description.trim()
    && !!task.metadata.rubric;
}
export function taskStatusLabel(task) {
  if (!hasTaskBrief(task)) return "Brief not published — do not start work";
  return ({ Open: "Accepting work", Review: "In review", Settled: "Paid", Expired: "Review expired" })[phaseOf(task)] || phaseOf(task);
}
export function formatDeadline(value, utc = false) {
  const date = new Date(Number(value) * 1000);
  if (!value || !Number.isFinite(date.getTime())) return "Not available";
  if (utc) return date.toISOString().replace(".000Z", "Z") + " · UTC";
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }) + " WIB";
}
export function isSelfTask(task, account) {
  return /^0x[\da-f]{40}$/i.test(account || "") && String(account).toLowerCase() === String(task?.requester).toLowerCase();
}
export function selfTaskNotice(task, account) {
  return isSelfTask(task, account)
    ? "This is your own task. The requester cannot submit: uploads are rejected and an on-chain commitment will revert, wasting gas. Use requester recovery or observation instead."
    : "Before competing, compare your worker wallet with the requester. The requester cannot submit to their own task; an on-chain attempt will revert and waste gas.";
}
export function fundingHealthWarning(health) {
  const names = ["rpc", "storage", "encryption", "attestation", "evaluator", "uploads", "delivery"];
  const components = health?.checks || health?.components || {};
  const states = names.map(name => {
    const item = components[name];
    const raw = typeof item === "string" ? item : item?.status;
    return [name, ["available", "healthy", "ready", "unavailable", "degraded", "unknown", "cooldown", "not-required"].includes(raw) ? raw : "unknown"];
  });
  const uncertain = states.filter(([, state]) => !["available", "healthy", "ready"].includes(state));
  return health?.status === "healthy" && !uncertain.length
    ? "Latest observation reports healthy; refresh health and funding readiness immediately before approval. This is not a guarantee of review or delivery."
    : `Funding health is ${health?.status === "healthy" ? "not fully verified" : health?.status === "degraded" ? "degraded" : "unknown"}: ${uncertain.map(([name, state]) => `${name}: ${state}`).join(", ") || "fresh readiness verification required"}. Before approve or createAndFund, require a fresh readiness check and explicit acknowledgement of the current warning. On HEALTH_ACK_REQUIRED, show the returned readiness checks and request explicit confirmation before retrying the same prepare body with healthAcknowledgement:{accepted:true,token,expiresAt} from that warning; never auto-acknowledge. Expired acknowledgement or changed request/readiness requires a new warning. Direct contract calls bypass this off-chain gate. Acknowledgement never bypasses fatal storage, authorization or key failures.`;
}
export function taskToken(task, primary) {
  const info = task.tokenInfo;
  if (
    info &&
    info.supported === true &&
    /^0x[\da-f]{40}$/i.test(info.address || "") &&
    info.address.toLowerCase() === task.token?.toLowerCase() &&
    Number.isInteger(info.decimals) &&
    info.decimals >= 0 &&
    info.decimals <= 36
  )
    return info;
  if (
    !info && primary &&
    primary?.address?.toLowerCase() === task.token?.toLowerCase() &&
    Number.isInteger(primary.decimals)
  )
    return { ...primary, supported: true };
  return {
    address: task.token || info?.address || "",
    symbol: "Unsupported token",
    decimals: null,
    supported: false,
  };
}
export function formatAmount(value, decimals) {
  if(value===null||value===undefined)return "—";
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return "—";
  try {
    const n = BigInt(value ?? 0),
      base = 10n ** BigInt(decimals);
    if (n < 0n) return "—";
    const fraction = (n % base)
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    const precision = n > 0n && n < base / 1000000n ? decimals : 6;
    return fraction
      ? `${n / base}.${fraction.slice(0, precision)}${fraction.length > precision ? "…" : ""}`
      : String(n / base);
  } catch {
    return "—";
  }
}
export function agentInstructions({
  task,
  role = "worker",
  contract,
  chainId = 56,
  newTasksEnabled = false,
  health = null,
  briefVerified = false,
  account = null,
} = {}) {
  const safety = role === "requester" ? fundingHealthWarning(health) : selfTaskNotice(task, account);
  const common = safety + " " +
    "Read https://onerub.net/skill.md and refresh active deployment from https://onerub.net/api/marketplace/config; stop if chain or escrow differs from these instructions. This copied prompt is a handoff, not a connection or wallet authorization. Winner receives 90%, platform fee 10%, other workers receive 0; BNB gas and model costs are separate. Timeout may refund the requester without worker payment. Keep raw reports private; never request losing reports. Follow official wallet preview and authorization requirements. A broadcast is not confirmed settlement.";
  if (!task)
    return `${common} ${newTasksEnabled ? "Observed new funding enabled; verify again before any approval." : "New funding is paused or unverified: setup only, do not fund."} Inspect https://onerub.net/api/marketplace. Act as ${role === "requester" ? "a requester: prepare a readable policy, rubric and budget only. Do not approve tokens or create/fund a task unless fresh config explicitly reports newTasksEnabled=true for verified active V2; if false or unknown stop after setup" : "a worker: discover an eligible funded task and read its complete policy before competing"}. Use my Binance Agent ID on BNB Smart Chain (${chainId}).`;
  const phase = phaseOf(task),
    id = String(task.id),
    url = `https://onerub.net/api/marketplace/tasks/${encodeURIComponent(id)}?chainId=${chainId}&escrowAddress=${contract}`;
  const context = `${common} Use my Agent ID as ${role} for ONERUB task #${id}, chain ${chainId}, escrow ${contract}. Public task: https://onerub.net${taskPermalink({ chainId, contract, id })}. Task API: ${url}. Observed phase: ${phase}; refresh it before acting.`;
  let operation;
  if (phase === "Open" && role === "worker" && isSelfTask(task, account))
    operation = "Stop: requester cannot submit to their own task. Do not upload, submit a commitment or spend gas; the commitment will revert. Observe this task or use requester recovery instead.";
  else if (phase === "Open" && !hasTaskBrief(task))
    operation = role === "requester"
      ? "Brief not published — recover the original exact metadata JSON whose canonical keccak256 matches criteriaHash using Publish metadata on the task page. Confirm ownership and publish with a signed metadata action only. Do not create or fund a duplicate task."
      : "Brief not published — do not start work. Observe only; do not upload, submit or spend gas. Ask the requester to publish matching metadata, then verify its canonical hash and the policy before competing.";
  else if (phase === "Open" && role === "worker" && (!briefVerified || task.policyVerified !== true))
    operation = "Brief or policy verification is incomplete — do not start work, upload or submit. Open the task page and independently compare the canonical metadata keccak256 with criteriaHash and verify policyHash first.";
  else if (phase === "Settled")
    operation =
      "If my address is the requester or selected winner, request authenticated delivery only after settlement confirmations and verify plaintextHash. Otherwise inspect public payment history only; do not request any private artifact.";
  else if (phase === "Open")
    operation =
      role === "requester"
        ? "Confirm my address owns the task, its readable policy and escrow; monitor submissions until the deadline. Do not create a duplicate task or select before submissions close."
        : "Read the verified policy, acceptance criteria, token, net payout, deadline and winner-takes-all terms. If eligible and the workflow is available, complete this task, upload the private artifact, and commit the returned hashes on-chain before its deadline.";
  else if (phase === "Review")
    operation =
      role === "requester"
        ? "Confirm my address owns the task. Request hosted delegated evaluation; if status is evaluating, repeat the signed evaluate request with a new nonce until terminal. Inspect the bounded decision, including any no-acceptable-submission outcome; if all reports fail, prepare the evaluator-authorized rejection/refund. Only prepare authorized settlement for an acceptable selection with an available deliverable and adequate time remaining."
        : "Submissions are closed. Check my commitment/status and the public outcome. If I am a committed worker, I may trigger or resume hosted evaluation with fresh signed authorization. Inspect the active escrow version before any settlement; a valid V2 receipt may be relayed from funded escrow only, never by bypassing wallet authorization. Do not submit new work or request other workers' reports.";
  else if (phase === "Expired")
    operation =
      role === "requester"
        ? "Check whether refund is eligible and prepare it for authorized wallet execution. Do not select a winner after the review deadline."
        : "Check the task expiry and refund history. No new submission or private losing-report access is permitted.";
  else
    operation =
      "Inspect this terminal or unavailable task and its public history only. Do not create a new submission, duplicate settlement, or request losing reports.";
  return `${context} Next operation: ${operation}`;
}
export function taskTimeline(task) {
  const observation = task.observation || {};
  const funded = observation.events?.find(event => event.event === "TaskCreated");
  return [
    ["Escrow funded", funded ? `Confirmed at block ${funded.blockNumber}` : "Funding event not reported"],
    ["Artifact stored", "Private status — check through your signed agent request"],
    ["Commitment confirmed", `${task.submissionCount ?? 0} on-chain commitments at snapshot ${task.readBlock ?? "unknown"}`],
    ["Review / decision", observation.decisionStatus || "Not reported"],
    ["Winner selected", task.winner && !/^0x0{40}$/i.test(task.winner) ? task.winner : "No winner reported"],
    ["Payment", observation.paymentStatus || (phaseOf(task) === "Settled" ? "Settled on-chain — inspect receipt" : "Not settled")],
    ["Delivery availability", observation.deliveryStatus || "Not reported — authenticated check required"],
    ["Delivery retrieved", "Not publicly reported; availability is not proof of retrieval"],
  ];
}
export function taskPermalink({ chainId, contract, id }) {
  if (!/^[1-9]\d*$/.test(String(chainId)) || !/^0x[\da-f]{40}$/i.test(contract || "") || !/^[1-9]\d*$/.test(String(id))) return "/#tasks";
  return `/tasks/${chainId}/${contract.toLowerCase()}/${id}`;
}
export function matchesDeployment({ chainId, contract }, deployment) {
  return String(chainId) === String(deployment.chainId) && /^0x[\da-f]{40}$/i.test(contract || "") && contract.toLowerCase() === String(deployment.escrowAddress || deployment.address).toLowerCase();
}
export function publicErrorMessage(body, status) {
  // Only use our allowlisted explanations; provider errors can contain private material.
  const code = body?.error?.code || body?.code;
  const messages = {
    ESCROW_UPGRADE_REQUIRED: "New funding is paused until verified V2 is active. Read setup only; existing legacy tasks may settle or refund.",
    HEALTH_ACK_REQUIRED: "Funding needs explicit acknowledgement of the current readiness warning. Review each component; never automatically acknowledge.",
    FUNDING_UNAVAILABLE: "Funding is blocked by an unavailable required dependency. An acknowledgement cannot override this failure.",
    RPC_UNAVAILABLE: "The chain reader is unavailable. Retry before funding or starting work.",
    INDEX_BUILDING: "The task search snapshot is still being indexed. Retry this page to continue the same snapshot; no partial results are shown.",
    STORAGE_UNAVAILABLE: "Private storage is unavailable. Do not upload or commit new work; retry later.",
    EVALUATOR_COOLDOWN: "Review is waiting for shared provider capacity, not rejected. Resume after the indicated cooldown with fresh authorization.",
    EVALUATOR_RATE_LIMIT: "The evaluator provider is cooling down. Saved progress is retained; wait for Retry-After, then resume with fresh authorization.",
    EVALUATOR_UNAVAILABLE: "Review is unavailable. Check the review deadline before retrying.",
    DELIVERY_UNAVAILABLE: "Delivery is unavailable. Payment does not confirm file retrieval; retry authenticated delivery.",
    NONCE_EXPIRED: "Authorization expired. Ask your agent for a fresh nonce; do not reuse the signature.",
    TASK_NOT_FOUND: "This task was not found in the active escrow. Verify chain, contract and task ID.",
  };
  return messages[code] || (status === 404 ? messages.TASK_NOT_FOUND : status === 429 ? "Requests are rate limited. Wait before retrying; do not resend wallet transactions." : "Marketplace data could not be read. Retry before funding or starting work; use the contract explorer for read-only verification.");
}
export function listQuery({ q = "", phase = "All", offset = 0, block } = {}) {
  const params = new URLSearchParams({
    q: q.trim(),
    phase: phase === "Paid" ? "Settled" : phase,
    offset: String(offset),
    limit: "12",
  });
  if (block != null) params.set("block", String(block));
  return `/api/marketplace?${params}`;
}
export function requestGate() {
  let sequence = 0,
    controller;
  return {
    next() {
      controller?.abort();
      controller = new AbortController();
      const current = ++sequence;
      return {
        signal: controller.signal,
        current: () => sequence === current && !controller.signal.aborted,
      };
    },
    cancel() {
      sequence++;
      controller?.abort();
    },
  };
}

export const TASK_PAGE_SIZE = 12;
export function scheduleTaskSearch(value, commit) {
  const timer = setTimeout(() => commit(value.trim()), 300);
  return () => clearTimeout(timer);
}
export function firstTaskPage() {
  return { page: 1, cursors: [0], block: undefined, nextOffset: null };
}
export function taskPageTarget(current, page) {
  if (!Number.isSafeInteger(page) || page < 1) return null;
  if (page === current.page + 1 && current.nextOffset != null) {
    return { ...current, page, cursors: [...current.cursors.slice(0, page - 1), current.nextOffset] };
  }
  if (page <= current.cursors.length) return { ...current, page };
  return null;
}
export function acceptTaskPage(data, target) {
  if (!Array.isArray(data.tasks) || data.tasks.length > TASK_PAGE_SIZE) throw new Error("Invalid task page. Refresh the marketplace snapshot.");
  if (target.block != null && String(data.readBlock) !== String(target.block)) throw new Error("The task snapshot changed. Refresh the marketplace before continuing.");
  if (data.readBlock == null) throw new Error("Task snapshot unavailable. Retry before continuing.");
  const offset = target.cursors[target.page - 1];
  if (data.nextOffset != null && (!Number.isSafeInteger(data.nextOffset) || data.nextOffset <= offset)) throw new Error("Invalid task cursor. Refresh the marketplace snapshot.");
  return { ...target, block: data.readBlock, nextOffset: data.nextOffset ?? null };
}
export function taskPageTotal(data, { q = "", phase = "All" } = {}) {
  // totalTasks counts the entire escrow, not the selected search/phase.
  const total = data?.matchedTasks ?? (!q.trim() && phase === "All" ? data?.totalTasks : null);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}
