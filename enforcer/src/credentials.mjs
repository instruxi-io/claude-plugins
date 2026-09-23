// The one Enforcer credential on this machine: ~/.enforcer/credentials.json.
//
// Kept byte-compatible with enforcer-governor's copy of this module, because
// both plugins read and write the same file: sign in with either and both are
// signed in. Change the file format in one and the other breaks.
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ONE sign-in for everything Enforcer on this machine.
//
// The governor and the Enforcer MCP server used to authenticate separately:
// the governor from its own file, the MCP server through whatever the client
// negotiated. Signing in to one left the other signed out, which reads to a
// person as "I logged in and it still says I'm not". So the credential lives
// in ~/.enforcer/credentials.json, a location neither tool owns, and both read
// it: the hooks directly, the MCP server through bin/enforcer-headers.mjs,
// which the plugin registers as that server's headersHelper.
//
// The governor's old location is still read, so an existing install keeps
// working without a migration step; new writes go to the shared file.
const home = () => process.env.HOME || process.env.USERPROFILE || homedir();
export const SHARED_DIR = () => process.env.ENFORCER_HOME || join(home(), '.enforcer');
export const SHARED_FILE = () => join(SHARED_DIR(), 'credentials.json');
// Where enforcer-governor kept the credential before the shared file existed.
const LEGACY_FILE = join(process.env.GOVERNOR_HOME || join(home(), '.enforcer-governor'), 'credentials.json');
export const DEFAULT_BASE_URL = 'https://api.instruxi.dev';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** The stored credential document, shared file first. Null when there is none. */
export function readCredentials() {
  const shared = readJson(SHARED_FILE());
  if (shared?.enforcer) return shared;
  const legacy = readJson(LEGACY_FILE);
  return legacy?.enforcer ? legacy : null;
}

/**
 * Write the shared credential document. Atomic (write then rename) so a
 * concurrent reader — the MCP helper runs while hooks do — never sees half a
 * file, and 0600 in a 0700 directory because this is a bearer secret.
 */
export function saveCredentials(doc) {
  const dir = SHARED_DIR();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.credentials.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, SHARED_FILE());
}

/** Enforcer's public origin for this credential. */
export function baseUrl(cfg = {}) {
  const b = readCredentials()?.enforcer?.base_url || cfg.centralUrl || DEFAULT_BASE_URL;
  return String(b).replace(/\/+$/, '');
}

/**
 * The Enforcer API key, or null when the edge is unauthenticated — which is a
 * normal state, not an error: the governor enforces locally with no account at
 * all, and a credential only buys federation.
 *
 * The environment wins over the file so CI and containers can inject one
 * without writing to a home directory that may not persist.
 */
export function enforcerKey() {
  const env = process.env.ENFORCER_API_KEY;
  if (env && env.trim()) return env.trim();
  const k = readCredentials()?.enforcer?.api_key;
  return (typeof k === 'string' && k.trim()) ? k.trim() : null;
}

// Refresh this long before expiry, so a token is never presented with seconds
// left and rejected mid-flight.
const REFRESH_SKEW_MS = 60_000;

/**
 * Headers that authenticate a request to Enforcer, or {} when signed out.
 *
 * An API key wins over an OAuth token when both are present: it is the
 * credential an operator deliberately placed, and it does not expire.
 * An OAuth access token close to expiry is refreshed first (the refresh_token
 * grant, #361) and the rotated pair written back, because the refresh token
 * is single-use: dropping the successor would sign the machine out.
 *
 * Never throws. A failed refresh returns {} — signed out — rather than a token
 * the server is about to refuse.
 */
export async function authHeaders({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const key = enforcerKey();
  if (key) return { 'X-API-Key': key };
  const doc = readCredentials();
  const o = doc?.enforcer?.oauth;
  if (!o?.access_token) return {};
  if (!o.expires_at || Date.parse(o.expires_at) - now() > REFRESH_SKEW_MS) {
    return { Authorization: `Bearer ${o.access_token}` };
  }
  if (!o.refresh_token || !o.token_endpoint || !o.client_id || typeof fetchImpl !== 'function') return {};
  try {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: o.refresh_token, client_id: o.client_id });
    const res = await fetchImpl(o.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return {};
    const t = await res.json();
    if (!t?.access_token) return {};
    const next = {
      ...o,
      access_token: t.access_token,
      refresh_token: t.refresh_token || o.refresh_token,
      expires_at: new Date(now() + (Number(t.expires_in) || 900) * 1000).toISOString(),
      scope: t.scope || o.scope,
    };
    saveCredentials({ ...doc, enforcer: { ...doc.enforcer, oauth: next } });
    return { Authorization: `Bearer ${next.access_token}` };
  } catch { return {}; }
}

/**
 * A stable, non-secret identifier for the key that authenticated a segment.
 *
 * Derived by hashing, not by truncating. The obvious implementation takes the
 * readable prefix plus the first few characters of the secret — which is how
 * most consoles display a key, and it is fine on a screen the owner is already
 * looking at. It is NOT fine here: this value goes into every receipt and every
 * log line, where it outlives the key and travels further than it does. A hash
 * identifies the key just as stably while carrying none of it.
 */
export function keyId(key = enforcerKey()) {
  if (!key) return null;
  const [prefix] = key.split('_', 1);
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 10);
  return prefix && prefix !== key ? `${prefix}_${digest}` : digest;
}

/** Whether this install can talk to a control plane at all. */
export const isFederated = () => enforcerKey() !== null || !!readCredentials()?.enforcer?.oauth?.access_token;

/**
 * A stable, non-secret id for whatever credential is in use: the API key's
 * hash, or for an OAuth sign-in the client and account it belongs to (the
 * access token itself rotates every refresh, so it cannot name anything).
 */
export function credentialId() {
  const key = enforcerKey();
  if (key) return keyId(key);
  const o = readCredentials()?.enforcer?.oauth;
  if (!o?.client_id) return null;
  return 'oauth_' + createHash('sha256').update(`${o.client_id}:${o.account_id || ''}`).digest('hex').slice(0, 10);
}
