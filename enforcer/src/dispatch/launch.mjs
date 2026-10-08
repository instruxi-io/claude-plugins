// Launching workers: the claude/grok/codex command lines, the worker environment, detached spawn,
// and process-group kill (SIGTERM, a grace period, then SIGKILL) by process.kill(-pid).
import { spawn } from 'node:child_process';
import { readFileSync, closeSync, realpathSync, openSync, writeSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { openStream, redactFile } from './logs.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOT } from '../../hooks/claude/paths.mjs';
import { PROFILE_NAME } from '../../lib/governor/profiles/headless-worker.mjs';

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
  codex: {
    supported: false,
    experimental: false,
    models: ['gpt', 'o1', 'o3', 'o4', 'codex'],
    why: 'its `codex exec --json` event stream has no parser (no recorded sample), so workers would be launched and orphaned at the first reap',
  },
};

/** Per-launch settings: the installed release is off for the child, so the --plugin-dir checkout is the only copy of the hooks and MCP server. */
export const DISABLED_PLUGINS = { 'enforcer@instruxi': false };
export const workerSettings = () => JSON.stringify({ enabledPlugins: DISABLED_PLUGINS });

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
    try {
      const n = JSON.parse(readFileSync(join(d, rel), 'utf8')).name;
      if (n) return String(n);
    } catch {
      /* next */
    }
  }
  return null;
}

/** This plugin, then each extra dir, once per real path AND once per plugin name (first wins):
 *  the same plugin twice means two governors answer every tool call. */
export function pluginDirs(extra = []) {
  const out = [];
  const seen = new Set();
  const names = new Set();
  for (const d of [PLUGIN_DIR, ...(extra || [])]) {
    let r;
    try {
      r = realpathSync(d);
    } catch {
      r = d;
    }
    if (seen.has(r)) continue;
    const n = pluginNameOf(d);
    if (n && names.has(n)) continue;
    seen.add(r);
    if (n) names.add(n);
    out.push(d);
  }
  return out;
}

/** The only inherited variables: the operator's keys (ENFORCER_API_KEY, GRAPH_API_KEY, cloud keys, gh tokens) never pass. */
export const ENV_ALLOW = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'GRAPH_ID',
  'ENFORCER_PROFILE',
  'ENFORCER_GOVERNOR_RULES',
  'ENFORCER_HARNESS',
  'JEV_HOOKS_HEADLESS',
  'CLAUDE_PLUGIN_ROOT',
  'ENFORCER_PLUGIN_ROOT',
];
export const ENV_ALLOW_PREFIX = ['CLAUDE_', 'LC_'];
/** The owner's default for whether dispatched workers run with the worker rules on: decisioning is off unless configured. The one place to change it. */
export const DEFAULT_WORKER_RULES = 'off';
export const WORKER_RULES_MODES = ['on', 'off'];
/** The one preflight line that states the mode. */
export const workerRulesLine = (mode = DEFAULT_WORKER_RULES) =>
  mode === 'on'
    ? 'workers run with the worker rules ON (pass --worker-rules off to relax them)'
    : 'workers run with the worker rules OFF (pass --worker-rules on to enforce them)';
/** Scopes a worker token may carry: graph only. */
export const WORKER_SCOPES = ['graph:read', 'graph:write'];

const allowed = (k) => ENV_ALLOW.includes(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p));

/** The worker environment: the allowlist, the run's worker-scoped token (as GRAPH_API_KEY) and, if the operator
 *  provides one, a repo-scoped GH_TOKEN (ENFORCER_WORKER_GH_TOKEN). Nothing else. */
