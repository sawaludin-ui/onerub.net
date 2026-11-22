import test from 'node:test';
import assert from 'node:assert/strict';
import { SUBMISSION_START, SUBMISSION_END, firstBlockAt, distinctInteractions, summarizeEvidence } from '../lib/hackathon-evidence.mjs';
const a='0x1111111111111111111111111111111111111111',b='0x2222222222222222222222222222222222222222',c='0x3333333333333333333333333333333333333333';
const tx='0x'+'01'.repeat(32);
const record=(extra={})=>({contract:a,from:b,transactionHash:tx,status:1,timestamp:SUBMISSION_START,...extra});
test('campaign times convert to 15:00 WIB and end is exclusive',()=>{
 assert.equal(new Date(SUBMISSION_START*1000).toISOString(),'2026-11-18T08:00:00.000Z');
 assert.equal(new Date(SUBMISSION_END*1000).toISOString(),'2026-12-09T08:00:00.000Z');
 assert.equal(distinctInteractions([record({timestamp:SUBMISSION_START-1}),record(),record({timestamp:SUBMISSION_END})]).length,1);
});
test('deduplicate logs and wallets across contracts without counting recipients',()=>{
 const out=summarizeEvidence([record(),record(),record({contract:c})],{[b.toLowerCase()]:{holder:true}},[a,c]);
 assert.equal(out.uniqueInteractingAddresses,1);assert.equal(out.uniqueCurrentHolders,1);
 assert.equal(out.observedSuccessfulTransactions,1);assert.equal(out.observedContractInteractions,2);
 assert.equal(out.participants[0].transactionCount,1);assert.deepEqual(out.participants[0].contracts,[a,c]);
 assert.equal(out.eligibilityConfirmed,false);assert.equal(out.organizerSubmissionConfirmed,false);
});
test('failed transactions and unverified holders never satisfy threshold',()=>{
 const out=summarizeEvidence([record({status:0}),record()],{},[a]);
 assert.equal(out.uniqueCurrentHolders,0);assert.equal(out.unverifiedHolderAddresses,1);
 assert.equal(out.participants[0].holderAtSnapshot,null);
 assert.throws(()=>distinctInteractions([record({transactionHash:'bad'})]),/transaction hash/);
});
test('binary search locates first block at or after timestamp',async()=>{
 const provider={getBlock:async n=>({timestamp:100+n*3})};
 assert.equal(await firstBlockAt(provider,110,20),4);assert.equal(await firstBlockAt(provider,112,20),4);
 await assert.rejects(firstBlockAt({getBlock:async()=>null},110,20),/history unavailable/);
});
