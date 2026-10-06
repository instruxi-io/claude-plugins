// Version drift report for SessionStart: one line per mismatch, nothing when aligned.
//  * installed copies of an Instruxi plugin older than the marketplace manifest's version;
//  * tools the MCP server serves (GET /api/v1/mcp/health) that the LOCKED manifest (lib/api/spec/mcp-manifest.json) lacks;
//  * the workspace the stored sign-in is bound to (JWT claims, no call).
// One GET at most, short timeout, never throws.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOT } from '../../../hooks/claude/paths.mjs';

export const MANIFEST_DIR = `${DOT}-plugin`;
export const DEFAULT_BASE = 'https://api.instruxi.dev';
const LOCKED_MANIFEST = fileURLToPath(new URL('../../../lib/api/spec/mcp-manifest.json', import.meta.url));

export const load = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

export function vtuple(v) {
  const out = [];
  for (const part of String(v || '').split('-')[0].split('.')) {
    if (!/^\d+$/.test(part)) return null;
    out.push(Number(part));
  }
  return out.length ? out : null;
}
const less = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d < 0; } return false; };

export function staleInstalls(installed, catalogVersions, mkt) {
  const out = [];
  for (const name of Object.keys(catalogVersions).sort()) {
    const avail = catalogVersions[name], pid = `${name}@${mkt}`, av = vtuple(avail);
    for (const i of installed[pid] || []) {
      if (!i || typeof i !== 'object') continue;
      const hv = vtuple(i.version);
      if (hv && av && less(hv, av)) out.push(`${name} ${i.version} installed (${i.scope || 'unknown scope'}) — ${avail} available: claude plugin update ${pid}`);
    }
  }
  return out;
}

/** Tool names the locked MCP manifest knows (the contract this plugin was built against). */
export const lockedTools = () => new Set(((load(LOCKED_MANIFEST) || {}).tools || []).map((t) => t && t.name).filter(Boolean));

export function unknownTools(health, known, pluginVersion) {
  const d = health.data && typeof health.data === 'object' ? health.data : health;
  const names = new Set((d.tools || []).map((t) => (t && typeof t === 'object' ? t.name : t)).filter(Boolean));
  const extra = [...names].filter((n) => typeof n === 'string' && !known.has(n)).sort();
  if (!extra.length) return [];
  const fams = new Map();
  for (const n of extra) { const f = n.includes('_') ? n.split('_')[0] : n; fams.set(f, [...(fams.get(f) || []), n]); }
  const shown = [...fams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, v]) => (v.length > 1 || v[0] !== f ? `${f}_*` : f)).join(', ');
  return [`MCP ${d.version || '?'} serves tools this plugin (${pluginVersion}) does not know: ${shown}`];
}

export function jwtClaims(tok) {
  try { return JSON.parse(Buffer.from(String(tok).split('.')[1], 'base64url').toString('utf8')) || {}; } catch { return {}; }
}

export function workspaceLine(doc) {
  const o = (doc?.enforcer || {}).oauth || {};
  if (!o.access_token) return null;
  const c = jwtClaims(o.access_token);
  const name = c.tenant || c.tenant_name || c.tenant_code, tid = c.tenant_id;
  if (!(name || tid)) return null;
  return `enforcer workspace: ${name || tid}${name && tid ? ` (${tid})` : ''}${c.role ? ` · role ${c.role}` : ''}`;
}

export async function fetchHealth(base, auth = {}, timeoutMs = 1500) {
  try {
    const res = await fetch(`${String(base).replace(/\/+$/, '')}/api/v1/mcp/health`, { headers: { 'User-Agent': 'enforcer-graph-plugin-versioncheck', ...auth }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const d = await res.json();
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch { return null; }
}

/** The lines to print. `health` is injected by tests; fetched otherwise. */
export async function report(cfgdir, mkt, pluginVersion, doc, base, auth, health) {
  const installed = (load(join(cfgdir, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  const loc = ((load(join(cfgdir, 'plugins', 'known_marketplaces.json')) || {})[mkt] || {}).installLocation;
  const catalog = loc ? load(join(loc, MANIFEST_DIR, 'marketplace.json')) : null;
  const versions = {};
  for (const e of (catalog || {}).plugins || []) {
    if (typeof e.source === 'string') {
      const v = (load(join(loc, e.source, MANIFEST_DIR, 'plugin.json')) || {}).version;
      if (v) versions[e.name] = v;
    }
  }
  const lines = staleInstalls(installed, versions, mkt);
  if (health == null) health = await fetchHealth(base, auth);
  const known = lockedTools();
  if (health && known.size) lines.push(...unknownTools(health, known, pluginVersion));
  return lines;
}