export function workerEnv(graphId, env = process.env, { token = null, release = false, runId = null, workerRules = DEFAULT_WORKER_RULES } = {}) {
  const root = pluginDirs()[0];
  const out = {};
  for (const [k, v] of Object.entries(env)) if (allowed(k) && v !== undefined) out[k] = v;
  Object.assign(out, {
    GRAPH_ID: graphId,
    ENFORCER_PROFILE: PROFILE_NAME, // = PROFILE_ENV
    JEV_HOOKS_HEADLESS: '1',
    CLAUDE_PLUGIN_ROOT: root,
    ENFORCER_PLUGIN_ROOT: root,
  });
  out.ENFORCER_GOVERNOR_RULES = workerRules === 'on' ? 'on' : 'off'; // always set from the flag: an inherited value never decides
  if (release) out.ENFORCER_RELEASE_NODE = '1';
  if (runId) {
    out.GRAPH_RUN_ID = String(runId);
    out.ENFORCER_GRAPH_RUN_ID = String(runId);
  }
  // The worker's credential has two readers: the graph hooks read GRAPH_API_KEY, but the plugin's MCP header helper (bin/enforcer-headers.mjs,
  // src/credentials.mjs) reads ENFORCER_API_KEY and otherwise falls back to the OPERATOR's saved sign-in, so a claim made through the MCP tools
  // would be attributed to the operator, not the agent. Give both the same token. The operator's own ENFORCER_API_KEY is still never inherited.
  if (token) {
    out.GRAPH_API_KEY = token;
    out.ENFORCER_API_KEY = token;
  }
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

/** The worker's own MCP connection when it runs as an agent: Claude Code prefers its stored `/mcp` OAuth sign-in for the plugin's
 *  server over the headersHelper, so the environment cannot make the plugin's server speak as the agent. A per-run config with the
 *  agent key as a header, launched with --strict-mcp-config, leaves the stored sign-in and every other MCP server out of the picture. */
export const agentMcpConfig = (mcpUrl, agentKey) => ({ mcpServers: { enforcer: { type: 'http', url: mcpUrl, headers: { 'X-API-Key': agentKey } } } });
export const mcpConfigPath = (stateDir, key) => join(stateDir, `mcp-${key}.json`);

/** Write `<stateDir>/mcp-<key>.json` at 0600 (created with that mode, never world-readable for a moment); returns its path. */
export function writeAgentMcpConfig(stateDir, key, mcpUrl, agentKey) {
  const p = mcpConfigPath(stateDir, key);
  rmSync(p, { force: true });
  const fd = openSync(p, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(agentMcpConfig(mcpUrl, agentKey)));
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best effort on platforms without modes */
  }
  return p;
}

/** Remove one config file, or with no key every `mcp-*.json` left in the state dir (dispatcher shutdown). */
export function removeAgentMcpConfigs(stateDir, key = null) {
  if (key) {
    rmSync(mcpConfigPath(stateDir, key), { force: true });
    return;
  }
  let names = [];
  try {
    names = readdirSync(stateDir);
  } catch {
    return;
  }
  for (const n of names) if (/^mcp-.+\.json$/.test(n)) rmSync(join(stateDir, n), { force: true });
}

/** The argv of a worker launch. `session` names (or with `resume`, continues) a claude session. */
export function launchCmd(prompt, model, args, key, { session = null, resume = false, maxTurns = null, mcpConfig = null } = {}) {
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
  cmd.push('--settings', workerSettings());
  // Only an agent run gets its own connection: the path is in argv, the key is only inside the 0600 file.
  if (args.agent && mcpConfig) cmd.push('--mcp-config', mcpConfig, '--strict-mcp-config');
  if (session) cmd.push(resume ? '--resume' : '--session-id', session);
  if (maxTurns) cmd.push('--max-turns', String(maxTurns));
  cmd.push('--allowedTools', allowedTools().join(','), '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--name', 'graph:' + key);
  if (args.maxBudgetUsd) cmd.push('--max-budget-usd', String(args.maxBudgetUsd));
  return cmd;
}

/** A launched process: `detached` (its own session and group, group id = pid), output to a log file.
 *  .exited is null while it runs, then {code, signal}; .done resolves at exit. */
export function spawnWorker(cmd, { cwd, logPath, env = process.env, cleanup = [], secrets = [] }) {
  const tidy = () => {
    for (const f of cleanup)
      try {
        rmSync(f, { force: true });
      } catch {
        /* gone */
      }
  };
  const fd = openStream(logPath);
  let child;
  try {
    child = spawn(cmd[0], cmd.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
  const p = { child, pid: child.pid, exited: null, returncode: null };
  p.done = new Promise((res) => {
    child.on('error', (e) => {
      if (!p.exited) {
        tidy();
        p.exited = { code: 127, signal: null, error: e };
        p.returncode = 127;
        res(p.exited);
      }
    });
    child.on('exit', (code, signal) => {
      tidy();
      p.exited = { code, signal };
      redactFile(logPath, secrets);
      p.returncode = code ?? (signal === 'SIGKILL' ? 137 : 143);
      res(p.exited);
    });
  });
  child.unref?.();
  return p;
}
export const alive = (p) => p != null && p.exited === null;

const sig = (pid, n) => {
  try {
    process.kill(-pid, n);
    return true;
  } catch {
    return false;
  }
};

/** SIGTERM the worker's process group, wait `grace` ms, then SIGKILL it. Resolves once it has exited (or 10 s after KILL). */
export async function killGroup(p, grace = 30000, killWait = 10000) {
  if (!alive(p)) return;
  const wait = (ms) =>
    new Promise((r) => {
      const t = setTimeout(() => r('timeout'), ms);
      p.done.then(() => {
        clearTimeout(t);
        r('exit');
      });
    });
  sig(p.pid, 'SIGTERM');
  if ((await wait(grace)) === 'timeout') {
    sig(p.pid, 'SIGKILL');
    await wait(killWait);
  }
}

/** True when pid is alive and a session leader (pgid == pid): how a worker we launched looks; a recycled pid usually is not. */
export function pidAliveGroup(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
