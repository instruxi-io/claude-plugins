// The one Node API client. Every caller (login, files, workspace, preflight,
// doctor, governor central/ship) goes through apiFetch/request so timeouts,
// retries, identity headers and error shape are decided in one place.
//
// Credentials: resolved by src/credentials.mjs authHeaders(): an API key
// (ENFORCER_API_KEY / saved key) beats a saved OAuth token.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authHeaders } from '../../src/credentials.mjs';

export const TIMEOUTS = { hook: 1500, cli: 10_000, dispatcher: 60_000 };
export const RETRY_STATUS = new Set([429, 502, 503, 504]);

let _version;
const version = () => {
  if (_version) return _version;
  try { _version = JSON.parse(readFileSync(new URL('../../plugin.json', import.meta.url), 'utf8')).version || 'unknown'; }
  catch { _version = 'unknown'; }
  return _version;
};

export const clientHeader = (hooks = process.env.ENFORCER_HOOKS === 'off' ? 'off' : 'on') => `enforcer-plugin/${version()}; hooks=${hooks}`;

export class ApiError extends Error {
  constructor({ status = 0, code = null, detail = '', retryAfter = null, requestId = null } = {}) {
    super(`HTTP ${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'ApiError';
    Object.assign(this, { status, code, detail, retryAfter, requestId });
  }
}

/** Retry-After: delta-seconds or an HTTP date -> milliseconds, or null. */
export function parseRetryAfter(v, now = Date.now) {
  if (v == null || v === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(v).trim())) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now());
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with timeout, retry (429/502/503/504 and network errors; never other
 * statuses), exponential backoff with jitter, Retry-After, and identity headers.
 * Returns the Response (any status once retries are spent).
 */
export async function apiFetch(url, init = {}, o = {}) {
  const {
    fetchImpl = globalThis.fetch, timeoutMs = TIMEOUTS.cli, retries = 2, baseDelayMs = 200, maxDelayMs = 10_000,
    sleep = defaultSleep, random = Math.random, auth = false, hooks,
  } = o;
  if (typeof fetchImpl !== 'function') throw new ApiError({ detail: 'no fetch in this runtime' });
  const requestId = randomUUID();
  const headers = {
    ...(auth ? await authHeaders({ fetchImpl }) : {}),
    ...(init.headers || {}),
    'X-Graph-Client': clientHeader(hooks),
    'X-Request-Id': requestId,
  };
  for (let attempt = 0; ; attempt++) {
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + random() / 2);
    let res;
    try {
      res = await fetchImpl(url, { ...init, headers, signal: init.signal || AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // A timeout/abort is the caller's budget spent: surface it as is, never retry.
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') { try { e.requestId = requestId; } catch {} throw e; }
      if (attempt >= retries) { try { e.requestId = requestId; } catch {} throw e; }
      await sleep(backoff);
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= retries) return res;
    const ra = parseRetryAfter(res.headers?.get?.('retry-after'));
    await sleep(ra != null ? ra : backoff);
  }
}

/** A fetch-shaped function with the client's behaviour, for the `fetchImpl` seams. */
export const clientFetch = (o = {}) => (url, init) => apiFetch(url, init, o);
export const defaultFetch = clientFetch();

/** Parse the server's {error, detail} body into an ApiError. */
export async function toApiError(res, requestId) {
  let b = {};
  try { b = await res.json(); } catch {}
  const err = b?.error;
  return new ApiError({
    status: res.status,
    code: (typeof err === 'object' ? err?.code : err) ?? b?.code ?? null,
    detail: (typeof b?.detail === 'string' ? b.detail : err?.message) || '',
    retryAfter: parseRetryAfter(res.headers?.get?.('retry-after')),
    requestId: requestId ?? res.headers?.get?.('x-request-id') ?? null,
  });
}

/** JSON request: returns the parsed body or throws ApiError. */
export async function request(url, init = {}, o = {}) {
  const res = await apiFetch(url, init, { auth: true, ...o });
  if (!res.ok) throw await toApiError(res, res.headers?.get?.('x-request-id'));
  if (res.status === 204) return null;
  try { return await res.json(); } catch { return null; }
}

// Hooks have a few seconds in total: short timeout, one quick retry at most.
export const hookFetch = clientFetch({ timeoutMs: TIMEOUTS.hook, retries: 1, baseDelayMs: 50, maxDelayMs: 200 });
