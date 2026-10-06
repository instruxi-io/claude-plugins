// One hook process per event: `enforcer event <name>` runs the governor's decision and the graph
// handlers in this process and prints ONE merged JSON answer. Python starts only when a graph
// context is live (a run file for the actor, GRAPH_ID, or a project graph config).
// child_process loads lazily: the no-graph hot path never spawns, and the module costs milliseconds.
const spawnSync = (...a) => process.getBuiltinModule('node:child_process').spawnSync(...a);
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stateBase } from './state.mjs';
import { LEGACY_PROJECT_CONFIG } from '../hooks/claude/paths.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
export const GRAPH_TOOL = /^mcp__(plugin_enforcer_enforcer|enforcer|enforcer-graph)__graph_/;
const STAMPED = /^mcp__(plugin_enforcer_enforcer|enforcer|enforcer-graph)__graph_(next_work|heartbeat|report)$/;
const PRE_GRAPH = /^mcp__(plugin_enforcer_enforcer|enforcer|enforcer-graph)__graph_(next_work|report|remember|heartbeat)$/;
const POST_GRAPH = /^mcp__(plugin_enforcer_enforcer|enforcer|enforcer-graph)__graph_(next_work|report|heartbeat)$/;

// Same key as lib/graph/lib.py actor_key: sha256("agent_id:<id>")[:32] for a subagent, else session_id.
export function actorKey(ev) {
  if (ev.agent_id) return process.getBuiltinModule('node:crypto').createHash('sha256').update(`agent_id:${ev.agent_id}`).digest('hex').slice(0, 32);
  return ev.session_id || 'unknown';
}

export function graphContextLive(ev) {
  if (process.env.GRAPH_ID) return true;
  // graph_* tool handlers (track-run, attach-evidence, open-run-guard) create or need the run: never gate them
  if (GRAPH_TOOL.test(ev.tool_name || '')) return true;
  const sid = ev.session_id;
  const data = stateBase();
  if (existsSync(join(data, 'runs', `${actorKey(ev)}.json`))) return true;
  if (sid && existsSync(join(data, 'runs', `${sid}.live`))) return true;
  if (sid && existsSync(join(data, 'runs', `${sid}.json`))) return true;
  let d = ev.cwd || process.cwd();
  for (;;) {
    if (existsSync(join(d, '.enforcer', 'graph.json')) || existsSync(join(d, LEGACY_PROJECT_CONFIG))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}

export const python3Missing = () => { const r = spawnSync('python3', ['--version'], { stdio: 'ignore' }); return !!r.error || r.status === null; };

// event -> { gov: governor shim, budget: ms for the python handlers }
const EVENTS = {
  PreToolUse: { gov: 'pre-tool-use.mjs', budget: 28000 },
  PostToolUse: { gov: 'post-tool-use.mjs', budget: 4500 },
  PostToolUseFailure: { budget: 4500 },
  SessionStart: { gov: 'session.mjs', budget: 9000 },
  SessionEnd: { gov: 'session.mjs' },
  UserPromptSubmit: { gov: 'user-prompt-submit.mjs' },
  SubagentStart: { gov: 'subagent.mjs' },
  PreCompact: { budget: 9000 },
  SubagentStop: { budget: 4500 },
  Stop: { budget: 4500 },
};
const NAMES = Object.fromEntries(Object.keys(EVENTS).map((k) => [k.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(), k]));
export const EVENT_NAMES = Object.keys(NAMES);

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const JOIN = new Set(['additionalContext', 'systemMessage', 'reason']);
// Merge two hook answers: text channels join, a stricter permission decision wins, the rest layer.
export function merge(a, b) {
  if (!isObj(a)) return b;
  if (!isObj(b)) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'permissionDecision') { const rank = { allow: 1, defer: 1, ask: 2, deny: 3 }; if ((rank[v] || 0) > (rank[a[k]] || 0)) out[k] = v; }
    else if (JOIN.has(k) && typeof v === 'string' && typeof a[k] === 'string') out[k] = `${a[k]}\n${v}`;
    else if (isObj(v) && isObj(a[k])) out[k] = merge(a[k], v);
    else out[k] = v;
  }
  return out;
}

