import { Interface, parseUnits } from "ethers";
import {
  MarketplaceError,
  address,
  capabilities,
  deployment,
  fail,
  getTask,
  hash,
  issueChallenge,
  limitations,
  listTasks,
  marketplaceInterface,
  sanitizeMetadata,
  store,
  taskId,
  verifyAuthorization,
} from "./marketplace-core.mjs";
import {
  deliverArtifact,
  enrichTask,
  evaluateTask,
  getArtifactReceipt,
  prepareWinner,
  registerMetadata,
  uploadArtifact,
} from "./marketplace-service.mjs";
const token = { address: deployment.token, symbol: "USDC", decimals: 18 };
const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export async function readBody(req) {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    fail("Use application/json.", 415);
  const max = 760000;
  if (Number(req.headers.get("content-length")) > max)
    fail("Request exceeds 760000 bytes.", 413);
  const reader = req.body?.getReader();
  if (!reader) fail("JSON body required.");
  let size = 0,
    chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        fail("Request body too large.", 413);
      }
      chunks.push(value);
    }
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      fail("JSON object required.");
    return body;
  } catch (e) {
    if (e instanceof MarketplaceError) throw e;
    fail("Invalid JSON body.");
  } finally {
    reader.releaseLock();
  }
}
export async function handle(fn) {
  try {
    return json(await fn());
  } catch (e) {
    if (e instanceof MarketplaceError)
      return json({ error: e.message, code: e.code }, e.status);
    return json(
      {
        error: "Marketplace request failed. Please retry.",
        code: "SERVICE_UNAVAILABLE",
      },
      503,
    );
  }
}
export async function publicList(req) {
  const u = new URL(req.url);
  const rawOffset = u.searchParams.get("offset") || "0",
    rawLimit = u.searchParams.get("limit") || "24";
  if (!/^\d{1,7}$/.test(rawOffset) || !/^\d{1,2}$/.test(rawLimit))
    fail("Invalid pagination.");
  const offset = Number(rawOffset),
    limit = Number(rawLimit);
  if (limit < 1 || limit > 48) fail("limit must be 1–48.");
  const result = await listTasks({ offset, limit });
  result.tasks = await Promise.all(
    result.tasks.map((t) =>
      enrichTask(t).catch(() => ({
        ...t,
        metadata: null,
        amountUnavailable: t.status !== 1,
      })),
    ),
  );
  return {
    chainId: 56,
    contract: deployment.address,
    token,
    feeBps: 1000,
    ...result,
    capabilities: capabilities(),
    limitations,
  };
}
export async function publicTask(id) {
  return {
    chainId: 56,
    contract: deployment.address,
    token,
    task: await enrichTask(await getTask(id)),
    capabilities: capabilities(),
    limitations,
  };
}
export async function challenge(req) {
  if (!capabilities().authentication)
    fail(
      "Agent authentication storage is not configured.",
      503,
      "AUTH_UNAVAILABLE",
    );
  const body = await readBody(req);
  await store.limit(
    "challenge:" +
      hash(req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown"),
    60,
    60,
  );
  return issueChallenge(body);
}
export async function privateAction(req, id, action) {
  id = taskId(id);
  if (!capabilities().privateStorage)
    fail("Private storage is not configured.", 503, "STORAGE_UNAVAILABLE");
  const { auth, payload } = await readBody(req);
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    fail("payload object is required.");
  const who = await verifyAuthorization(auth, action, id, payload);
  await store.limit("action:" + who.toLowerCase(), 60, 60);
  if (action === "receipt") return getArtifactReceipt(id, who);
  if (action === "metadata") return registerMetadata(id, who, payload);
  if (action === "upload") return uploadArtifact(id, who, payload);
  if (action === "evaluate") return evaluateTask(id, who);
  if (action === "delivery") return deliverArtifact(id, who);
  fail("Unsupported action.");
}
export async function prepare(req) {
  const p = await readBody(req);
  const action = p.action;
  let to = deployment.address,
    args,
    method;
  if (action === "createAndFund") {
    const metadata = sanitizeMetadata(p.metadata);
    let bounty;
    try {
      bounty = parseUnits(String(p.amount), 18);
    } catch {
      fail("Invalid USDC amount.");
    }
    if (bounty < 10n) fail("Bounty is too small.");
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(p.submissionDeadline) ||
      p.submissionDeadline <= now + 60 ||
      !Number.isSafeInteger(p.reviewDeadline) ||
      p.reviewDeadline <= p.submissionDeadline
    )
      fail("Invalid submission/review deadlines.");
    if (!/^0x[\da-f]{64}$/i.test(p.policyHash || ""))
      fail("policyHash is required.");
    method = "createAndFund";
    args = [
      deployment.token,
      bounty,
      hash(metadata),
      p.submissionDeadline,
      p.reviewDeadline,
      p.policyHash,
    ];
  } else if (action === "approve") {
    let amount;
    try {
      amount = parseUnits(String(p.amount), 18);
    } catch {
      fail("Invalid amount.");
    }
    if (amount <= 0n) fail("Amount must be positive.");
    return {
      chainId: 56,
      to: deployment.token,
      value: "0",
      data: new Interface([
        "function approve(address,uint256)",
      ]).encodeFunctionData("approve", [deployment.address, amount]),
      warning:
        "Unsigned exact-amount approval. Confirm token, spender, amount, and gas in the wallet.",
    };
  } else {
    const id = taskId(p.taskId);
    const t = await getTask(id);
    if (action === "submitCommitment") {
      address(p.worker);
      const record = await store.get(
        `artifact:${id}:${p.worker.toLowerCase()}`,
      );
      if (!record) fail("Upload the private artifact first.", 409);
      if (t.phase !== "Open") fail("Submissions are closed.", 409);
      method = action;
      args = [id, record.contentHash, record.artifactPtrHash];
    } else if (action === "selectWinner") {
      if (t.phase !== "Review") fail("Task is not in review.", 409);
      const decision = await prepareWinner(id);
      method = action;
      args = [id, decision.winner];
    } else if (["cancel", "refund"].includes(action)) {
      method = action;
      args = [id];
    } else fail("Unsupported transaction action.");
  }
  return {
    chainId: 56,
    to,
    value: "0",
    data: marketplaceInterface.encodeFunctionData(method, args),
    action: method,
    warning:
      "Unsigned transaction only. The wallet must preview and authorize it; this API never signs or broadcasts.",
  };
}
