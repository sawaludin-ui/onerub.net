import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatorConfig } from '../lib/marketplace-core.mjs';

test('deployed evaluator reads the current Vercel request identity rather than a startup token', () => {
  const keys = ['MARKETPLACE_EVALUATOR_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const symbol = Symbol.for('@vercel/request-context');
  const previous = globalThis[symbol];
  try {
    for (const key of keys) delete process.env[key];
    let requestToken = 'synthetic-first-request';
    globalThis[symbol] = {get: () => ({headers: {'x-vercel-oidc-token': requestToken}})};
    assert.equal(evaluatorConfig().key, requestToken);
    requestToken = 'synthetic-next-request';
    assert.equal(evaluatorConfig().key, requestToken);
    process.env.MARKETPLACE_EVALUATOR_KEY = 'explicit-provider-test';
    assert.equal(evaluatorConfig().key, 'explicit-provider-test');
  } finally {
    if (previous === undefined) delete globalThis[symbol]; else globalThis[symbol] = previous;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
