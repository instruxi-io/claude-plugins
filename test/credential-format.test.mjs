// ~/.enforcer/credentials.json is ONE file with FOUR readers and writers:
//   enforcer/src/credentials.mjs        (the enforcer plugin; MCP header helper, /enforcer:login)
//   enforcer-files/src/credentials.mjs  (byte-identical; CI `cmp`s it)
//   enforcer-governor src/credentials.mjs (another repo, at the tag this catalog pins)
//   enforcer-graph/hooks/lib.py         (Python)
// A format change in one signs the others out. This writes the file with each
// implementation and reads it with every other, including a token REFRESHED by
// one and read by another (refresh tokens rotate: a reader that misses the
// write-back would spend a dead refresh token).
//
//   GOVERNOR_DIR=../enforcer-governor node test/credential-format.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname);
const governorDir = resolve(process.env.GOVERNOR_DIR || join(root, '..', 'enforcer-governor'));
const home = mkdtempSync(join(tmpdir(), 'cred-format-'));
Object.assign(process.env, { HOME: home, ENFORCER_HOME: join(home, '.enforcer'), GOVERNOR_HOME: join(home, '.g') });
delete process.env.ENFORCER_API_KEY; delete process.env.GRAPH_API_KEY;

const E = await import(pathToFileURL(join(root, 'enforcer/src/credentials.mjs')).href);
const G = await import(pathToFileURL(join(governorDir, 'src/credentials.mjs')).href);

// The Python reader, as the graph hooks call it: no key configured, so it uses the
// sign-in. ASYNC on purpose: the token endpoint below lives in this process, and a
// synchronous child would block the event loop it needs to answer.
const py = async () => JSON.parse((await promisify(execFile)('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(root, 'enforcer-graph/hooks'))})
import lib
print(json.dumps(lib.auth_headers({"api_key": ""})))`], { env: process.env })).stdout);

let pass = 0;
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };

// A token endpoint for the refresh cases: rt-1 -> (at-2, rt-2), rt-2 -> (at-3, rt-3).
const srv = createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const f = Object.fromEntries(new URLSearchParams(b));
  const next = { 'rt-1': ['at-2', 'rt-2'], 'rt-2': ['at-3', 'rt-3'] }[f.refresh_token];
  res.writeHead(next ? 200 : 400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(next ? { access_token: next[0], refresh_token: next[1], expires_in: 900 } : { error: 'invalid_grant' }));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const tokenEndpoint = `http://127.0.0.1:${srv.address().port}/token`;

const oauth = (access, expiresAt, refresh = 'rt-1') => ({
  enforcer: { base_url: 'https://api.example.test', oauth: {
    access_token: access, refresh_token: refresh, expires_at: expiresAt,
    token_endpoint: tokenEndpoint, client_id: 'mcp_x', scope: 'enforcer:read', resources: ['https://api.example.test'] } } });
const future = new Date(Date.now() + 3600e3).toISOString();
const past = new Date(Date.now() - 60e3).toISOString();
const file = () => JSON.parse(readFileSync(E.SHARED_FILE(), 'utf8'));

await ok('a sign-in written by the enforcer plugin is read the same by the governor and the graph hooks', async () => {
  E.saveCredentials(oauth('at-1', future));
  const want = { Authorization: 'Bearer at-1' };
  assert.deepEqual(await E.authHeaders(), want);
  assert.deepEqual(await G.authHeaders(), want);
  assert.deepEqual(await py(), want);
});

await ok('a saved API key wins over a sign-in, in all three', async () => {
  const d = oauth('at-1', future); d.enforcer.api_key = 'env3_' + 'k'.repeat(43);
  G.saveCredentials(d); // written by the governor this time
  const want = { 'X-API-Key': d.enforcer.api_key };
  assert.deepEqual(await E.authHeaders(), want);
  assert.deepEqual(await G.authHeaders(), want);
  assert.deepEqual(await py(), want);
});

await ok('a token the graph hooks refresh is written back in a shape Node reads (no second refresh)', async () => {
  E.saveCredentials(oauth('at-1', past, 'rt-1'));
  assert.deepEqual(await py(), { Authorization: 'Bearer at-2' }, 'python refreshed rt-1');
  const o = file().enforcer.oauth;
  assert.deepEqual([o.access_token, o.refresh_token], ['at-2', 'rt-2'], 'rotated pair written back');
  assert.ok(Date.parse(o.expires_at) > Date.now(), 'expires_at parses in JS');
  assert.deepEqual(await E.authHeaders(), { Authorization: 'Bearer at-2' }, 'the enforcer plugin uses it as-is');
  assert.deepEqual(await G.authHeaders(), { Authorization: 'Bearer at-2' }, 'so does the governor');
});

await ok('a token Node refreshes is read by the graph hooks without refreshing again', async () => {
  const d = file(); d.enforcer.oauth.expires_at = past; E.saveCredentials(d); // at-2 expired; refresh token rt-2
  assert.deepEqual(await G.authHeaders(), { Authorization: 'Bearer at-3' }, 'governor refreshed rt-2');
  assert.equal(file().enforcer.oauth.refresh_token, 'rt-3');
  assert.deepEqual(await py(), { Authorization: 'Bearer at-3' }, 'python reads the governor\'s write-back');
});

await ok('the file stays private (0600) whoever wrote it last', () => {
  const mode = execFileSync('stat', ['-c', '%a', E.SHARED_FILE()]).toString().trim();
  assert.equal(mode, '600');
});

srv.close();
console.log(`\n  ${pass} passed (governor from ${governorDir})`);
