// Node.js — versioned decision MACs are independent from short-lived auth challenges.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonical, hash, fail } from './marketplace-core.mjs';

function secret(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 32)
    fail('Decision verification key is unavailable. Restore its configured key ID; do not re-evaluate the saved verdict.', 503, 'DECISION_KEY_UNAVAILABLE');
  return value;
}
function active() {
  const id = process.env.MARKETPLACE_DECISION_KEY_ID;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id || ''))
    fail('A versioned decision key ID is required.', 503, 'DECISION_KEY_UNAVAILABLE');
  return { id, key: secret(process.env.MARKETPLACE_DECISION_KEY) };
}
function verificationKey(signed, now) {
  if (signed.authVersion === undefined && signed.authKeyId === undefined) {
    const until = Number(process.env.MARKETPLACE_DECISION_LEGACY_VERIFY_UNTIL);
    if (!Number.isSafeInteger(until) || until < now)
      fail('Legacy decision verification is disabled or expired.', 409, 'DECISION_KEY_UNAVAILABLE');
    return secret(process.env.MARKETPLACE_DECISION_LEGACY_KEY);
  }
  if (signed.authVersion !== 2 || !/^[a-zA-Z0-9_-]{1,64}$/.test(signed.authKeyId || ''))
    fail('Unsupported decision authentication version.', 409, 'DECISION_INVALID');
  if (signed.authKeyId === process.env.MARKETPLACE_DECISION_KEY_ID)
    return secret(process.env.MARKETPLACE_DECISION_KEY);
  let ring;
  try { ring = JSON.parse(process.env.MARKETPLACE_DECISION_KEYS_JSON || '{}'); } catch {
    fail('Decision verification keyring is invalid.', 503, 'DECISION_KEY_UNAVAILABLE');
  }
  const entry = ring && Object.hasOwn(ring, signed.authKeyId) ? ring[signed.authKeyId] : null;
  if (!entry || !Number.isSafeInteger(entry.verifyUntil) || entry.verifyUntil < now)
    fail('Decision verification key is retired or missing. Restore the authorized keyring; the verdict is not replaced.', 409, 'DECISION_KEY_UNAVAILABLE');
  return secret(entry.key);
}
export function attestDecision(content) {
  const { id, key } = active();
  const signed = { ...content, authVersion: 2, authKeyId: id };
  signed.decisionHash = hash(signed);
  return { ...signed, attestation: createHmac('sha256', key).update(canonical(signed)).digest('hex') };
}
export function verifyDecisionAuthentication(decision, now = Math.floor(Date.now() / 1000)) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision))
    fail('Evaluation attestation is invalid.', 409, 'DECISION_INVALID');
  const { attestation, ...signed } = decision;
  const { decisionHash, ...content } = signed;
  const expected = createHmac('sha256', verificationKey(signed, now)).update(canonical(signed)).digest();
  if (typeof attestation !== 'string' || !/^[a-f0-9]{64}$/.test(attestation) ||
      !timingSafeEqual(Buffer.from(attestation, 'hex'), expected) || hash(content) !== decisionHash)
    fail('Evaluation attestation is invalid.', 409, 'DECISION_INVALID');
  return decision;
}

// Resumable-review checkpoints are authenticated so a corrupted or tampered
// datastore record can never be promoted into a signed winning verdict. They
// never authorize a payout on their own.
function checkpointMacKey() {
  const { key } = active();
  return createHmac('sha256', key).update('onerub-evaluation-checkpoint-v1').digest();
}
export function attestCheckpoint(content) {
  const { id } = active();
  const body = { ...content, checkpointVersion: 1 };
  return {
    ...body,
    checkpointAuth: {
      keyId: id,
      mac: createHmac('sha256', checkpointMacKey()).update(canonical(body)).digest('hex'),
    },
  };
}
export function unsealCheckpoint(record) {
  // Any mismatch discards progress and restarts evaluation from the first
  // candidate; discarding can only cost work, never change who gets paid.
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const { checkpointAuth, ...body } = record;
  if (
    !checkpointAuth ||
    typeof checkpointAuth !== 'object' ||
    checkpointAuth.keyId !== process.env.MARKETPLACE_DECISION_KEY_ID
  )
    return null;
  try {
    const expected = createHmac('sha256', checkpointMacKey()).update(canonical(body)).digest();
    if (
      typeof checkpointAuth.mac !== 'string' ||
      !/^[a-f0-9]{64}$/.test(checkpointAuth.mac) ||
      !timingSafeEqual(Buffer.from(checkpointAuth.mac, 'hex'), expected)
    )
      return null;
  } catch {
    return null;
  }
  if (body.checkpointVersion !== 1 || !Array.isArray(body.scores)) return null;
  return body;
}
