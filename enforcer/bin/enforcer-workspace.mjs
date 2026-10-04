#!/usr/bin/env node
// Switch workspace like the portal does.
//
//   enforcer-workspace.mjs list                       workspaces you belong to, current one marked
//   enforcer-workspace.mjs switch <name|code|id>      move this machine's sign-in to that workspace
//   enforcer-workspace.mjs current                    tenant, role, account, expiry
//
// The sign-in JWT is bound to ONE tenant. Switching asks Enforcer for a token
// pair for another tenant the person belongs to (POST /auth/tenant/switch) and
// writes it into ~/.enforcer/credentials.json, keeping scope/resources/client.
import { readCredentials, saveCredentials, authHeaders, DEFAULT_BASE_URL } from '../src/credentials.mjs';

const API = '/api/v1/enforcer';
const out = (s) => process.stdout.write(s + '\n');

/** The claims of a JWT, or {} when it is not one. Not verified: display and matching only. */
export function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

const baseOf = (doc) => String(doc?.enforcer?.base_url || process.env.ENFORCER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const roleOf = (r) => (typeof r === 'string' ? r : r?.slug || r?.name || null);

/** Normalise one membership from /auth/me, whatever it calls its fields. */
export function normalizeMembership(m) {
  const t = m?.tenant || {};
  return {
    tenant_id: m?.tenant_id || t.id || m?.id || null,
    name: m?.tenant_name || t.name || m?.name || null,
    code: m?.tenant_code || m?.code || t.code || null,
    role: roleOf(m?.role),
    account_id: m?.account_id || null,
  };
}

/** Every workspace the person belongs to, from the /auth/me document. */
export function membershipsOf(me) {
  const list = me?.memberships || me?.tenants || me?.workspaces || me?.accounts || [];
  const rows = (Array.isArray(list) ? list : []).map(normalizeMembership).filter((m) => m.tenant_id);
  // /auth/me always names the workspace you are in; make sure it is listed.
  const cur = me?.tenant?.id;
  if (cur && !rows.some((m) => m.tenant_id === cur)) {
    rows.push({ tenant_id: cur, name: me.tenant.name || null, code: me.tenant.code || null, role: roleOf(me.role), account_id: me.account_id || null });
  }
  return rows;
}

/** Match `<name|code|tenant_id>` against memberships: exact id/code, then name, case-insensitive. Throws on none or ambiguity. */
export function resolveWorkspace(rows, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new Error('name a workspace: switch <name|code|tenant_id>');
  const hit = (f) => rows.filter((m) => f(m));
  let found = hit((m) => m.tenant_id?.toLowerCase() === q || m.code?.toLowerCase() === q);
  if (!found.length) found = hit((m) => m.name?.toLowerCase() === q);
  if (!found.length) found = hit((m) => m.name?.toLowerCase().includes(q));
  if (found.length > 1) throw new Error(`"${query}" matches ${found.length} workspaces (${found.map((m) => m.name || m.tenant_id).join(', ')}); use the code or id`);
  if (!found.length) {
    throw new Error(`you are not a member of "${query}". Switching only moves between workspaces you belong to; for a new one, sign in with its code (/enforcer:login <WORKSPACE-CODE>) or accept an invite.`);
  }
  return found[0];
}

async function getMe(base, fetchImpl) {
  const headers = await authHeaders({ fetchImpl });
  if (!headers.Authorization) throw new Error('not signed in with a browser sign-in (an API key is bound to its own workspace). Run /enforcer:login.');
  const r = await fetchImpl(`${base}${API}/auth/me`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Enforcer refused /auth/me (HTTP ${r.status}). Run /enforcer:login.`);
  const j = await r.json();
  return { me: j?.data || j, headers };
}

/** Workspaces for `list`, each with `current` set from the stored JWT's tenant_id. */
export async function listWorkspaces({ fetchImpl = fetch } = {}) {
  const doc = readCredentials();
  const base = baseOf(doc);
  const { me } = await getMe(base, fetchImpl);
  const cur = jwtClaims(readCredentials()?.enforcer?.oauth?.access_token).tenant_id || me?.tenant?.id;
  return membershipsOf(me).map((m) => ({ ...m, current: m.tenant_id === cur }));
}

/** Switch to a workspace and adopt the token pair it returns. Returns the new membership. */
export async function switchWorkspace(query, { fetchImpl = fetch, now = Date.now } = {}) {
  const rows = await listWorkspaces({ fetchImpl });
  const target = resolveWorkspace(rows, query);
  const doc = readCredentials();
  const base = baseOf(doc);
  if (target.current) return { ...target, unchanged: true };
  const headers = await authHeaders({ fetchImpl });
  const r = await fetchImpl(`${base}${API}/auth/tenant/switch`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: target.tenant_id }), signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Enforcer refused the switch (HTTP ${r.status}).`);
  const j = await r.json();
  const t = j?.data?.tokens || j?.data || j;
  const access = t.access_token;
  if (!access) throw new Error('Enforcer answered the switch without a token.');
  // Re-read: authHeaders may have refreshed (and rotated) the pair in between.
  const fresh = readCredentials();
  const o = fresh.enforcer.oauth;
  saveCredentials({ ...fresh, enforcer: { ...fresh.enforcer, oauth: {
    ...o, access_token: access, refresh_token: t.refresh_token || o.refresh_token,
    expires_at: new Date(now() + (Number(t.expires_in) || 900) * 1000).toISOString(), scope: t.scope || o.scope,
  } } });
  return target;
}

/** Tenant, role, account and expiry of the stored sign-in. */
export async function currentWorkspace({ fetchImpl = fetch } = {}) {
  const doc = readCredentials();
  const o = doc?.enforcer?.oauth;
  if (!o?.access_token) throw new Error('not signed in with a browser sign-in. Run /enforcer:login.');
  const c = jwtClaims(o.access_token);
  let me = null;
  try { me = (await getMe(baseOf(doc), fetchImpl)).me; } catch { /* the token's own claims still say where you are */ }
  return {
    tenant: me?.tenant?.name || c.tenant || null, tenant_id: c.tenant_id || me?.tenant?.id || null,
    role: roleOf(me?.role) || c.role || null, account_id: me?.account_id || c.account_id || c.sub || null,
    expires_at: o.expires_at || null,
  };
}

export const describe = (w) => `Workspace: ${w.tenant || w.name || w.tenant_id} (${w.tenant_id}) · role ${w.role || '?'} · account ${w.account_id || '?'}${w.expires_at ? ` · token expires ${w.expires_at}` : ''}`;

async function main([cmd = 'current', ...rest]) {
  if (cmd === 'list') {
    const rows = await listWorkspaces();
    if (!rows.length) { out('No workspaces found for this sign-in.'); return; }
    for (const m of rows) out(`${m.current ? '*' : ' '} ${m.name || m.tenant_id}${m.code ? ` [${m.code}]` : ''}  ${m.role || '?'}  ${m.tenant_id}`);
    out('* = current workspace');
    return;
  }
  if (cmd === 'switch') {
    const t = await switchWorkspace(rest.join(' '));
    out(t.unchanged ? `Already in ${t.name || t.tenant_id}.` : `Switched to ${t.name || t.tenant_id}. Every Enforcer plugin on this machine now acts in it.`);
    out(describe(await currentWorkspace()));
    return;
  }
  if (cmd === 'current') { out(describe(await currentWorkspace())); return; }
  out('Usage: /enforcer:workspace list | switch <name|code|tenant_id> | current');
  process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => { out(`Workspace: ${e.message}`); process.exitCode = 1; });
}
