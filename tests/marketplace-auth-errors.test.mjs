import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  hash,
  issueChallenge,
  verifyAuthorization,
} from "../lib/marketplace-core.mjs";

process.env.MARKETPLACE_AUTH_SECRET =
  "test-only-auth-secret-with-at-least-thirty-two-characters";
async function signed() {
  const wallet = Wallet.createRandom(),
    payload = {};
  const c = issueChallenge({
    address: wallet.address,
    action: "receipt",
    taskId: "1",
    payloadHash: hash(payload),
  });
  return {
    ...c,
    signature: await wallet.signTypedData(
      c.typedData.domain,
      { Authorization: c.typedData.types.Authorization },
      c.typedData.message,
    ),
  };
}
const options = {
  storage: { put: async () => true },
  eligible: async () => true,
};
test("malformed authentication encoding fails with401, not a server exception", async () => {
  const valid = await signed();
  for (const bad of [
    { ...valid, challenge: {} },
    { ...valid, challenge: "f" },
    { ...valid, signature: null },
    { ...valid, signature: "not-hex" },
  ])
    await assert.rejects(
      verifyAuthorization(bad, "receipt", "1", {}, options),
      (e) => e.status === 401,
    );
});
test("expired and future authorization windows are rejected before wallet use", async () => {
  const auth = await signed();
  await assert.rejects(
    verifyAuthorization(
      auth,
      "receipt",
      "1",
      {},
      { ...options, now: auth.expiresAt + 1 },
    ),
    (e) => e.status === 401,
  );
  await assert.rejects(
    verifyAuthorization(
      auth,
      "receipt",
      "1",
      {},
      { ...options, now: auth.expiresAt - 301 },
    ),
    (e) => e.status === 401,
  );
});
