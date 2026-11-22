// Browser-safe metadata commitment and explicit EIP-712 authorization helpers.
import { keccak256, toUtf8Bytes, getAddress, Signature, verifyTypedData } from 'ethers';
import { METADATA_FIELDS } from './marketplace-action-contract.mjs';

const fail = (code, field) => { throw Object.assign(new Error(code), { code, field }); };
const throwIfAborted = signal => {
  if (signal?.aborted) throw signal.reason || new DOMException('Request aborted.', 'AbortError');
};
export const canonicalMetadataJSON = (value) => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonicalMetadataJSON(v)))
    : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonicalMetadataJSON(value[k]))])) : value);
export const metadataHash = value => keccak256(toUtf8Bytes(canonicalMetadataJSON(value)));
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function validateOriginalMetadata(text, criteriaHash) {
  if (typeof text !== 'string' || text.length > 100000) fail('METADATA_SIZE', 'metadata');
  let metadata; try { metadata = JSON.parse(text); } catch { fail('METADATA_JSON', 'metadata'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('METADATA_REQUIRED', 'metadata');
  const fields = METADATA_FIELDS;
  if (Object.keys(metadata).some(k => !fields.some(([name]) => name === k))) fail('METADATA_FIELDS', 'metadata');
  for (const [key,min,max] of fields) if (typeof metadata[key] !== 'string' || metadata[key].length < min || metadata[key].length > max) fail('METADATA_FIELD_INVALID', key);
  const hash = metadataHash(metadata);
  if (!/^0x[0-9a-f]{64}$/i.test(criteriaHash || '') || hash.toLowerCase() !== criteriaHash.toLowerCase()) fail('CRITERIA_HASH_MISMATCH', 'metadata');
  return { metadata, hash, canonical: canonicalMetadataJSON(metadata), payload: { metadata }, payloadHash: metadataHash({ metadata }) };
}
export function deploymentScope(chainId, escrowAddress) {
  if (Number(chainId) !== 56) fail('WRONG_CHAIN', 'chainId');
  let escrow; try { escrow = getAddress(escrowAddress); } catch { fail('INVALID_DEPLOYMENT', 'escrowAddress'); }
  if (/^0x0{40}$/i.test(escrow)) fail('INVALID_DEPLOYMENT', 'escrowAddress');
  return { chainId: 56, escrowAddress: escrow };
}
export async function connectMetadataWallet(provider, requester) {
  if (!provider?.request) fail('WALLET_UNAVAILABLE');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const account = accounts?.[0];
  if (!sameAddress(account, requester)) fail('REQUESTER_ONLY', 'address');
  if (Number(await provider.request({ method: 'eth_chainId' })) !== 56) fail('WRONG_CHAIN', 'chainId');
  return getAddress(account);
}
const authFields = [
  {name:'address',type:'address'},{name:'action',type:'string'},{name:'taskId',type:'uint256'},
  {name:'payloadHash',type:'bytes32'},{name:'nonce',type:'bytes32'},{name:'expiresAt',type:'uint256'},{name:'audience',type:'string'},
];
export function validateMetadataChallenge(challenge, { task, chainId, escrowAddress, payloadHash }, now = Math.floor(Date.now()/1000)) {
  const scope = deploymentScope(chainId, escrowAddress);
  if (Number.isSafeInteger(challenge?.expiresAt) && challenge.expiresAt <= now) fail('CHALLENGE_EXPIRED');
  if (!challenge || !sameAddress(challenge.address, task.requester) || challenge.action !== 'metadata' ||
      String(challenge.taskId) !== String(task.id) || challenge.payloadHash !== payloadHash ||
      !/^0x[0-9a-f]{64}$/i.test(challenge.nonce || '') || !/^[0-9a-f]{64}$/i.test(challenge.challenge || '') ||
      !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= now || challenge.expiresAt > now+360) fail('INVALID_CHALLENGE');
  const expected = { domain:{name:'ONERUB Marketplace',version:'1',chainId:56,verifyingContract:scope.escrowAddress},
    primaryType:'Authorization', types:{Authorization:authFields},
    message:{address:challenge.address,action:'metadata',taskId:challenge.taskId,payloadHash,nonce:challenge.nonce,expiresAt:challenge.expiresAt,audience:'onerub.net'} };
  const typed = challenge.typedData;
  const domainFields = [{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}];
  if (!typed || Object.keys(typed.types || {}).some(k => !['Authorization','EIP712Domain'].includes(k)) ||
      (typed.types?.EIP712Domain && canonicalMetadataJSON(typed.types.EIP712Domain) !== canonicalMetadataJSON(domainFields)) ||
      !sameAddress(typed.domain?.verifyingContract, scope.escrowAddress) ||
      canonicalMetadataJSON({...typed,domain:{...typed.domain,verifyingContract:scope.escrowAddress},types:{Authorization:typed.types?.Authorization}}) !== canonicalMetadataJSON(expected)) fail('INVALID_CHALLENGE');
  return challenge;
}
export function signedMetadataAuth(challenge, signature) {
  let normalized; try { normalized = Signature.from(signature).serialized; } catch { fail('INVALID_SIGNATURE', 'signature'); }
  const { EIP712Domain: ignored, ...types } = challenge.typedData.types;
  let recovered; try { recovered = verifyTypedData(challenge.typedData.domain, types, challenge.typedData.message, normalized); } catch { fail('INVALID_SIGNATURE', 'signature'); }
  if (!sameAddress(recovered, challenge.address)) fail('REQUESTER_ONLY', 'signature');
  return Object.fromEntries(['address','action','taskId','payloadHash','nonce','expiresAt','challenge'].map(key => [key, challenge[key]]).concat([['signature',normalized]]));
}
export async function signMetadataChallenge(provider, challenge, context) {
  throwIfAborted(context.signal);
  validateMetadataChallenge(challenge, context);
  const accounts = await provider.request({method:'eth_accounts'});
  throwIfAborted(context.signal);
  if (!sameAddress(accounts?.[0], context.task.requester)) fail('REQUESTER_ONLY','address');
  const chain = await provider.request({method:'eth_chainId'});
  throwIfAborted(context.signal);
  if (Number(chain) !== 56) fail('WRONG_CHAIN','chainId');
  validateMetadataChallenge(challenge, context);
  const signature = await provider.request({method:'eth_signTypedData_v4',params:[challenge.address,JSON.stringify(challenge.typedData)]});
  throwIfAborted(context.signal);
  return signedMetadataAuth(challenge, signature);
}
export function safeMetadataError(error) {
  if (error?.code === 4001 || error?.code === 'ACTION_REJECTED') return 'WALLET_REJECTED: Signature or connection declined. Nothing was published.';
  const codes = ['METADATA_SIZE','METADATA_JSON','METADATA_REQUIRED','METADATA_PAYLOAD_REQUIRED','METADATA_FIELDS','METADATA_FIELD_INVALID','CRITERIA_HASH_MISMATCH','WRONG_CHAIN','INVALID_DEPLOYMENT','WALLET_UNAVAILABLE','REQUESTER_ONLY','INVALID_CHALLENGE','INVALID_SIGNATURE','CONNECT_REQUESTER_FIRST','NETWORK_UNAVAILABLE','INVALID_RESPONSE','CHALLENGE_EXPIRED','READBACK_MISMATCH','METADATA_IMMUTABLE','METADATA_TASK_INACTIVE','FORBIDDEN','COMMITMENT_MISMATCH','REPLAY','INVALID_AUTH','AUTH_REQUIRED','AGENT_ID_REQUIRED','DEPLOYMENT_MISMATCH','STORAGE_UNAVAILABLE','SERVICE_UNAVAILABLE','RATE_LIMIT','AUTH_UNAVAILABLE'];
  const code = codes.includes(error?.code) ? error.code : 'PUBLISH_FAILED';
  const field = ['metadata','title','description','rubric','category','signature','address','chainId','escrowAddress','payload.metadata','payload.metadata.title','payload.metadata.description','payload.metadata.rubric','payload.metadata.category','payload','auth','auth.signature','auth.nonce'].includes(error?.field) ? ' · field: '+error.field : '';
  const help = {METADATA_JSON:'Paste a valid JSON object, not an API envelope.',METADATA_REQUIRED:'Paste the original metadata object.',METADATA_FIELDS:'Use exactly title, description, rubric and category; never include a private solution.',METADATA_FIELD_INVALID:'Required string lengths: '+METADATA_FIELDS.map(([name,min,max]) => name+' '+min+'–'+max).join(', ')+'.',CRITERIA_HASH_MISMATCH:'This is not the committed original metadata. Find the original text; a hash cannot recover it.',REQUESTER_ONLY:'Use the wallet address that funded this task.',WRONG_CHAIN:'Select BNB Smart Chain (56) in your wallet.',CONNECT_REQUESTER_FIRST:'Connect the requester wallet with the separate connect button first.',CHALLENGE_EXPIRED:'Get a new challenge and explicitly authorize again.',NETWORK_UNAVAILABLE:'Publication outcome is unknown. Retry the same signed envelope or check the public brief; do not blindly sign again.',METADATA_TASK_INACTIVE:'This task is no longer open for metadata publication.'}[code] || 'Check the original JSON, account and chain. Expired challenges need a new explicit authorization.';
  return code+field+'. '+help+' No automatic signing or retry.';
}
export async function metadataRequest(url, { fetcher = globalThis.fetch, signal, body } = {}) {
  throwIfAborted(signal);
  // A cleanup-owned controller supports browsers without AbortSignal.any/timeout/throwIfAborted.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    let response;
    try {
      response = await fetcher(url, {method:body ? 'POST':'GET',cache:'no-store',signal:controller.signal,
        ...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
      throwIfAborted(controller.signal);
    } catch (error) {
      throwIfAborted(signal);
      fail('NETWORK_UNAVAILABLE');
    }
    let data;
    try { data = await response.json(); }
    catch {
      throwIfAborted(signal);
      if (controller.signal.aborted) fail('NETWORK_UNAVAILABLE');
      fail('INVALID_RESPONSE');
    }
    throwIfAborted(signal);
    if (controller.signal.aborted) fail('NETWORK_UNAVAILABLE');
    if (!response.ok) throw Object.assign(new Error('Request failed'), {code:data.code || data.error_code,field:data.field,status:response.status,retryable:data.retryable === true});
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
export async function publishMetadataAndReadBack({task,chainId,escrowAddress,payload,auth,signal,fetcher}) {
  deploymentScope(chainId,escrowAddress);
  if (auth.expiresAt <= Math.floor(Date.now()/1000)) fail('CHALLENGE_EXPIRED');
  const base = '/api/marketplace/tasks/'+encodeURIComponent(task.id);
  try { await metadataRequest(base+'/metadata',{fetcher,signal,body:{chainId:Number(chainId),escrowAddress,auth,payload}}); }
  catch (error) { if (error.code !== 'REPLAY') throw error; }
  const data = await metadataRequest(base+'?'+new URLSearchParams({chainId:String(chainId),escrowAddress}),{fetcher,signal});
  const read = data.task;
  if (!read || String(read.id) !== String(task.id) || !sameAddress(read.requester,task.requester) || read.criteriaHash?.toLowerCase() !== task.criteriaHash?.toLowerCase()) fail('READBACK_MISMATCH');
  validateOriginalMetadata(JSON.stringify(read.metadata),task.criteriaHash);
  return read;
}
