// list / switch / current against a fake Enforcer, and the credentials file rewrite.
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ws-'));
delete process.env.ENFORCER_API_KEY; delete process.env.ENFORCER_KEY;
process.env.HOME = home; process.env.ENFORCER_HOME = join(home, '.enforcer'); process.env.GOVERNOR_HOME = join(home, '.g');
const { saveCredentials, readCredentials, SHARED_FILE, SHARED_DIR } = await import('../src/credentials.mjs');
const { listWorkspaces, switchWorkspace, currentWorkspace, resolveWorkspace } = await import('../bin/enforcer-workspace.mjs');
let pass = 0;
const ok = async (l, f) => { await f(); pass++; console.log('  ok  ' + l); };

const jwt = (c) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const A = jwt({ tenant_id: 't-acme', tenant: 'Acme', role: 'admin' });
const B = jwt({ tenant_id: 't-beta', tenant: 'Beta', role: 'member' });
saveCredentials({ enforcer: { base_url: 'http://x', oauth: {
  access_token: A, refresh_token: 'r1', expires_at: new Date(Date.now() + 3600e3).toISOString(),
  scope: 'enforcer:read', resources: ['http://x'], client_id: 'c1', token_endpoint: 'http://x/token', issuer: 'http://x' } } });

const calls = [];
let current = 't-acme';
const fake = async (url, init = {}) => {
  const u = new URL(url); calls.push(`${init.method || 'GET'} ${u.pathname}`);
  const j = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  if (u.pathname.endsWith('/auth/me')) {
    const t = current === 't-acme' ? { id: 't-acme', name: 'Acme' } : { id: 't-beta', name: 'Beta' };
    // Live /auth/me (2026-10-05) carries NO memberships field: only the
    // workspace the token is in. The list must come from /auth/tenants.
    return j({ data: { account_id: 'acc-' + current, tenant: t, role: { slug: 'admin' } } });
  }
  if (u.pathname.endsWith('/auth/tenants')) {
    // Recorded shape of GET /auth/tenants: one account row per membership.
    return j({ data: [
      { id: 'acc-t-acme', tenant_id: 't-acme', kind: 'human', tenant: { id: 't-acme', name: 'Acme', status: 'active' }, role: { id: 'r1', slug: 'admin', name: 'Admin' } },
      { id: 'acc-t-beta', tenant_id: 't-beta', kind: 'human', tenant: { id: 't-beta', name: 'Beta', status: 'active' }, role: { id: 'r2', slug: 'member', name: 'Member' } },
    ] });
  }
  if (u.pathname.endsWith('/auth/tenant/switch')) {
    assert.equal(init.headers.Authorization, `Bearer ${A}`);
    const { tenant_id } = JSON.parse(init.body);
    if (tenant_id !== 't-beta') return j({}, 403);
    current = 't-beta';
    return j({ data: { access_token: B, refresh_token: 'r2', expires_in: 600 } });
  }
  return j({}, 404);
};

await ok('list shows every membership (from /auth/tenants) with the current one marked', async () => {
  const rows = await listWorkspaces({ fetchImpl: fake });
  assert.deepEqual(rows.map((r) => [r.name, r.role, r.current]), [['Acme', 'admin', true], ['Beta', 'member', false]]);
  assert.ok(calls.some((c) => c.endsWith('/auth/tenants')), 'memberships must come from /auth/tenants');
});
await ok('resolve by name, code, id; refuses non-members', () => {
  const rows = [{ tenant_id: 't-1', name: 'Acme', code: 'ACME-1' }, { tenant_id: 't-2', name: 'Beta', code: 'BETA-2' }];
  assert.equal(resolveWorkspace(rows, 'beta').tenant_id, 't-2');
  assert.equal(resolveWorkspace(rows, 'acme-1').tenant_id, 't-1');
  assert.equal(resolveWorkspace(rows, 't-2').name, 'Beta');
  assert.throws(() => resolveWorkspace(rows, 'zzz'), /not a member/);
});
await ok('switch posts to /auth/tenant/switch and rewrites credentials atomically, 0600', async () => {
  const t = await switchWorkspace('Beta', { fetchImpl: fake });
  assert.equal(t.tenant_id, 't-beta');
  assert.ok(calls.includes('POST /api/v1/enforcer/auth/tenant/switch'));
  const o = readCredentials().enforcer.oauth;
  assert.equal(o.access_token, B); assert.equal(o.refresh_token, 'r2');
  assert.equal(o.client_id, 'c1'); assert.equal(o.scope, 'enforcer:read'); assert.deepEqual(o.resources, ['http://x']);
  assert.ok(Date.parse(o.expires_at) - Date.now() < 700e3);
  assert.equal(statSync(SHARED_FILE()).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(SHARED_DIR()).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(JSON.parse(readFileSync(SHARED_FILE(), 'utf8')).enforcer.base_url, 'http://x');
});
await ok('current reports tenant, role, account, expiry after the switch', async () => {
  const w = await currentWorkspace({ fetchImpl: fake });
  assert.equal(w.tenant, 'Beta'); assert.equal(w.tenant_id, 't-beta'); assert.equal(w.account_id, 'acc-t-beta'); assert.ok(w.expires_at);
});
await ok('list marks the new workspace current', async () => {
  const rows = await listWorkspaces({ fetchImpl: fake });
  assert.deepEqual(rows.map((r) => r.current), [false, true]);
});
await ok('switching to the current workspace changes nothing', async () => {
  const n = calls.length;
  assert.equal((await switchWorkspace('Beta', { fetchImpl: fake })).unchanged, true);
  assert.ok(!calls.slice(n).some((c) => c.startsWith('POST')));
});
await ok('a 403 from /auth/tenant/switch names enforcer:workspace.write and the re-login line', async () => {
  const denied = (url, init) => (String(url).endsWith('/auth/tenant/switch') ? { ok: false, status: 403, json: async () => ({}) } : fake(url, init));
  await assert.rejects(() => switchWorkspace('Acme', { fetchImpl: denied }),
    (e) => /enforcer:workspace\.write/.test(e.message) && /\/enforcer:login --for work/.test(e.message) && /403/.test(e.message));
});
await ok('switch prod with two matches refuses', async () => {
  const rows = [{ tenant_id: 't-1', name: 'Prod East' }, { tenant_id: 't-2', name: 'Prod West' }];
  assert.throws(() => resolveWorkspace(rows, 'prod'), /not an exact/);
  assert.throws(() => resolveWorkspace(rows, 'prod', { fuzzy: true }), /matches 2 workspaces/);
  assert.equal(resolveWorkspace([rows[0]], 'east', { fuzzy: true }).tenant_id, 't-1');
});
await ok('switch prints the reconnect notice', async () => {
  const { execFileSync } = await import('node:child_process');
  const src = readFileSync(new URL('../bin/enforcer-workspace.mjs', import.meta.url), 'utf8');
  assert.match(src, /\/mcp reconnect or restart/);
  assert.ok(execFileSync);
});
await ok('tenants 500 falls back to /auth/me', async () => {
  const f = (url, init) => (String(url).endsWith('/auth/tenants') ? { ok: false, status: 500, json: async () => ({}) } : fake(url, init));
  const rows = await listWorkspaces({ fetchImpl: f });
  assert.equal(rows.length, 1); assert.equal(rows[0].current, true);
});
console.log(`${pass} passed`);
