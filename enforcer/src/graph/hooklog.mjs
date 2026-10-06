// Opt-in structured hook log (ENFORCER_DEBUG=1) with size rotation, plus a one-shot note after repeated failures.
import { statSync, renameSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateBase, privateDir, privateWrite } from './state.mjs';

export const MAX_BYTES = 10 * 1024 * 1024;
export const FAIL_LIMIT = 3;
export const logPath = () => join(stateBase(), 'hooks.log.jsonl');
export const debugOn = () => /^(1|true|yes|on)$/i.test(String(process.env.ENFORCER_DEBUG || ''));

/** Two generations: hooks.log.jsonl and hooks.log.jsonl.1. */
export function rotate(path, max = MAX_BYTES) {
  try {
    if (statSync(path).size < max) return false;
    if (existsSync(`${path}.1`)) rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
    return true;
  } catch { return false; }
}

export function logHook({ hook, event, actor, outcome, ms, code, run_id = process.env.GRAPH_RUN_ID || process.env.ENFORCER_GRAPH_RUN_ID || undefined }, { force = false, max = MAX_BYTES } = {}) {
  if (!force && !debugOn()) return false;
  try {
    privateDir(stateBase());
    const p = logPath();
    rotate(p, max);
    privateWrite(p, JSON.stringify({ ts: new Date().toISOString(), hook, event, actor, outcome, ms, code, run_id }) + '\n', 'a');
    return true;
  } catch { return false; }
}

/** Count a failure of `hook` in `session`; returns the one-line note on the FAIL_LIMIT-th failure only. */
export function noteFailure(session, hook) {
  try {
    const dir = privateDir(join(stateBase(), 'hookfail'));
    const f = join(dir, String(session || 'unknown').replace(/[^\w.-]/g, '_'));
    let st = {};
    try { st = JSON.parse(readFileSync(f, 'utf8')) || {}; } catch {}
    st[hook] = (st[hook] || 0) + 1;
    privateWrite(f, JSON.stringify(st));
    if (st[hook] === FAIL_LIMIT) return `enforcer: hook ${hook} has failed ${FAIL_LIMIT} times this session; see ${logPath()} (set ENFORCER_DEBUG=1 to record hook runs).`;
  } catch {}
  return null;
}
