import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildMarketplaceContract } from '../scripts/generate-marketplace-contract.mjs';
import { METADATA_EXAMPLE, METADATA_FIELDS } from '../lib/marketplace-action-contract.mjs';
import { sanitizeMetadata, hash } from '../lib/marketplace-core.mjs';
test('published machine-readable action contract is generated from runtime limits/examples without drift', () => {
  const current = JSON.parse(fs.readFileSync(new URL('../public/marketplace-actions.json', import.meta.url)));
  assert.deepEqual(current, buildMarketplaceContract());
  assert.deepEqual(sanitizeMetadata(current.components.schemas.Metadata.example), METADATA_EXAMPLE);
  for (const [key,min,max] of METADATA_FIELDS) assert.deepEqual([current.components.schemas.Metadata.properties[key].minLength,current.components.schemas.Metadata.properties[key].maxLength],[min,max]);
  assert.notEqual(hash(METADATA_EXAMPLE),hash({metadata:METADATA_EXAMPLE}));
  for (const action of ['metadata','upload','receipt','evaluate','delivery']) assert.ok(current.paths['/api/marketplace/tasks/{id}/'+action].post.requestBody);
});
test('handbook documents exact metadata envelope, signature-binding safe retries and readiness acknowledgement', () => {
  const text = fs.readFileSync(new URL('../public/skill.md',import.meta.url),'utf8');
  assert.ok(text.includes('version: 3.1.0')); assert.ok(text.includes('const payload = { metadata: originalMetadata };'));
  for (const phrase of ['HEALTH_ACK_REQUIRED','FUNDING_UNAVAILABLE','METADATA_FIELD_INVALID','metadataHash','policyVerified','at most twice','payloadHash, so obtain matching new authorization']) {
    assert.ok(text.includes(phrase),phrase);
  }
});
