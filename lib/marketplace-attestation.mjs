import { Wallet, ZeroAddress, ZeroHash, getAddress } from 'ethers';
import { artifactKey, deployment, fail, store } from './marketplace-core.mjs';
import { verifyDecision, validatedArtifact, retainArtifact, ensureReviewTime } from './marketplace-service.mjs';

export const UPLOAD_FIELDS = [
  { name: 'taskId', type: 'uint256' }, { name: 'worker', type: 'address' },
  { name: 'contentHash', type: 'bytes32' }, { name: 'artifactPtrHash', type: 'bytes32' },
  { name: 'size', type: 'uint32' }, { name: 'expiresAt', type: 'uint64' },
];
export const REVIEW_FIELDS = [
  { name: 'taskId', type: 'uint256' }, { name: 'winner', type: 'address' },
  { name: 'contentHash', type: 'bytes32' }, { name: 'artifactPtrHash', type: 'bytes32' },
  { name: 'candidatesHash', type: 'bytes32' }, { name: 'criteriaHash', type: 'bytes32' },
  { name: 'policyHash', type: 'bytes32' }, { name: 'expiresAt', type: 'uint64' },
  { name: 'accepted', type: 'bool' },
];
export const attestationDomain = (config = deployment) => ({ name: 'ONERUB Marketplace Escrow', version: '2', chainId: config.chainId, verifyingContract: config.address });
export function evaluatorSigner(config = deployment,task) {
  if(task?.evaluatorRevoked)fail('The task signer is permanently revoked; use the disclosed refund path.',409,'EVALUATOR_REVOKED');
  if(config.protocolRevision>=3&&(!task?.evaluatorSigner||task.evaluatorRevoked!==false))
    fail('Fresh per-task signer and revocation state are required.',503,'ATTESTATION_UNAVAILABLE');
  let signer;
  try {
    const expected=getAddress(task?.evaluatorSigner||config.evaluator);
    if(expected===ZeroAddress)throw Error();
    const ring=JSON.parse(process.env.MARKETPLACE_ATTESTATION_KEYS_JSON||'{}');
    if(!ring||typeof ring!=='object'||Array.isArray(ring)||Object.keys(ring).length>64)throw Error();
    const retained=new Map();
    for(const [address,key] of Object.entries(ring)){
      const normalized=getAddress(address).toLowerCase();
      if(normalized===ZeroAddress||retained.has(normalized)||typeof key!=='string')throw Error();
      const candidate=new Wallet(key);
      if(candidate.address.toLowerCase()!==normalized)throw Error();
      retained.set(normalized,candidate);
    }
    const active=process.env.MARKETPLACE_ATTESTATION_KEY?new Wallet(process.env.MARKETPLACE_ATTESTATION_KEY):null;
    signer=active?.address===expected?active:retained.get(expected.toLowerCase());
    if(!signer||signer.address!==expected)throw Error();
  } catch { fail('Evaluator attestation signer or keyring is unavailable or inconsistent.',503,'ATTESTATION_UNAVAILABLE'); }
  return signer;
}
export async function signUploadReceipt(task, worker, { storage = store, config = deployment } = {}) {
  if(task.phase!=='Open')fail('Submissions are closed.',409,'SUBMISSIONS_CLOSED');
  const signer=evaluatorSigner(config,task);
  const r=await retainArtifact(task,worker,storage);
  validatedArtifact(r,task.id,worker,{exists:true,contentHash:r.contentHash,artifactPtrHash:r.artifactPtrHash});
  const expiresAt = Math.min(Number(task.submissionDeadline), Math.floor(Date.now() / 1000) + 900);
  const receipt = { taskId: String(task.id), worker, contentHash: r.contentHash, artifactPtrHash: r.artifactPtrHash, size: r.size, expiresAt };
  return { ...receipt, signature: await signer.signTypedData(attestationDomain(config), { UploadReceipt: UPLOAD_FIELDS }, receipt) };
}
export async function signReviewDecision(task, decision, { storage = store, config = deployment } = {}) {
  if(task.phase!=='Review')fail('Task is not in review.',409,'DECISION_INVALID');
  verifyDecision(decision,task,{config});
  ensureReviewTime(task);
  const signer=evaluatorSigner(config,task);
  const accepted=decision.outcome==='winner';
  const r=accepted?await retainArtifact(task,decision.winner,storage):null;
  if(accepted){
    const committed=decision.commitments.find(c=>c.worker.toLowerCase()===decision.winner.toLowerCase());
    if(!committed||committed.contentHash!==r.contentHash||committed.plaintextHash!==r.plaintextHash||
       committed.artifactPtrHash&&committed.artifactPtrHash!==r.artifactPtrHash)
      fail('Winning work changed after evaluation.',409,'ARTIFACT_MISMATCH');
    validatedArtifact(r,task.id,decision.winner,{exists:true,contentHash:committed.contentHash,artifactPtrHash:committed.artifactPtrHash||r.artifactPtrHash});
  }
  if (!task.candidatesHash) fail('Candidate commitment snapshot is unavailable.', 409, 'DECISION_INVALID');
  const receipt = { taskId: String(task.id), winner: accepted ? decision.winner : ZeroAddress,
    contentHash: r?.contentHash || ZeroHash, artifactPtrHash: r?.artifactPtrHash || ZeroHash,
    candidatesHash: task.candidatesHash, criteriaHash: task.criteriaHash, policyHash: task.policyHash,
    expiresAt: Math.min(Number(task.reviewDeadline), Math.floor(Date.now() / 1000) + 300), accepted: Boolean(accepted) };
  return { ...receipt, signature: await signer.signTypedData(attestationDomain(config), { ReviewDecision: REVIEW_FIELDS }, receipt) };
}
