// Node.js — generate a public OpenAPI contract from the runtime metadata limits and examples.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ACTION_CONTRACT, METADATA_FIELDS, METADATA_EXAMPLE } from '../lib/marketplace-action-contract.mjs';
const address = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, digest = { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' };
const ref = name => ({ $ref: '#/components/schemas/' + name });
export function buildMarketplaceContract() {
  const scope = { chainId: { type: 'integer', const: 56 }, escrowAddress: address };
  const metadata = { type: 'object', required: METADATA_FIELDS.map(([k]) => k), properties: Object.fromEntries(METADATA_FIELDS.map(([k, minLength, maxLength]) => [k, { type: 'string', minLength, maxLength }])), additionalProperties: false, example: METADATA_EXAMPLE };
  const auth = { type: 'object', required: ['address','action','taskId','payloadHash','nonce','expiresAt','challenge','signature'], properties: { address, action: { enum: ['metadata','upload','receipt','evaluate','delivery'] }, taskId: { type: 'string', pattern: '^[1-9][0-9]*$' }, payloadHash: digest, nonce: digest, expiresAt: { type: 'integer' }, challenge: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{128,132}$' }, typedData: { type: 'object' } } };
  const signed = payload => ({ type: 'object', required: ['chainId','escrowAddress','auth','payload'], properties: { ...scope, auth: ref('Authorization'), payload } });
  const empty = { type: 'object', maxProperties: 0 };
  const schemas = {
    Metadata: metadata, Authorization: auth,
    ChallengeRequest: { type: 'object', required: ['chainId','escrowAddress','address','action','taskId','payloadHash'], properties: { ...scope, address, action: auth.properties.action, taskId: auth.properties.taskId, payloadHash: digest } },
    MetadataRequest: signed({ oneOf: [{ type: 'object', required: ['metadata'], properties: { metadata: ref('Metadata') }, additionalProperties: false }, ref('Metadata')] }),
    UploadRequest: signed({ type: 'object', required: ['filename','mimeType','contentBase64'], properties: { filename: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_. -]{1,100}$' }, mimeType: { enum: ['text/plain','text/markdown','application/json'] }, contentBase64: { type: 'string', contentEncoding: 'base64', description: 'Decoded strict UTF8, 10 bytes through 512 KiB; declared JSON must parse.' } } }),
    EmptyActionRequest: signed(empty),
    PrepareRequest: { type: 'object', required: ['chainId','escrowAddress','action'], properties: { ...scope, action: { enum: ['approve','createAndFund','submitCommitment','selectWinner','rejectAll','cancel','refund'] }, taskId: auth.properties.taskId, amount: { type: 'string', description: 'Human-readable token units, token decimals from deployment (USDC18).' }, metadata: ref('Metadata'), policy: { type: 'object' }, submissionDeadline: { type: 'integer', description: 'Unix seconds UTC' }, reviewDeadline: { type: 'integer', description: 'Unix seconds UTC' }, worker: address, healthAcknowledgement: { type: 'object', required: ['accepted','token','expiresAt'], properties: { accepted: { const: true }, token: { type: 'string', pattern: '^[0-9a-f]{64}$' }, expiresAt: { type: 'integer' } } } } }
  };
  const post = (name, description) => ({ description, requestBody: { required: true, content: { 'application/json': { schema: ref(name) } } }, responses: { 200: { description: 'Accepted response. Verify the returned commitments and public readback; not a transaction confirmation.' }, 400: { description: 'Malformed/invalid input; metadata validation does not consume its nonce.' }, 401: { description: 'Invalid signature/challenge/scope/expiry.' }, 403: { description: 'Wrong requester/worker or missing eligible Agent ID.' }, 409: { description: 'REPLAY, commitment mismatch, state conflict, or HEALTH_ACK_REQUIRED.' }, 429: { description: 'Rate limited. Honor Retry-After.' }, 503: { description: 'Unavailable dependency; inspect outcome/readback before retry.' } } });
  return { openapi: '3.1.0', info: { title: 'ONERUB Marketplace signed-action contract', version: '3.1.0' }, servers: [{ url: 'https://onerub.net' }], paths: {
    '/api/marketplace/auth/challenge': { post: post('ChallengeRequest', 'Hash the exact payload first. Read and confirm the returned EIP712 typed data through the official wallet.') },
    '/api/marketplace/prepare': { post: post('PrepareRequest', 'Unsigned preparation only; action-specific required fields and state checks apply. Funding requires explicit readiness acknowledgement when degraded, and cannot bypass fatal dependencies.') },
    ...Object.fromEntries(['metadata','upload','receipt','evaluate','delivery'].map(action => ['/api/marketplace/tasks/{id}/' + action, { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', pattern: '^[1-9][0-9]*$' } }], post: post(action === 'metadata' ? 'MetadataRequest' : action === 'upload' ? 'UploadRequest' : 'EmptyActionRequest', ACTION_CONTRACT[action].retry ? JSON.stringify(ACTION_CONTRACT[action].retry) : '') }]))
  }, components: { schemas }, 'x-runtime-action-contract': ACTION_CONTRACT, 'x-signature-rule': 'payloadHash=keccak256(UTF8(recursively-key-sorted compact JSON of EXACT payload)). Metadata criteriaHash hashes metadata alone, not its signed envelope. Never insert unsigned top-level metadata.', 'x-testing-boundary': 'Signed real HTTP tests and funded local Anvil regressions, not proof of live worker payout or service availability.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  fs.writeFileSync(new URL('../public/marketplace-actions.json', import.meta.url), JSON.stringify(buildMarketplaceContract(), null, 2) + '\n');
  console.log('Generated public marketplace-actions.json from runtime fields/examples.');
}
