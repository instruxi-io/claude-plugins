// Launching workers: the claude/grok/codex command lines, the worker environment, detached spawn,
// and process-group kill (SIGTERM, a grace period, then SIGKILL) by process.kill(-pid).
import { spawn } from 'node:child_process';
import { readFileSync, openSync, closeSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOT } from '../../hooks/claude/paths.mjs';

export const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LAND_PR = join(PLUGIN_DIR, 'bin', 'land-pr.sh');
export const AGENT = process.env.GRAPH_DISPATCH_AGENT || 'enforcer:graph-worker';
export const GRAPH_TOOLS = ['graph_next_work', 'graph_heartbeat', 'graph_report', 'graph_remember', 'graph_plan_status'];
export const PREFIXES = ['mcp__plugin_enforcer_enforcer__', 'mcp__enforcer__', 'mcp__enforcer-graph__'];
export const BASE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'ToolSearch'];
export const HARNESSES = ['claude', 'codex', 'grok'];
export const HARNESS_CAPS = {
  claude: { supported: true, experimental: false, models: null },
  grok: { supported: true, experimental: true, models: ['grok'] },
  codex: { supported: false, experimental: false, models: ['gpt', 'o1', 'o3', 'o4', 'codex'],
           why: 'its `codex exec --json` event stream has no parser (no recorded sample), so workers would be launched and orphaned at the first reap' },
};

export const allowedTools = () => [...BASE_TOOLS, ...PREFIXES.flatMap((p) => GRAPH_TOOLS.map((t) => p + t))];

export function harnessKnowsModel(harness, model) {
  const pre = HARNESS_CAPS[harness]?.models;
  return Boolean(model) && (!pre || pre.some((p) => String(model).startsWith(p)));
}

/** The refusal message for a harness that cannot run workers, else null. */
export function harnessRefusal(harness, experimental) {
  const cap = HARNESS_CAPS[harness] || {};
  if (cap.supported === false) return `--harness ${harness} is not supported: ${cap.why || 'no capability'}`;
  if (cap.experimental && !experimental) return `--harness ${harness} is experimental: pass --experimental to use it`;
  return null;
}

export function pluginNameOf(d) {
  for (const rel of ['plugin.json', join(DOT + '-plugin', 'plugin.json')]) {
    try { const n = JSON.parse(readFileSync(join(d, rel), 'utf8')).name; if (n) return String(n); } catch { /* next */ }
  }
  return null;
}

/** This plugin, then each extra dir, once per real path AND once per plugin name (first wins):
 *  the same plugin twice means two governors answer every tool call. */
export function pluginDirs(extra = []) {
  const out = []; const seen = new Set(); const names = new Set();
  for (const d of [PLUGIN_DIR, ...(extra || [])]) {
    let r; try { r = realpathSync(d); } catch { r = d; }
    if (seen.has(r)) continue;
    const n = pluginNameOf(d);
    if (n && names.has(n)) continue;
    seen.add(r); if (n) names.add(n); out.push(d);
  }
  return out;
}

/** The only inherited variables: the operator's keys (ENFORCER_API_KEY, GRAPH_API_KEY, cloud keys, gh tokens) never pass. */
export const ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'GRAPH_ID', 'ENFORCER_HARNESS', 'JEV_HOOKS_HEADLESS', 'CLAUDE_PLUGIN_ROOT', 'ENFORCER_PLUGIN_ROOT'];
export const ENV_ALLOW_PREFIX = ['CLAUDE_', 'LC_'];
/** Scopes a worker token may carry: graph only. */
export const WORKER_SCOPES = ['graph:read', 'graph:write'];

const allowed = (k) => ENV_ALLOW.includes(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p));

/** The worker environment: the allowlist, the run's worker-scoped token (as GRAPH_API_KEY) and, if the operator
 *  provides one, a repo-scoped GH_TOKEN (ENFORCER_WORKER_GH_TOKEN). Nothing else. */
