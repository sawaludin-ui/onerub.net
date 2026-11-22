'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { canonicalMetadataJSON, metadataHash, validateOriginalMetadata, deploymentScope,
  connectMetadataWallet, validateMetadataChallenge, signMetadataChallenge, signedMetadataAuth,
  metadataRequest, publishMetadataAndReadBack, safeMetadataError, sameAddress } from '../../lib/marketplace-metadata-client.mjs';

export function MetadataIntegrity({ task, onVerificationChange }) {
  let canonical = '', computed = '', matched = false, invalid = false;
  try {
    if (task?.metadata) {
      canonical = canonicalMetadataJSON(task.metadata);
      computed = metadataHash(task.metadata);
      validateOriginalMetadata(JSON.stringify(task.metadata), task.criteriaHash);
      matched = true;
    }
  } catch { invalid = true; }
  let policyJSON = '', policyComputed = '', policyMatched = false;
  try {
    if (task?.policy) {
      policyJSON = canonicalMetadataJSON(task.policy);
      policyComputed = metadataHash(task.policy);
      policyMatched = policyComputed.toLowerCase() === task.policyHash?.toLowerCase();
    }
  } catch { /* A malformed public policy is never shown as verified. */ }
  useEffect(() => { onVerificationChange?.(matched && policyMatched); }, [matched, policyMatched, onVerificationChange]);
  return <section className="metadata-integrity" aria-label="Public commitment verification">
    <h3>Verify the public brief</h3>
    <p role="status">{matched ? 'MATCH — displayed metadata matches criteriaHash.' : invalid ? 'MISMATCH — do not start work.' : 'Brief not published — do not start work.'}</p>
    <p>This browser hashes the canonical public JSON independently. A matching commitment does not prove evaluator fairness or service availability.</p>
    <dl className="metadata-integrity-hashes"><dt>On-chain criteriaHash</dt><dd>{task?.criteriaHash || 'Not available'}</dd><dt>Browser keccak256</dt><dd>{computed || 'No public metadata to hash'}</dd></dl>
    {canonical && <details><summary>Canonical metadata JSON (including rubric)</summary><pre className="metadata-integrity-json">{canonical}</pre></details>}
    <h4>Policy is a separate commitment</h4>
    <dl className="metadata-integrity-hashes"><dt>On-chain policyHash</dt><dd>{task?.policyHash || 'Not available'}</dd><dt>Browser policy keccak256</dt><dd>{policyComputed || 'Policy JSON not available'}</dd></dl>
    <p>{policyJSON ? policyMatched ? 'MATCH — policy JSON matches policyHash.' : 'MISMATCH — policy JSON does not match policyHash.' : 'Policy hash alone does not verify the task rubric.'} Server policyVerified: {task?.policyVerified === true ? 'true' : 'not verified'}.</p>
    {policyJSON && <details><summary>Canonical policy JSON</summary><pre className="metadata-integrity-json">{policyJSON}</pre></details>}
  </section>;
}

