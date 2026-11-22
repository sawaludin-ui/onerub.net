// Browser/server/CLI: only public JSON manifests and ABI data belong here.
import legacyManifest from './marketplace-deployment.json' with { type: 'json' };
import v2Manifest from './marketplace-v2-deployment.json' with { type: 'json' };
import legacyAbi from './marketplace-abi.json' with { type: 'json' };
import v2Abi from './marketplace-v2-abi.json' with { type: 'json' };

const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
const digest = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const positive = value => Number.isSafeInteger(value) && value > 0;
export const REQUIRED_PROTOCOL_REVISION = 3;
export function validateDeploymentManifest(manifest, version = manifest?.version || 1) {
  if (!manifest || manifest.chainId !== 56 || ![1, 2].includes(version) ||
      !['address', 'registry', 'treasury', 'token'].every(key => address(manifest[key])) ||
      !positive(manifest.blockNumber) || !digest(manifest.transactionHash)) return false;
  const read = manifest.readBack;
  if (!read || !same(read.agentId, manifest.registry) || !same(read.treasury, manifest.treasury) ||
      read.usdcAllowed !== true || String(read.feeBps) !== '1000') return false;
  if (version === 1) return manifest.contract === 'OneRubMarketplaceEscrow' && (manifest.version === undefined || manifest.version === 1);
  const proof = manifest.verification;
  return manifest.version === 2 && manifest.contract === 'OneRubMarketplaceEscrowV2' &&
    manifest.protocolRevision === REQUIRED_PROTOCOL_REVISION && address(manifest.evaluator) &&
    same(read.evaluator, manifest.evaluator) && String(read.minReviewSeconds) === '3600' &&
    String(read.protocolRevision) === String(REQUIRED_PROTOCOL_REVISION) && String(read.minimumValidSubmissions) === '1' && read.evaluatorRevoked === false &&
    proof?.status === 'verified' && proof.source === 'sourcify' &&
    proof.protocolRevision === REQUIRED_PROTOCOL_REVISION && proof.chainId === manifest.chainId &&
    same(proof.address, manifest.address) && same(proof.transactionHash, manifest.transactionHash) &&
    proof.blockNumber === manifest.blockNumber && digest(proof.runtimeCodeHash) &&
    proof.creationMatch === 'exact_match' && proof.runtimeMatch === 'exact_match';
}
function publicDeployment(manifest, version) {
  // Allowlist deliberately excludes accidental credential/provider fields in manifests.
  const out = Object.fromEntries(['chainId', 'contract', 'address', 'registry', 'treasury', 'token',
    'evaluator', 'deployer', 'blockNumber', 'transactionHash', 'deployedWib', 'compiler', 'protocolRevision']
    .filter(key => typeof manifest[key] === 'string' || (typeof manifest[key] === 'number' && Number.isSafeInteger(manifest[key])))
    .map(key => [key, manifest[key]]));
  return Object.freeze({ ...out, version, abiVersion: version, escrowAddress: manifest.address,
    agentRegistry: manifest.registry, namespace: String(manifest.chainId) + ':' + manifest.address.toLowerCase(),
    explorer: 'https://bscscan.com/address/' + manifest.address,
    newTasksEnabled: version === 2,
    verified: version === 2, verificationStatus: version === 2 ? 'verified-manifest' : 'legacy-readback',
    runtimeCodeHash: version === 2 ? manifest.verification.runtimeCodeHash : null,
    compatibility: version === 2 ? 'receipt-gated-v2' : 'legacy-v1-requester-settlement' });
}
export function resolveMarketplaceDeployment({ v1Manifest = legacyManifest, v2Manifest: candidate = v2Manifest } = {}) {
  if (validateDeploymentManifest(candidate, 2)) return publicDeployment(candidate, 2);
  if (!validateDeploymentManifest(v1Manifest, 1)) throw new Error('No validated marketplace deployment is available.');
  return publicDeployment(v1Manifest, 1);
}
export const ACTIVE_MARKETPLACE_DEPLOYMENT = resolveMarketplaceDeployment();
export const MARKETPLACE_ABI = ACTIVE_MARKETPLACE_DEPLOYMENT.version === 2 ? v2Abi : legacyAbi;
export const marketplaceAbiFor = version => {
  if (![1, 2].includes(version)) throw new Error('Unsupported marketplace ABI version.');
  return version === 2 ? v2Abi : legacyAbi;
};
export function marketplaceTaskIdentity(taskId, deployment = ACTIVE_MARKETPLACE_DEPLOYMENT) {
  const id = String(taskId);
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new Error('Invalid marketplace task ID.');
  return { chainId: deployment.chainId, escrowAddress: deployment.address, taskId: id,
    key: deployment.namespace + ':' + id,
    path: '/tasks/' + deployment.chainId + '/' + deployment.address + '/' + id };
}
