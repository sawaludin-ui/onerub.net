import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Wallet, keccak256 } from "ethers";
import {
  artifactKey,
  encryptArtifact,
  hash,
  issueChallenge,
  verifyAuthorization,
} from "../lib/marketplace-core.mjs";
import { deliverArtifact } from "../lib/marketplace-service.mjs";

process.env.MARKETPLACE_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.MARKETPLACE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
class MemoryStore {
  values = new Map();
  async get(key) {
    return this.values.get(key) || null;
  }
  async put(key, value, { nx = false } = {}) {
    if (nx && this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }
}
async function authorization(wallet, action, id, payload) {
  const challenge = issueChallenge({
    address: wallet.address,
    action,
    taskId: id,
    payloadHash: hash(payload),
  });
  const { domain, types, message } = challenge.typedData;
  return {
    ...challenge,
    signature: await wallet.signTypedData(
      domain,
      { Authorization: types.Authorization },
      message,
    ),
  };
}

test("agent signature binds action, task, body and the authenticated wallet", async () => {
  const wallet = Wallet.createRandom(),
    other = Wallet.createRandom(),
    payload = { filename: "report.md", contentBase64: "YWJj" };
  const auth = await authorization(wallet, "upload", "8", payload);
  const options = { storage: new MemoryStore(), eligible: async () => true };
  await assert.rejects(
    verifyAuthorization(auth, "delivery", "8", payload, options),
    /does not match/,
  );
  await assert.rejects(
    verifyAuthorization(auth, "upload", "9", payload, options),
    /does not match/,
  );
  await assert.rejects(
    verifyAuthorization(
      auth,
      "upload",
      "8",
      { ...payload, filename: "different.md" },
      options,
    ),
    /does not match/,
  );
  const { domain, types, message } = auth.typedData;
  const wrong = {
    ...auth,
    signature: await other.signTypedData(
      domain,
      { Authorization: types.Authorization },
      message,
    ),
  };
  await assert.rejects(
    verifyAuthorization(wrong, "upload", "8", payload, options),
    /address mismatch/,
  );
  assert.equal(
    await verifyAuthorization(auth, "upload", "8", payload, options),
    wallet.address,
  );
});

test("one signed request succeeds once under concurrent replay", async () => {
  const wallet = Wallet.createRandom(),
    payload = {};
  const auth = await authorization(wallet, "evaluate", "13", payload);
  const storage = new MemoryStore();
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      verifyAuthorization(auth, "evaluate", "13", payload, {
        storage,
        eligible: async () => true,
      }),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    attempts.filter(
      (r) => r.status === "rejected" && r.reason.code === "REPLAY",
    ).length,
    7,
  );
});

test("Agent ID eligibility is required even for a valid signed request", async () => {
  const wallet = Wallet.createRandom(),
    payload = {};
  const auth = await authorization(wallet, "delivery", "5", payload);
  await assert.rejects(
    verifyAuthorization(auth, "delivery", "5", payload, {
      storage: new MemoryStore(),
      eligible: async () => false,
    }),
    (e) => e.code === "AGENT_ID_REQUIRED",
  );
});

function deliveryFixture() {
  const requester = Wallet.createRandom().address,
    winner = Wallet.createRandom().address,
    loser = Wallet.createRandom().address;
  const task = {
    id: "21",
    requester,
    winner,
    phase: "Settled",
    readBlock: 5000,
  };
  const bytes = Buffer.from(
    "Private winning report: complete original content.",
  );
  const encrypted = encryptArtifact(bytes, artifactKey("21", winner));
  const artifact = {
    worker: winner,
    filename: "report.md",
    mimeType: "text/markdown",
    encrypted,
    plaintextHash: keccak256(bytes),
    size: bytes.length,
    contentHash: hash(encrypted),
    artifactPtrHash: hash("private-pointer"),
  };
  const storage = new MemoryStore();
  storage.values.set(artifactKey("21", winner), artifact);
  const readSubmission = async () => ({
    exists: true,
    contentHash: artifact.contentHash,
    artifactPtrHash: artifact.artifactPtrHash,
  });
  const readTask = async (id, options) => {
    assert.equal(id, "21");
    assert.equal(options.confirmations, 3);
    return task;
  };
  return {
    requester,
    winner,
    loser,
    task,
    artifact,
    bytes,
    storage,
    readTask,
    readSubmission,
  };
}

test("delivery waits for settled chain state and never releases to the losing worker", async () => {
  const f = deliveryFixture();
  f.task.phase = "Review";
  await assert.rejects(
    deliverArtifact("21", f.requester, f),
    (e) => e.code === "NOT_SETTLED",
  );
  f.task.phase = "Settled";
  await assert.rejects(
    deliverArtifact("21", f.loser, f),
    (e) => e.code === "FORBIDDEN",
  );
  const delivered = await deliverArtifact("21", f.requester, f);
  assert.deepEqual(Buffer.from(delivered.contentBase64, "base64"), f.bytes);
  assert.equal(delivered.winner, f.winner);
  assert.equal(delivered.confirmedAtBlock, 5000);
});

test("ciphertext tampering cannot pass a matching stored hash field", async () => {
  const f = deliveryFixture();
  const original = f.artifact.encrypted.ciphertext;
  const changed = Buffer.from(original, "base64");
  changed[0] ^= 1;
  f.artifact.encrypted.ciphertext = changed.toString("base64");
  await assert.rejects(
    deliverArtifact("21", f.requester, f),
    (e) => e.code === "ARTIFACT_MISMATCH",
  );
});

test("uncommitted winning content is never released", async () => {
  const f = deliveryFixture();
  f.readSubmission = async () => ({ exists: false });
  await assert.rejects(
    deliverArtifact("21", f.requester, f),
    (e) => e.code === "ARTIFACT_MISMATCH",
  );
});
