// The edge credential, and specifically that its identifier is not the key.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'gov-cred-'));
process.env.HOME = home; process.env.USERPROFILE = home;
delete process.env.ENFORCER_API_KEY;
mkdirSync(join(home, '.enforcer-governor'), { recursive: true });

let pass = 0;
const ok = (label, fn) => { fn(); pass++; console.log('  ok  ' + label); };
const okAsync = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };
const KEY = 'env3_' + 'x'.repeat(43);

const { enforcerKey, keyId, isFederated, authHeaders, saveCredentials, readCredentials, SHARED_DIR } = await import('../src/credentials.mjs');

ok('unauthenticated is a normal state, not an error', () => {
  // The governor enforces locally with no account at all; a credential only
  // buys federation.
  assert.equal(enforcerKey(), null);
  assert.equal(isFederated(), false);
  assert.equal(keyId(), null);
});

ok('reads a saved credential', () => {
  writeFileSync(join(home, '.enforcer-governor', 'credentials.json'),
    JSON.stringify({ enforcer: { api_key: KEY } }));
  assert.equal(enforcerKey(), KEY);
  assert.equal(isFederated(), true);
});

ok('the environment wins, for CI and containers', () => {
  process.env.ENFORCER_API_KEY = 'env3_fromenv';
  assert.equal(enforcerKey(), 'env3_fromenv');
  delete process.env.ENFORCER_API_KEY;
});

ok('key_id carries no key material', () => {
  // This value goes into every receipt and every log line, where it outlives
  // the key and travels further than it does.
  const id = keyId(KEY);
  assert.ok(id.startsWith('env3_'));
  assert.equal(id.includes('xxxxxx'), false, 'truncation would leak the secret');
  assert.ok(!KEY.includes(id.split('_')[1]), 'the id must not be a substring of the key');
});

ok('key_id is stable for the same key', () => {
  assert.equal(keyId(KEY), keyId(KEY));
  assert.notEqual(keyId(KEY), keyId('env3_' + 'y'.repeat(43)));
});

ok('malformed credentials do not throw', () => {
  writeFileSync(join(home, '.enforcer-governor', 'credentials.json'), 'not json');
  assert.equal(enforcerKey(), null);
});

const seedOauth = (endpoint) => saveCredentials({ enforcer: { oauth: {
  access_token: 'old', refresh_token: 'r1', client_id: 'c', token_endpoint: endpoint,
  expires_at: new Date(Date.now() - 1000).toISOString() } } });

await okAsync('parallel refresh: one network call, both callers see the rotated pair', async () => {
  process.env.HOME = home; process.env.ENFORCER_HOME = join(home, '.enforcer');
  seedOauth('https://api.instruxi.dev/oauth/token');
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise((r) => setTimeout(r, 150));
    return { ok: true, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 900 }) }; };
  const [a, b] = await Promise.all([authHeaders({ fetchImpl }), authHeaders({ fetchImpl })]);
  assert.equal(calls, 1);
  assert.equal(a.Authorization, 'Bearer new');
  assert.equal(b.Authorization, 'Bearer new');
  assert.equal(readCredentials().enforcer.oauth.refresh_token, 'r2');
  assert.equal(statSync(SHARED_DIR()).mode & 0o777, 0o700);
});

await okAsync('http token_endpoint is refused', async () => {
  seedOauth('http://api.instruxi.dev/oauth/token');
  let calls = 0;
  const h = await authHeaders({ fetchImpl: async () => { calls++; return { ok: false }; } });
  assert.equal(calls, 0); assert.deepEqual(h, {});
});

await okAsync('token_endpoint on a foreign origin is refused', async () => {
  seedOauth('https://evil.example/token');
  let calls = 0;
  const h = await authHeaders({ fetchImpl: async () => { calls++; return { ok: false }; } });
  assert.equal(calls, 0); assert.deepEqual(h, {});
});

await okAsync('a held lock times out and the stale token is used', async () => {
  seedOauth('https://api.instruxi.dev/oauth/token');
  mkdirSync(join(SHARED_DIR(), '.refresh.lock'));
  let calls = 0;
  const h = await authHeaders({ fetchImpl: async () => { calls++; return { ok: false }; } });
  assert.equal(calls, 0); assert.equal(h.Authorization, 'Bearer old');
});

console.log(`\n  ${pass} passed`);
