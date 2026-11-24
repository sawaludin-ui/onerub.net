import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, toQuantity, toBeHex } from 'ethers';
import { createPublicEventIndex } from '../lib/marketplace-event-index.mjs';
const Q = '0x' + '33'.repeat(20), HASH = '0x' + 'ab'.repeat(32);
const iface = new Interface(['event TaskCreated(uint256 indexed taskId,address indexed requester,address token,uint256 bounty,uint64 submissionDeadline,uint64 reviewDeadline,bytes32 criteriaHash,bytes32 policyHash)']);
function memory() {
 const map = new Map();
 return { async get(k) { return structuredClone(map.get(k) ?? null); },
  async getMany(keys) { return keys.map(k => structuredClone(map.get(k) ?? null)); },
  async commit(expected, next, changes) {
   if (JSON.stringify(map.get('public-events:v1:manifest') ?? null) !== JSON.stringify(expected)) return false;
   for (const [k, v] of Object.entries(changes)) map.set(k, structuredClone(v));
   map.set('public-events:v1:manifest', structuredClone(next)); return true;
  } };
}
test('raw block quantity uses canonical hex without leading zero digits', async () => {
 // 135022755 is 0x80c2193; toBeHex pads to 0x080c2193 which strict BSC nodes reject (-32602).
 const odd = 135022755;
 // ethers pads to an even number of digits; the canonical JSON-RPC quantity does not.
 assert.match(toBeHex(odd), /^0x0/);
 assert.equal(toQuantity(odd), '0x' + odd.toString(16));
 assert.doesNotMatch(toQuantity(odd), /^0x0/);
 const asked = [];
 const provider = {
  async send(method, params) {
   assert.equal(method, 'eth_getBlockByNumber');
   const quantity = params[0];
   if (!/^0x([1-9a-f][0-9a-f]*|0)$/.test(quantity)) throw new Error('unmarshalerDecoder: hex number with leading zero digits');
   asked.push(quantity);
   const number = Number(BigInt(quantity));
   return { number, hash: '0x' + number.toString(16).padStart(64, '0') };
  },
  async getLogs(filter) {
   assert.ok(/^0x[1-9a-f]/.test(toQuantity(filter.fromBlock)) || filter.fromBlock === 0);
   return [];
  },
 };
 const index = createPublicEventIndex({ storage: memory(), provider, parseLog: l => iface.parseLog(l), deployment: { address: Q, blockNumber: odd }, range: 2000 });
 const result = await index.advance(odd + 2000);
 assert.ok(['ready', 'building'].includes(result.status));
 assert.ok(asked.length >= 1);
 assert.ok(asked.every(q => !/^0x0/.test(q)), JSON.stringify(asked));
});
