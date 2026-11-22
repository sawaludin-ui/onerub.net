// Node.js — preserve pre-existing resumable-review authentication dependency in this release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { attestCheckpoint, unsealCheckpoint } from '../lib/marketplace-decision-auth.mjs';
test('saved review checkpoint rejects missing MAC, score/cursor tampering and key changes', () => {
 const oldId=process.env.MARKETPLACE_DECISION_KEY_ID,oldKey=process.env.MARKETPLACE_DECISION_KEY;
 try {
  process.env.MARKETPLACE_DECISION_KEY_ID='metadata-release-local-test';process.env.MARKETPLACE_DECISION_KEY=randomBytes(32).toString('hex');
  const content={taskId:'1',cursor:1,processed:1,total:2,scores:[{worker:'0x'+'a'.repeat(40),score:20,acceptable:false}]},sealed=attestCheckpoint(content);
  assert.equal(unsealCheckpoint(sealed).scores[0].score,20);
  const missing=structuredClone(sealed);delete missing.checkpointAuth;assert.equal(unsealCheckpoint(missing),null);
  const changed=structuredClone(sealed);changed.scores[0].score=100;changed.scores[0].acceptable=true;assert.equal(unsealCheckpoint(changed),null);
  assert.equal(unsealCheckpoint({...sealed,cursor:2,processed:2}),null);
  process.env.MARKETPLACE_DECISION_KEY=randomBytes(32).toString('hex');assert.equal(unsealCheckpoint(sealed),null);
 } finally {if(oldId===undefined)delete process.env.MARKETPLACE_DECISION_KEY_ID;else process.env.MARKETPLACE_DECISION_KEY_ID=oldId;if(oldKey===undefined)delete process.env.MARKETPLACE_DECISION_KEY;else process.env.MARKETPLACE_DECISION_KEY=oldKey;}
});
