// One mapping from the server's machine codes to what a person and what the model are told.
// `describe` is pure; `announce` makes a code speak once per session (then it only goes to the local log);
// `notice` / `warningNotices` are what the hooks call.
import { join } from 'node:path';
import { stateBase } from './state.mjs';
import { privateDir, privateWrite } from './graph/state.mjs';
import { readFileSync } from 'node:fs';
import { logHook } from './graph/hooklog.mjs';

const str = (x) => (typeof x === 'string' ? x : '');
const errObj = (b) => (b && typeof b.error === 'object' && b.error ? b.error : {});

/** The machine code of an error body: error.code, a string `error`, or `code`. */
export function codeOf(body, status = 0) {
  const e = errObj(body);
  return str(e.code) || str(body?.error) || str(body?.code) || (status === 401 ? 'unauthenticated' : '');
}

/**
 * @param {{status:number, code?:string, body?:object, message?:string}} err  an ApiError, or {status, body}
 * @param {{run?:boolean}} ctx  `run`: the call was about a run the session holds
 * @returns {{code:string, user:string, model:string, retried:boolean, quiet?:boolean}|null}
 */
export function describe(err, ctx = {}) {
  if (!err) return null;
  const status = Number(err.status) || 0;
  const body = err.body && typeof err.body === 'object' ? err.body : {};
  const code = err.code || codeOf(body, status);
  const e = errObj(body);
  const detail = str(err.detail) || str(e.message) || str(body.message) || str(body.detail);
  if (status === 401 || code === 'unauthenticated' || code === 'token_expired') return {
    code: 'unauthenticated', retried: false,
    user: 'Enforcer: you are not signed in (or the sign-in expired). Run /enforcer:login.',
    model: 'Enforcer rejected the credential (401). Do not retry; tell the user to run /enforcer:login.' };
  if (code === 'insufficient_scope') {
    const scope = str(body.scope) || str(body.required_scope) || str(e.scope) || (/scope[:\s]+([\w:.-]+)/i.exec(detail)?.[1]) || 'the required scope';
    return { code, retried: false,
      user: `Enforcer: this sign-in lacks the scope ${scope}. Ask an admin to widen it, then sign in again with /enforcer:login --for admin.`,
      model: `403 insufficient_scope: the credential lacks ${scope}. Do not retry; report it. Signing in again with \`--for admin\` grants it.` };
  }
  if (code === 'billing_restricted') return { code, retried: false,
    user: `Enforcer: this workspace's billing is restricted${detail ? ` (${detail})` : ''}. Reads still work; changes are paused until billing is sorted out.`,
    model: '403 billing_restricted: writes are paused for this workspace. Continue read-only work and tell the user.' };
  if (code === 'client_attestation_required' || code === 'client_outdated') {
    const min = str(body.min_client_version) || str(e.min_client_version) || str(body.minimum_version) || 'a newer version';
    return { code: 'client_attestation_required', retried: false,
      user: `Enforcer: this plugin is too old for the server (minimum ${min}). Update the plugin, then restart.`,
      model: `409 client_attestation_required: the plugin must be at least ${min}. Tell the user to update the enforcer plugin; do not retry.` };
  }
  if (code === 'run_already_ended') return { code, retried: false,
    user: 'Enforcer: this run has already finished; nothing further to report.',
    model: 'The run has already ended (409 run_already_ended). Stop working it and call graph_next_work for the next node.' };
  if (status === 404 && ctx.run) return { code: 'run_reclaimed', retried: false,
    user: 'Enforcer: the lease on this run lapsed and another worker now owns the node.',
    model: 'The run was reclaimed (404): another harness owns the node. Stop; a report from this run will be refused.' };
  if (status === 429 || status >= 500) return { code: status === 429 ? 'rate_limited' : 'server_error', retried: true, quiet: true,
    user: '', model: '' };
  return null;
}

const file = (sid) => join(stateBase(), 'errors', `${String(sid || 'unknown').replace(/[^\w.-]/g, '_')}.json`);

/** True the first time `code` is announced in this session; the occurrence is always logged locally. */
export function announce(sid, code) {
  let seen = {};
  try { seen = JSON.parse(readFileSync(file(sid), 'utf8')) || {}; } catch {}
  logHook({ hook: 'errors', event: 'announce', actor: sid, outcome: seen[code] ? 'repeat' : 'first', ms: 0, code }, { force: true });
  if (seen[code]) return false;
  try { privateDir(join(stateBase(), 'errors')); seen[code] = 1; privateWrite(file(sid), JSON.stringify(seen)); } catch {}
  return true;
}

/** The hook answer for an error: { systemMessage, additionalContext } once per code per session, else null. */
export function notice(sid, err, ctx = {}) {
  const d = describe(err, ctx);
  if (!d || d.quiet) { if (d) logHook({ hook: 'errors', event: 'retried', actor: sid, outcome: 'quiet', ms: 0, code: d.code }, { force: true }); return null; }
  return announce(sid, d.code) ? { systemMessage: d.user, additionalContext: d.model, code: d.code } : null;
}

const WARNINGS = {
  hooks_inactive: (w) => `Enforcer: the server sees no active hooks for this client${w.message ? ` (${w.message})` : ''}; run evidence is not being captured. Check /enforcer:doctor.`,
  client_outdated: (w) => `Enforcer: this plugin is older than the server wants${w.min_client_version ? ` (minimum ${w.min_client_version})` : ''}. Update the plugin.`,
};

/** The server's warnings[] (strings or {code, message}), each surfaced once per session. Returns the lines to say. */
export function warningNotices(sid, warnings) {
  const out = [];
  for (const w of Array.isArray(warnings) ? warnings : []) {
    const o = typeof w === 'string' ? { code: w } : w && typeof w === 'object' ? w : null;
    const code = o?.code;
    if (!code) continue;
    const text = (WARNINGS[code] || ((x) => `Enforcer: ${x.message || code}`))(o);
    if (announce(sid, `warning:${code}`)) out.push(text);
  }
  return out;
}