export function workerEnv(graphId, env = process.env, { token = null, release = false, runId = null } = {}) {
  const root = pluginDirs()[0];
  const out = {};
  for (const [k, v] of Object.entries(env)) if (allowed(k) && v !== undefined) out[k] = v;
  Object.assign(out, { GRAPH_ID: graphId, JEV_HOOKS_HEADLESS: '1', CLAUDE_PLUGIN_ROOT: root, ENFORCER_PLUGIN_ROOT: root });
  if (release) out.ENFORCER_RELEASE_NODE = '1';
  if (runId) { out.GRAPH_RUN_ID = String(runId); out.ENFORCER_GRAPH_RUN_ID = String(runId); }
  if (token) out.GRAPH_API_KEY = token;
  if (env.ENFORCER_WORKER_GH_TOKEN) out.GH_TOKEN = env.ENFORCER_WORKER_GH_TOKEN;
  return out;
}

/** Mint a worker-scoped credential for the run through the agent credential route; null when no worker agent is configured. */
export async function mintWorkerToken(api, env = process.env, name = 'graph-worker') {
  const agent = env.ENFORCER_WORKER_AGENT_ID;
  if (!agent) return null;
  const r = await api.call('POST', `/agents/${agent}/credentials`, { name, scopes: WORKER_SCOPES, expires_in_days: 1 });
  return r?.data?.secret || null;
}

/** The argv of a worker launch. `session` names (or with `resume`, continues) a claude session. */
export function launchCmd(prompt, model, args, key, { session = null, resume = false, maxTurns = null } = {}) {
  const harness = args.harness || 'claude';
  if (harness === 'grok') {
    const cmd = [args.grok || process.env.GROK_BIN || 'grok', '-p', prompt, '--output-format', 'streaming-messages-json'];
    if (harnessKnowsModel('grok', model)) cmd.push('--model', model);
    return cmd;
  }
  if (harness === 'codex') {
    const cmd = [args.codex || process.env.CODEX_BIN || 'codex', 'exec', '--json'];
    if (harnessKnowsModel('codex', model)) cmd.push('--model', model);
    return [...cmd, prompt];
  }
  const cmd = [args.agentBin || process.env.CLAUDE_BIN || 'claude', '-p', prompt, '--agent', AGENT, '--model', model];
  for (const d of pluginDirs(args.pluginDir)) cmd.push('--plugin-dir', d);
  if (session) cmd.push(resume ? '--resume' : '--session-id', session);
  if (maxTurns) cmd.push('--max-turns', String(maxTurns));
  cmd.push('--allowedTools', allowedTools().join(','), '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--name', 'graph:' + key);
  if (args.maxBudgetUsd) cmd.push('--max-budget-usd', String(args.maxBudgetUsd));
  return cmd;
}

/** A launched process: `detached` (its own session and group, group id = pid), output to a log file.
 *  .exited is null while it runs, then {code, signal}; .done resolves at exit. */
export function spawnWorker(cmd, { cwd, logPath, env = process.env }) {
  const fd = openSync(logPath, 'w');
  let child;
  try { child = spawn(cmd[0], cmd.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] }); } finally { closeSync(fd); }
  const p = { child, pid: child.pid, exited: null, returncode: null };
  p.done = new Promise((res) => {
    child.on('error', (e) => { if (!p.exited) { p.exited = { code: 127, signal: null, error: e }; p.returncode = 127; res(p.exited); } });
    child.on('exit', (code, signal) => {
      p.exited = { code, signal };
      p.returncode = code ?? (signal === 'SIGKILL' ? 137 : 143);
      res(p.exited);
    });
  });
  child.unref?.();
  return p;
}
export const alive = (p) => p != null && p.exited === null;

const sig = (pid, n) => { try { process.kill(-pid, n); return true; } catch { return false; } };

/** SIGTERM the worker's process group, wait `grace` ms, then SIGKILL it. Resolves once it has exited (or 10 s after KILL). */
export async function killGroup(p, grace = 30000, killWait = 10000) {
  if (!alive(p)) return;
  const wait = (ms) => new Promise((r) => { const t = setTimeout(() => r('timeout'), ms); p.done.then(() => { clearTimeout(t); r('exit'); }); });
  sig(p.pid, 'SIGTERM');
  if ((await wait(grace)) === 'timeout') { sig(p.pid, 'SIGKILL'); await wait(killWait); }
}

/** True when pid is alive and a session leader (pgid == pid): how a worker we launched looks; a recycled pid usually is not. */
export function pidAliveGroup(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { process.kill(-pid, 0); return true; } catch { return false; }
}