export default function MetadataPublisher({ task, chainId, escrowAddress, onPublished, onAccountChange }) {
  const id = useId();
  const [text, setText] = useState('');
  const [account, setAccount] = useState('');
  const [manualAddress, setManualAddress] = useState('');
  const [signature, setSignature] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [proof, setProof] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const active = useRef(null);
  const locked = useRef(false);
  const retry = useRef(null);
  const provider = useRef(null);
  const errorRef = useRef(null);
  const scopeKey = String(task?.id)+':'+chainId+':'+escrowAddress+':'+task?.criteriaHash;
  useEffect(() => {
    active.current?.abort(); locked.current = false; retry.current = null;
    setBusy(false); setText(''); setProof(null); setChallenge(null); setSignature(''); setStatus(''); setError(null); setAccount(''); provider.current = null;
    return () => active.current?.abort();
  }, [scopeKey]);
  function resetInput(value) {
    setText(value); setProof(null); setChallenge(null); setSignature(''); setError(null); setStatus(''); retry.current = null;
  }
  async function run(work) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    try { await work(controller.signal); }
    catch (e) { if (!controller.signal.aborted) { setError(e); setStatus(''); requestAnimationFrame(() => errorRef.current?.focus()); } }
    finally { if (active.current === controller) { locked.current = false; setBusy(false); } }
  }
  function inspect() {
    const result = validateOriginalMetadata(text,task.criteriaHash);
    setProof(result); return result;
  }
  async function newChallenge(address, result, signal) {
    if (!sameAddress(address, task.requester)) throw Object.assign(new Error(),{code:'REQUESTER_ONLY',field:'address'});
    const scope = deploymentScope(chainId,escrowAddress);
    const context = {task,...scope,payloadHash:result.payloadHash,signal};
    const data = await metadataRequest('/api/marketplace/auth/challenge',{signal,body:{...scope,address,action:'metadata',taskId:String(task.id),payloadHash:result.payloadHash}});
    validateMetadataChallenge(data,context);
    if (signal.aborted) throw new DOMException('Aborted','AbortError');
    setChallenge(data); return {data,context};
  }
  async function finish(auth, result, signal) {
    const args = {task,chainId,escrowAddress,payload:result.payload,auth};
    retry.current = {args,count:0};
    await submit(args,signal);
  }
  async function submit(args, signal) {
    setStatus('Publishing; checking the public readback…');
    const read = await publishMetadataAndReadBack({...args,signal});
    if (signal.aborted) return;
    retry.current = null; setStatus('Published — public readback matches the on-chain criteriaHash.'); setChallenge(null); setSignature('');
    onPublished?.(read);
  }
  return <section className="metadata-publisher" aria-labelledby={id+'-heading'}>
    <h3 id={id+'-heading'}>Publish / recover original metadata</h3>
    <p>Requester only. Paste or choose the original public metadata JSON: title, description, rubric, category. No solution, private key or seed phrase. A hash cannot recover missing text; this tool never invents a replacement brief.</p>
    <p>Only an EIP-712 metadata authorization is signed. No transaction, token approval or funding is requested.</p>
    <p>Requester: <code>{task?.requester}</code> · Chain 56 · Escrow: <code>{escrowAddress}</code></p>
    <form action={'/api/marketplace/tasks/'+encodeURIComponent(task?.id)+'/metadata'} method="post" aria-labelledby={id+'-heading'} onSubmit={event => { event.preventDefault(); run(async signal => {
      const result = inspect();
      if (!provider.current || !sameAddress(account,task.requester)) throw Object.assign(new Error(),{code:'CONNECT_REQUESTER_FIRST'});
      const {data,context} = await newChallenge(account,result,signal);
      if (signal.aborted) return;
      setStatus('Review the metadata authorization in your wallet.');
      const auth = await signMetadataChallenge(provider.current,data,context);
      if (!signal.aborted) await finish(auth,result,signal);
    }); }}>
      <fieldset disabled={busy} className="metadata-publisher-fields"><legend>Original committed public brief</legend>
        <label htmlFor={id+'-file'}>Choose original JSON file (maximum 100 KB)</label>
        <input id={id+'-file'} name="metadataFile" type="file" accept=".json,application/json" onChange={event => {
          const file = event.target.files?.[0]; if (!file) return;
          run(async signal => { if (file.size > 100000) throw Object.assign(new Error(),{code:'METADATA_SIZE',field:'metadata'}); const value = await file.text(); if (!signal.aborted) resetInput(value); });
        }}/>
        <label htmlFor={id+'-json'}>Original metadata JSON (required)</label>
        <p id={id+'-help'}>The complete object must hash to criteriaHash exactly. Whitespace and key order may differ; field text must not be changed.</p>
        <textarea id={id+'-json'} name="metadata" data-field="metadata" rows={10} maxLength={100000} required value={text} onChange={event => resetInput(event.target.value)} spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-describedby={id+'-help'+(error?.field === 'metadata' ? ' '+id+'-error' : '')} aria-invalid={error?.field === 'metadata' || undefined}/>
        <div className="metadata-publisher-actions">
          <button type="button" onClick={() => run(async () => { inspect(); setStatus('MATCH — original metadata matches criteriaHash. Ready for explicit authorization.'); })}>Verify original JSON</button>
          <button type="button" onClick={() => run(async signal => {
            deploymentScope(chainId,escrowAddress);
            const injected = window.ethereum;
            const connected = await connectMetadataWallet(injected,task.requester);
            if (!signal.aborted) { provider.current = injected; setAccount(connected); onAccountChange?.(connected); setStatus('Requester connected on BNB Smart Chain. Signing requires the separate publish button.'); }
          })}>Connect requester wallet</button>
          <button type="submit">Sign metadata &amp; publish</button>
        </div>
        {account && <p>Connected requester: <code>{account}</code>. This is your own task; do not compete against yourself as a worker.</p>}
      </fieldset>
    </form>
    {proof && <dl className="metadata-integrity-hashes"><dt>Browser metadata keccak256</dt><dd>{proof.hash}</dd><dt>Signed payload hash (metadata envelope)</dt><dd>{proof.payloadHash}</dd></dl>}
    <details><summary>No injected wallet? Binance Agentic Wallet / external signer</summary>
      <p>This page requests the challenge and handles the POST. No API curl is needed. In Binance App, enable Developer Mode if needed. Copy the typed data into your own sign-message preview flow, inspect the parsed metadata authorization, explicitly confirm in your wallet, then paste only the resulting EVM signature here. Never paste a wallet session, private key or seed phrase.</p>
      <label htmlFor={id+'-address'}>Requester signing address</label>
      <input id={id+'-address'} name="manualAddress" data-field="manual-address" value={manualAddress} spellCheck={false} autoCapitalize="none" autoCorrect="off" disabled={busy} onChange={event => {setManualAddress(event.target.value); setChallenge(null); setSignature(''); setError(null);}}/>
      <button type="button" disabled={busy} onClick={() => run(async signal => {
        const result = inspect(); await newChallenge(manualAddress.trim(),result,signal); setStatus('Challenge ready. Preview and explicitly confirm with your external signer; this page will not sign automatically.');
      })}>Get metadata signing challenge</button>
      {challenge && <>
        <p>Expires: {new Date(challenge.expiresAt*1000).toISOString()}. If expired, request a new challenge and explicitly sign again.</p>
        <label htmlFor={id+'-typed'}>EIP-712 typed data to copy</label>
        <textarea id={id+'-typed'} name="typedData" readOnly rows={10} value={JSON.stringify(challenge.typedData,null,2)} spellCheck={false}/>
        <button type="button" disabled={busy} onClick={() => run(async () => { await navigator.clipboard.writeText(JSON.stringify(challenge.typedData)); setStatus('Typed data copied. Inspect it in your signer before confirming.'); })}>Copy typed data</button>
        <label htmlFor={id+'-signature'}>Resulting signature (0x-prefixed EVM hex)</label>
        <textarea id={id+'-signature'} name="signature" data-field="signature" rows={3} value={signature} disabled={busy} spellCheck={false} autoCapitalize="none" autoCorrect="off" onChange={event => {setSignature(event.target.value); setError(null);}}/>
        <button type="button" disabled={busy} onClick={() => run(async signal => {
          const result = inspect(); validateMetadataChallenge(challenge,{task,chainId,escrowAddress,payloadHash:result.payloadHash});
          const auth = signedMetadataAuth(challenge,signature.trim());
          onAccountChange?.(auth.address);
          await finish(auth,result,signal);
        })}>Verify signature &amp; publish</button>
      </>}
    </details>
    <div className="metadata-publisher-status" aria-live="polite" aria-atomic="true"><p role="status">{busy ? status || 'Working…' : status}</p>
      {error && <p id={id+'-error'} ref={errorRef} tabIndex={-1} role="alert">{safeMetadataError(error)}</p>}
    </div>
    {error && retry.current && retry.current.count < 2 && (error.retryable || error.code === 'NETWORK_UNAVAILABLE' || error.code === 'INVALID_RESPONSE' || error.code === 'METADATA_REQUIRED' || error.code === 'READBACK_MISMATCH') && <button type="button" disabled={busy} onClick={() => run(async signal => { const saved = retry.current; saved.count++; await submit(saved.args,signal); })}>Retry same signed publication (no new signature)</button>}
    <p>Retries are manual, at most twice with the identical signed envelope before expiry. A replay is only treated as successful after matching public readback. A changed brief always requires a new commitment, not a recovery signature.</p>
  </section>;
}
