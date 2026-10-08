// A long tool call (a CI watch, a sleep loop) fires no PostToolUse, so the boundary heartbeat alone lets the
// lease lapse under a live worker. PreToolUse on a Bash call starts a detached ticker that heartbeats every
// lease/3 until PostToolUse/PostToolUseFailure for that tool_use_id, SessionEnd, Stop, or the first heartbeat
// answer that is not `ok` (the ticker never keeps a lease alive after the run ended or was reclaimed).
// One marker file per call (runs/<actor>.tick-<tool_use_id>): the ticker runs while its marker exists.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actorKey, dataDir, privateWrite } from '../state.mjs';
import { loadRun, saveRun } from '../run.mjs';
import { httpResult } from '../http.mjs';
import { isGraphTool } from './common.mjs';
import { beat, leaseSeconds } from './heartbeat.mjs';

const safe = (id) =>
  String(id || 'x')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80);
const marker = (sid, id) => join(dataDir(), `${sid}.tick-${safe(id)}`);
const MAX_SECONDS = () => {
  const v = parseFloat(process.env.GRAPH_TICK_MAX_SECONDS ?? '7200');
  return Number.isFinite(v) ? v : 7200;
};
export const tickSeconds = (run) => {
  const v = parseFloat(process.env.GRAPH_TICK_SECONDS ?? '');
  return Number.isFinite(v) && v > 0 ? v : leaseSeconds(run) / 3;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PreToolUse on Bash: start the ticker when this actor holds a live run. Never throws, never blocks. */
export async function startTicker(inp) {
  try {
    if (inp.tool_name !== 'Bash' || isGraphTool(inp.tool_name)) return null;
    const sid = actorKey(inp);
    const run = loadRun(sid);
    if (!run || run.reclaimed) return null;
    privateWrite(marker(sid, inp.tool_use_id), String(Date.now()));
    const slim = { session_id: inp.session_id, agent_id: inp.agent_id, cwd: inp.cwd, transcript_path: inp.transcript_path, tool_use_id: inp.tool_use_id };
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'ticker-run.mjs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ENFORCER_TICKER_INPUT: JSON.stringify(slim) },
    });
    child.unref();
  } catch {}
  return null;
}

/** PostToolUse / PostToolUseFailure (that call's marker) and SessionEnd / Stop / SubagentStop (all of the actor's). */
export async function stopTicker(inp) {
  try {
    const sid = actorKey(inp);
    const ev = inp.hook_event_name || '';
    if (/^(PostToolUse|PostToolUseFailure)$/.test(ev) && inp.tool_name === 'Bash') {
      rmSync(marker(sid, inp.tool_use_id), { force: true });
      return null;
    }
    if (/^(SessionEnd|Stop|SubagentStop)$/.test(ev)) {
      const d = dataDir();
      for (const n of readdirSync(d)) if (n.startsWith(`${sid}.tick-`)) rmSync(join(d, n), { force: true });
    }
  } catch {}
  return null;
}

/** The ticker process body. Resolves with why it stopped. */
export async function tickLoop(inp, post = httpResult) {
  const sid = actorKey(inp);
  const mk = marker(sid, inp.tool_use_id);
  const t0 = Date.now();
  let misses = 0,
    every = null; // the interval comes from the claimed lease; later heartbeats stretch lease_expires_at
  for (;;) {
    let run = loadRun(sid);
    if (!run || run.reclaimed) return 'no-run';
    every ??= tickSeconds(run);
    await sleep(every * 1000);
    if (!existsSync(mk)) return 'stopped';
    if (Date.now() - t0 > MAX_SECONDS() * 1000) {
      rmSync(mk, { force: true });
      return 'max-lifetime';
    }
    run = loadRun(sid);
    if (!run || run.reclaimed) return 'no-run';
    const state = await beat(inp, run, sid, Date.now() / 1000, post);
    if (!existsSync(mk)) return 'stopped';
    if (state === 'ok') {
      misses = 0;
      continue;
    }
    if (!state && ++misses < 3) continue; // a transient miss (network, 5xx); three in a row stop it
    // cancel_requested / reclaimed / finished / unknown: stop, and leave the word for the next PostToolUse
    const cur = loadRun(sid) || run;
    if (state) {
      cur.pending_state = state;
      saveRun(sid, cur);
    }
    rmSync(mk, { force: true });
    return state || 'unreachable';
  }
}
