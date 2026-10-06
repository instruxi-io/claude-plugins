// How the edge proves who it is to the control plane.
//
// The design originally called for an Ed25519 device key per install, with the
// server verifying a signature on every receipt segment. That is the right
// shape only where the key has real custody. In a Claude Code plugin it does
// not: the runtime is Node, so the OS keychain's registered application is
// `node` — a generic interpreter it cannot distinguish from any other script
// the user runs. A private key sitting in a file readable by anything running
// as that user IS a bearer token, and dressing it in a signature ceremony
// makes it look like non-repudiation without providing any.
//
// So the edge presents an Enforcer API key instead, and the platform's
// existing machinery does the rest: ResolveUser turns the credential into an
// accessor, and rotation, revocation and scoping already exist rather than
// being reinvented here.
//
// What that keeps: the hash chain still detects edits and deletions, and the
// server still refuses a segment whose prev_hash does not match the head it
// holds for that key, so a stolen key can only ever append to its own chains.
// What it gives up, and this belongs in the ADR rather than a footnote: "this
// device signed it" becomes "someone holding this key sent it", which is a
// weaker claim to put in front of an auditor.
//
// The receipt format is kept signature-READY against the day that matters —
// key_id names what authenticated a segment, sig sits null. Adopting device
// keys later is then a column filling in, not a migration and a re-chaining of
// history. key_id also means a revoked key's segments stay identifiable after
// the fact, which is most of what a device id was for.

import { readFileSync, mkdirSync, renameSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, rmdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DIR } from './store.mjs';

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
const LEGACY_FILE = join(DIR, 'credentials.json');
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
  try { chmodSync(dir, 0o700); } catch { /* not ours to chmod */ }
  const tmp = join(dir, `.credentials.${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(doc, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, 0o600);
  renameSync(tmp, SHARED_FILE());
}

/**
 * Origins a token_endpoint or saved base_url may point at. Both come from
 * files an agent can write, so without this a planted file would have the
 * refresh token POSTed to an attacker. https only, and only the production
 * origin or the one the operator set in ENFORCER_BASE_URL.
 */
export function allowedOrigins() {
  const out = new Set([new URL(DEFAULT_BASE_URL).origin]);
  try { if (process.env.ENFORCER_BASE_URL) out.add(new URL(process.env.ENFORCER_BASE_URL).origin); } catch { /* ignore */ }
  return out;
}
export function isAllowedUrl(u) {
  try {
    const url = new URL(String(u));
    if (!allowedOrigins().has(url.origin)) return false;
    // https required, except for an origin the operator named in the environment.
    return url.protocol === 'https:' || (!!process.env.ENFORCER_BASE_URL && url.origin === new URL(process.env.ENFORCER_BASE_URL).origin);
  } catch { return false; }
}

/**
 * A saved base_url may be any https origin (self-hosted and staging installs
 * sign in to their own), or plain http to the loopback for local development.
 * Anything else is ignored. token_endpoint is stricter: isAllowedUrl.
 */
export function isSafeBase(u) {
  if (isAllowedUrl(u)) return true;
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.host.replace(/:\d+$/, '')));
  } catch { return false; }
}

// One refresh lock for Node and Python: a directory, because mkdir is atomic
// everywhere and both languages can use it (flock is not visible across them).
// A holder that died leaves a directory behind; past STALE_MS it is broken.
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const refreshLockPath = () => join(SHARED_DIR(), '.refresh.lock');

/** Acquire the shared refresh lock; returns a release function, or null on timeout. */
export async function acquireRefreshLock(timeoutMs = LOCK_TIMEOUT_MS) {
  const dir = SHARED_DIR();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not ours */ }
  const lock = refreshLockPath();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); return () => { try { rmdirSync(lock); } catch { /* gone */ } }; }
    catch (e) {
      if (e.code !== 'EEXIST') return null;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue; } } catch { /* raced */ }
    }
    if (Date.now() >= deadline) return null;
    await sleep(25);
  }
}

/** Enforcer's public origin for this credential. */
export function baseUrl(cfg = {}) {
  const saved = readCredentials()?.enforcer?.base_url;
  const b = (saved && isSafeBase(saved) ? saved : null) || cfg.centralUrl || DEFAULT_BASE_URL;
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
  const stale = { Authorization: `Bearer ${o.access_token}` };
  if (!o.refresh_token || !o.token_endpoint || !o.client_id || typeof fetchImpl !== 'function') return {};
  if (!isAllowedUrl(o.token_endpoint)) return {};
  const release = await acquireRefreshLock();
  // A hook has a few seconds in total; if another process holds the lock
  // that long, use the token we have rather than block or lose it.
  if (!release) return stale;
  try {
    // Re-read under the lock: whoever held it before us may have rotated the pair.
    const cur = readCredentials();
    const c = cur?.enforcer?.oauth;
    if (c?.access_token && c.expires_at && Date.parse(c.expires_at) - now() > REFRESH_SKEW_MS) {
      return { Authorization: `Bearer ${c.access_token}` };
    }
    const doc2 = cur || doc; const o2 = c || o;
    if (!o2.refresh_token || !isAllowedUrl(o2.token_endpoint)) return {};
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: o2.refresh_token, client_id: o2.client_id || o.client_id });
    const res = await fetchImpl(o2.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(1800),
    });
    if (!res.ok) return {};
    const t = await res.json();
    if (!t?.access_token) return {};
    const next = {
      ...o2,
      access_token: t.access_token,
      refresh_token: t.refresh_token || o2.refresh_token,
      expires_at: new Date(now() + (Number(t.expires_in) || 900) * 1000).toISOString(),
      scope: t.scope || o2.scope,
    };
    saveCredentials({ ...doc2, enforcer: { ...doc2.enforcer, oauth: next } });
    return { Authorization: `Bearer ${next.access_token}` };
  } catch { return stale; } finally { release(); }
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