async function governor(file, raw) {
  const st = globalThis.__enforcerEvent = { input: raw, out: '' };
  const { HookExit } = await import('../lib/governor/hooks/lib.mjs');
  try { await import(`../lib/governor/hooks/${file}`); }
  catch (e) { if (!(e instanceof HookExit)) { try { process.stderr.write(`enforcer: governor hook failed: ${e?.message || e}\n`); } catch {} } }
  globalThis.__enforcerEvent = undefined;
  try { return st.out ? JSON.parse(st.out) : null; } catch { return null; }
}

function python(handlers, raw, deadline) {
  let out = null; let code = 0;
  for (const h of handlers) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const r = spawnSync('python3', [root(`lib/graph/${h}.py`)], { input: raw, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], timeout: left });
    if (r.status) code = r.status;
    const t = (r.stdout || '').trim();
    if (t) { try { out = merge(out, JSON.parse(t)); } catch { try { process.stderr.write(t + '\n'); } catch {} } }
  }
  return { out, code };
}

// PostToolUse and PostToolUseFailure handlers run in this process: no python on the hot path.
const NATIVE = { track_run: ['track-run', 'trackRun'], capture_evidence: ['capture', 'captureEvidence'], heartbeat: ['heartbeat', 'heartbeat'] };
export async function native(handlers, ev, deadline) {
  let out = null;
  for (const h of handlers) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let timer;
    try {
      const mod = await import(`./graph/hooks/${NATIVE[h][0]}.mjs`);
      const r = await Promise.race([mod[NATIVE[h][1]](ev), new Promise((res) => { timer = setTimeout(() => res(null), left); })]);
      if (r) out = merge(out, r);
    } catch {} finally { clearTimeout(timer); }
  }
  return { out, code: 0 };
}

export async function runEvent(name) {
  const event = NAMES[name];
  if (!event) { process.stderr.write(`usage: enforcer event <${EXIT_NAMES()}>\n`); return 2; }
  const spec = EVENTS[event];
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch {}
  let ev = {};
  try { ev = JSON.parse(raw || '{}') || {}; } catch {}
  if (!isObj(ev)) ev = {};
  // The harness names the event itself; a shim routed an event it does not own stays silent.
  let out = null;
  if (spec.gov) out = await governor(spec.gov, raw);
  const denied = out?.hookSpecificOutput?.permissionDecision === 'deny';
  let handlers = [];
  const tool = ev.tool_name || '';
  if (event === 'PreToolUse' && PRE_GRAPH.test(tool)) handlers = ['attach_evidence'];
  else if (event === 'PostToolUse') handlers = [...(POST_GRAPH.test(tool) ? ['track_run'] : []), 'capture_evidence', 'heartbeat'];
  else if (event === 'PostToolUseFailure') handlers = ['capture_evidence', 'heartbeat'];
  else if (event === 'SessionStart' && (!ev.source || /^(startup|resume|compact|clear)$/.test(ev.source))) handlers = ['session_start'];
  else if (event === 'PreCompact') handlers = ['remember_on_compact'];
  else if (event === 'Stop' || event === 'SubagentStop') handlers = ['open_run_guard'];
  if (denied) handlers = [];
  let code = 0;
  if (handlers.length) {
    const stamped = event === 'PreToolUse' && STAMPED.test(tool);
    const noPy = (event === 'SessionStart' || stamped) && python3Missing();
    if (noPy && event === 'SessionStart') {
      const msg = 'enforcer: python3 is not on PATH, so the graph hooks (evidence capture, heartbeats, attestation) cannot run. Install python3, then run `enforcer doctor`. Graph calls are attested hooks=off:python3.';
      out = merge(out, { systemMessage: msg, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg } });
    } else if (noPy && stamped) {
      const v = (() => { try { return JSON.parse(readFileSync(root('plugin.json'), 'utf8')).version; } catch { return 'unknown'; } })();
      out = merge(out, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...(ev.tool_input || {}), client: `enforcer-graph-plugin/${v}; hooks=off:python3` } } });
    } else if (!noPy && (event === 'SessionStart' || graphContextLive(ev))) { // session-start notices print with or without a graph
      const deadline = Date.now() + (spec.budget || 5000);
      const r = handlers.every((h) => NATIVE[h]) ? await native(handlers, ev, deadline) : python(handlers, raw, deadline);
      out = merge(out, r.out); code = r.code;
    }
  }
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
  return code;
}
const EXIT_NAMES = () => EVENT_NAMES.join('|');
