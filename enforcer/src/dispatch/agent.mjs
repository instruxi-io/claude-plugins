// `--agent <profile>`: workers run on a Tier 2 agent credential (issued by agent_credential_issue)
// instead of the operator's browser sign-in. The key is read from the OS keychain or ENFORCER_AGENT_KEY, never argv.
import { spawnSync } from 'node:child_process';

export const LONG_PLAN_HOURS = 2;
export const MINUTES_PER_NODE = 30;

/** The agent's key: ENFORCER_AGENT_KEY, else the OS keychain (macOS `security`, Linux `secret-tool`). Null when absent. */
export function readAgentKey(name, env = process.env, run = spawnSync) {
  if (env.ENFORCER_AGENT_KEY) return env.ENFORCER_AGENT_KEY.trim() || null;
  const tries = process.platform === 'darwin'
    ? [['security', ['find-generic-password', '-s', 'enforcer-agent', '-a', name, '-w']]]
    : [['secret-tool', ['lookup', 'service', 'enforcer-agent', 'account', name]]];
  for (const [cmd, args] of tries) {
    try { const r = run(cmd, args, { encoding: 'utf8', timeout: 10000 }); if (r.status === 0 && String(r.stdout).trim()) return String(r.stdout).trim(); } catch { /* next */ }
  }
  return null;
}

/** Hours the plan's unfinished nodes are estimated to take with `workers` slots (30 minutes a node unless data.estimate_minutes). */
export function estimateHours(nodes = [], workers = 1) {
  const mins = nodes.filter((n) => !['done', 'skipped', 'cancelled'].includes(n.status))
    .reduce((s, n) => s + (Number(n.data?.estimate_minutes) || MINUTES_PER_NODE), 0);
  return mins / 60 / Math.max(1, workers);
}

/** Which identity workers use, and whether to proceed. {ok, line}. */
export function identityCheck({ agent = null, agentKey = null, nodes = [], workers = 1, allowBrowserSignin = false } = {}) {
  if (agent) {
    return agentKey
      ? { ok: true, line: `workers run as agent "${agent}" (agent credential; the browser sign-in is not passed); runs are attributed to the agent, you are the steward` }
      : { ok: false, line: `agent "${agent}" has no key: set ENFORCER_AGENT_KEY or store one in the OS keychain (service enforcer-agent, account ${agent})` };
  }
  const h = estimateHours(nodes, workers);
  const base = 'workers run on the browser sign-in of the person dispatching';
  if (h > LONG_PLAN_HOURS && !allowBrowserSignin) {
    return { ok: false, line: `${base}, and the plan is estimated at ${h.toFixed(1)} h (over ${LONG_PLAN_HOURS} h): use --agent <name>, or pass --allow-browser-signin` };
  }
  return { ok: true, line: `${base}${h > LONG_PLAN_HOURS ? ' (allowed by --allow-browser-signin)' : ''}` };
}
