// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// The dispatcher runtime: one pass (tick), reaping, the lease, pids.json, usage-limit and CI holds,
// SIGTERM/SIGINT drain, and `main` (the `enforcer dispatch` entry).
// Warm sessions, salvage, landing-blocked and triage launches live in the sibling modules.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, appendFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { API, APIError } from './api.mjs';
import { Lease, LEASE_KEY, LEASE_TTL } from './lease.mjs';
import { worktreeFor, worktreeSetup, BaseMissing, resolveBase, defaultBranch } from './worktree.mjs';
import {
  launchCmd,
  workerEnv,
  mintWorkerToken,
  spawnWorker,
  killGroup,
  alive,
  pidAliveGroup,
  harnessRefusal,
  HARNESSES,
  LAND_PR,
  DEFAULT_WORKER_RULES,
  WORKER_RULES_MODES,
  writeAgentMcpConfig,
  mcpConfigPath,
  removeAgentMcpConfigs,
} from './launch.mjs';
import { modelFor, nodeMaxTurns } from './model.mjs';
import { mergeTarget, repoOf, resourcesOf, lapsed, select, affinityOrder } from './select.mjs';
import { summarize, failedOutcome, workerPrompt, remediationPrompt, harnessLimitText, limitResetAt, judgeLines, denialClass } from './summarize.mjs';
import { countTurns } from './stream.mjs';
import { unsafeIdent } from './triage.mjs';
import HEADLESS_PROFILE from '../../lib/governor/profiles/headless-worker.mjs';
import { loadRepoBases } from './prune.mjs';
import { clip, parseTs } from './util.mjs';
import { writeLog, redactFile, pruneLogs, addSecret, DEFAULT_LOG_DAYS, DEFAULT_LOG_MAX_BYTES } from './logs.mjs';

/** Per-worker spend cap passed as --max-budget-usd unless the operator overrides it. */
export const DEFAULT_MAX_BUDGET_USD = HEADLESS_PROFILE.spend.defaultMaxBudgetUsd;
export const DEFAULT_TYPES = 'task,bug,chore,merge,scout,milestone,ops'; // gate stays human
export const CI_UNAVAILABLE = 7;
export const CI_STATUS_URL = 'https://www.githubstatus.com/api/v2/components.json';
export const LAND_CODES = { 0: 'merged', 2: 'CI failed', 3: 'conflict with the base', 4: 'timed out', 5: 'usage or gh error', 7: 'CI unavailable' };
export const NOT_FOUND_HINT = ' Check the workspace (enforcer workspace) and graph id: a graph in another workspace is a 404';
const GRAPH_TOOL_RE = /__graph_(next_work|heartbeat|report|remember|plan_status)$/;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
const now = () => Date.now() / 1000;

/** The GitHub Actions component status from the githubstatus.com feed, or null when unreadable (unknown is not a hold). */
export async function actionsStatus(fetchText = null, url = CI_STATUS_URL) {
  try {
    const text = fetchText ? await fetchText() : await (await fetch(url, { signal: AbortSignal.timeout(10000) })).text();
    return (JSON.parse(text).components || []).find((c) => c.name === 'Actions')?.status ?? null;
  } catch {
    return null;
  }
}

export function defaultArgs(o = {}) {
  return {
    workers: 3,
    repoRoot: join(homedir(), 'apps'),
    repoBases: null,
    dryRun: false,
    model: null,
    maxTurns: 150,
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
    maxAttempts: 2,
    types: DEFAULT_TYPES,
    interval: 30,
    exitWhenIdle: false,
    heartbeat: 120,
    landTimeout: 3000,
    stateDir: null,
    stopFile: null,
    onLimit: 'wait',
    limitBackoff: 1800,
    ciBackoff: 300,
    ciProbeInterval: 300,
    ciStatusUrl: CI_STATUS_URL,
    pluginDir: [],
    takeover: false,
    noLease: false,
    workerRules: DEFAULT_WORKER_RULES,
    harness: 'claude',
    experimental: false,
    agentBin: null,
    grok: null,
    codex: null,
    leaseRenew: LEASE_TTL / 3,
    killGrace: 30,
    ...o,
  };
}

export class Dispatcher {
  constructor(api, args, out = (s) => process.stdout.write(s)) {
    this.api = api;
    this.args = args;
    this.out = out;
    this.g = args.graph;
    this.state = args.stateDir;
    this.logs = join(this.state, 'logs');
    this.types = args.types === 'all' ? null : new Set(String(args.types).split(','));
    this.lease = new Lease(api, this.g, { say: (m) => this.say(m), takeover: args.takeover, noLease: args.noLease, dryRun: args.dryRun });
    this.workers = new Map();
    this.attempts = new Map();
    this.failures = new Map();
    this.denied = new Map();
    this.lastSkip = new Map();
    this.peak = 0;
    this.blocked = false;
    this.mcpDown = 0;
    this.drainSaid = false;
    this.limitedUntil = 0;
    this.limitNoted = 0;
    this.ciHold = 0;
    this.ciChecked = now();
    this.ciFetch = null; // ciFetch: test hook returning the feed's JSON text
    this.leaseAt = 0;
    this.verdictNoted = 0;
    this.terminating = null; // the signal name once SIGTERM/SIGINT arrived: an explicit state flag, not an exception
    this.wake = null;
  }

  say(msg, fields = {}) {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}\n`;
    this.out(line);
    if (!this.args.dryRun) writeLog(this.state, line, msg, { key: fields.key ?? msg.match(/^\S+ (\S+?)[:\s]/)?.[1] ?? null, run: fields.run ?? null, fields });
  }

  stopping() {
    return existsSync(this.args.stopFile);
  }

  async sleep(ms) {
    if (this.terminating) return;
    await new Promise((res) => {
      const t = setTimeout(res, ms);
      this.wake = () => {
        clearTimeout(t);
        res();
      };
    });
    this.wake = null;
  }

  requestTerminate(signame) {
    if (this.terminating) return;
    this.terminating = signame;
    this.wake?.();
  }

  // ---- reading the plan
  async candidates(nodes) {
    const front = await this.api.frontier(this.g);
    const ours = new Set(this.workers.keys());
    const out = [];
    const seen = new Set();
    for (let n of front) {
      if (n.work_state != null && n.work_state !== 'looking_for_work') continue;
      if (lapsed(n)) n = { ...n, _lapsed: true };
      out.push(n);
      seen.add(n.id);
    }
    for (let n of nodes) {
      if (!seen.has(n.id) && !ours.has(n.key) && lapsed(n)) out.push({ ...n, _lapsed: true });
    }
    return out.filter((n) => {
      if (this.types && !this.types.has(n.type)) return false;
      if (n.key === LEASE_KEY || n.data?.dispatcher_lease) return false;
      if (n.data?.triage_of) return false; // launched by the dispatcher that made it, never from the frontier
      if (this.denied.has(n.key)) return false;
      return (this.attempts.get(n.key) || 0) < this.args.maxAttempts;
    });
  }

  heldElsewhere(nodes) {
    const held = new Set();
    for (const n of nodes) {
      if (n.status === 'running' && !this.workers.has(n.key) && !lapsed(n)) for (const r of resourcesOf(n)) held.add(r);
    }
    for (const w of this.workers.values()) for (const r of w.resources) held.add(r);
    return held;
  }

  async tick() {
    const nodes = await this.api.nodes(this.g);
    const cands = await this.candidates(nodes);
    const slots = this.args.workers - [...this.workers.values()].filter((w) => w.kind === 'agent').length;
    const held = this.heldElsewhere(nodes);
    const agents = affinityOrder(
      cands.filter((n) => !mergeTarget(n)),
      {},
      (n) => modelFor(n, this.args.model),
    );
    const merges = cands.filter((n) => mergeTarget(n));
    const a = select(agents, held, Math.max(slots, 0), this.workers);
    for (const n of a.chosen) for (const r of resourcesOf(n)) held.add(r);
    const m = select(merges, held, merges.length, this.workers);
    const chosen = [...a.chosen, ...m.chosen];
    for (const [n, why] of [...a.skipped, ...m.skipped]) {
      if ((why !== 'no free worker slot' || this.args.dryRun) && this.lastSkip.get(n.key) !== why) this.say(`skip ${n.key}: ${why}`);
      this.lastSkip.set(n.key, why);
    }
    if (this.stopping() && !this.drainSaid) {
      this.drainSaid = true;
      this.say(`stop file present: draining; ${this.workers.size} worker(s) running (${[...this.workers.keys()].join(', ') || '-'}), no new launches`);
    }
    if (this.stopping() || this.blocked) {
      if (chosen.length) this.say(`${this.blocked ? 'blocked' : 'stop file present'}: not launching ${chosen.map((n) => n.key).join(', ')}`);
      return { nodes, launched: [] };
    }
    const launched = [];
    for (const n of chosen) {
      try {
        await this.launch(n);
        launched.push(n);
      } catch (e) {
        if (e instanceof APIError) throw e;
        this.say(`launch ${n.key} failed (${e.name}: ${e.message}); continuing`);
      }
    }
    return { nodes, launched };
  }

  // ---- base resolution
  async graphBases() {
    if (this._gbases === undefined) {
      try {
        const b = ((await this.api.graph?.(this.g)) || {}).node_defaults?.bases;
        this._gbases = b && typeof b === 'object' ? Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)])) : {};
      } catch (e) {
        if (now() - (this._gbasesNoted || 0) > 60) {
          this.say(`could not read graph node_defaults.bases (${e.message}); using none this pass, will retry`);
          this._gbasesNoted = now();
        }
        return {};
      }
    }
    return this._gbases;
  }
  registry() {
    return (this._registry ??= loadRepoBases(this.args.repoBases));
  }

  // ---- launching
  async launch(n) {
    const a = this.args;
    const bad = unsafeIdent(n);
    if (bad) {
      this.say(`REFUSE ${n.key}: ${bad}; fix the node (letters, digits, . _ - only)`);
      return;
    }
    const tag = n._lapsed ? ' (lease lapsed; re-claim)' : '';
    const mt = mergeTarget(n);
    if (mt) return this.launchMerge(n, mt, tag);
    const model = modelFor(n, a.model);
    let path;
    let branch;
    let note;
    try {
      [path, branch, note] = worktreeFor(n, a.repoRoot, this.state, { dry: a.dryRun, graphBases: await this.graphBases(), registry: this.registry() });
    } catch (e) {
      if (e instanceof BaseMissing) {
        this.say(`refuse ${n.key}: ${e.message}; fix the repo's remote, or set data.base / the registry`);
        return;
      }
      throw e;
    }
    const repo = repoOf(n);
    if (branch && repo && existsSync(join(a.repoRoot, repo))) {
      try {
        const r = worktreeSetup(join(a.repoRoot, repo), path, { dry: a.dryRun });
        this.say(`worktree-setup ${n.key}: copied ${r.copied}, linked ${r.linked}${r.notes.map((x) => '; ' + x).join('')}`);
      } catch (e) {
        this.say(`worktree-setup ${n.key}: failed: ${e.message}`);
      }
    }
    const failures = this.failures.get(n.key) || [];
    const turnsCap = nodeMaxTurns(n);
    let prompt;
    let t2 = tag;
    if (failures.length) {
      prompt = remediationPrompt(this.g, n, path, branch, failures);
      t2 += ` (remediation after ${failures.length} failed attempt(s))`;
    } else prompt = workerPrompt(this.g, n, path, branch);
    const session = randomUUID();
    // An agent run talks to the API through its own MCP connection (see writeAgentMcpConfig), never the stored sign-in.
    const ownMcp = a.agent && a.agentKey && a.mcpUrl && (a.harness || 'claude') === 'claude';
    const mcpConfig = ownMcp ? mcpConfigPath(this.state, n.key) : null;
    const cmd = launchCmd(prompt, model, a, n.key, { session, maxTurns: turnsCap, mcpConfig });
    const res = [...resourcesOf(n)].sort().join(',') || '-';
    if (a.dryRun) {
      this.say(
        `would launch ${n.key} [${n.type}, tier ${n.data?.tier ?? '-'}] model=${model} worktree=${path} branch=${branch || '-'} (${note}) resources=${res}${turnsCap ? ` max_turns=${turnsCap}` : ''}${t2}`,
      );
      return;
    }
    const attempt = (this.attempts.get(n.key) || 0) + 1;
    this.attempts.set(n.key, attempt);
    const logPath = join(this.logs, `${n.key}.${attempt}.jsonl`);
    let token = null;
    if (this.args.agentKey) token = this.args.agentKey;
    else
      try {
        token = typeof this.api.call === 'function' ? await mintWorkerToken(this.api, process.env, `worker-${n.key}`.slice(0, 60)) : null;
      } catch (e) {
        this.say(`worker token not minted for ${n.key}: ${e.message}`);
      }
    if (mcpConfig) {
      try {
        writeAgentMcpConfig(this.state, n.key, a.mcpUrl, a.agentKey);
      } catch (e) {
        this.say(`refuse ${n.key}: could not write its MCP config: ${e.message}`);
        return;
      }
    }
    const proc = spawnWorker(cmd, {
      cwd: path,
      logPath,
      env: workerEnv(this.g, process.env, { token, release: n.type === 'release', workerRules: this.args.workerRules }),
      cleanup: mcpConfig ? [mcpConfig] : [],
      secrets: a.agentKey ? [a.agentKey] : [],
    });
    const w = {
      kind: 'agent',
      node: n,
      key: n.key,
      logPath,
      proc,
      started: now(),
      resources: resourcesOf(n),
      path,
      model,
      turns: 0,
      maxTurns: Math.max(a.maxTurns, turnsCap || 0),
      session,
    };
    this.workers.set(n.key, w);
    this.peak = Math.max(this.peak, this.workers.size);
    this.say(`launch ${n.key} pid=${proc.pid} model=${model} mode=cold session=${session} cwd=${path} (${note}) log=${logPath}${t2}`);
  }

  async launchMerge(n, [pr, slug], tag) {
    const a = this.args;
    const repoDir = a.repoRoot && n.data?.repo ? join(a.repoRoot, n.data.repo) : null;
    const cwd = repoDir && existsSync(repoDir) ? repoDir : process.cwd();
    const cmd = [LAND_PR, pr, ...(slug ? ['-R', slug] : []), '--timeout', String(a.landTimeout)];
    if (a.dryRun) {
      this.say(`would land ${n.key} [merge, no agent]${tag}: ${cmd.join(' ')} (cwd ${cwd})`);
      return;
    }
    this.attempts.set(n.key, (this.attempts.get(n.key) || 0) + 1);
    let card;
    try {
      card = await this.api.claim(this.g, n.id, 'graph-dispatch');
    } catch (e) {
      this.say(`claim ${n.key} refused: ${e.message}`);
      return;
    }
    const logPath = join(this.logs, `${n.key}.${this.attempts.get(n.key)}.log`);
    const proc = spawnWorker(cmd, { cwd, logPath, env: { ...process.env, GRAPH_RUN_ID: card.run_id } });
    this.workers.set(n.key, {
      kind: 'merge',
      node: n,
      key: n.key,
      logPath,
      proc,
      started: now(),
      resources: resourcesOf(n),
      runId: card.run_id,
      cmd,
      lastHb: now(),
    });
    this.peak = Math.max(this.peak, this.workers.size);
    this.say(`land ${n.key} pid=${proc.pid} run=${card.run_id}: ${cmd.join(' ')} log=${logPath}`);
  }

  // ---- holds
  ciUnavailable(key, why) {
    const until = now() + (this.args.ciBackoff ?? 300);
    if (this.limitedUntil < until) this.limitedUntil = this.ciHold = until;
    this.say(`CI-UNAVAILABLE ${key}: ${why}; holding launches and landings until ${stamp(until)}`);
  }

  async ciProbe(force = false) {
    const t = now();
    if (!force && t - this.ciChecked < this.args.ciProbeInterval) return;
    this.ciChecked = t;
    const st = await actionsStatus(this.ciFetch, this.args.ciStatusUrl);
    if (st === null) return;
    if (st !== 'operational') this.ciUnavailable('github-actions', `status feed says Actions is ${st}`);
    else if (this.ciHold && this.limitedUntil === this.ciHold) {
      this.limitedUntil = this.ciHold = 0;
      this.say('CI-UNAVAILABLE cleared: GitHub Actions is operational');
    }
  }

  // ---- supervision
  async heartbeatWorker(w) {
    try {
      const st = (await this.api.heartbeat(this.g, w.node.id, w.runId)).state;
      w.lastHb = now();
      if (st && st !== 'ok') this.say(`heartbeat ${w.key}: ${st}`);
    } catch (e) {
      this.say(`heartbeat ${w.key} failed: ${e.message}`);
    }
  }

  async finishMerge(w) {
    const rc = w.proc.returncode;
    if (rc === CI_UNAVAILABLE) {
      this.ciUnavailable(w.key, 'land-pr.sh found CI unavailable');
      return;
    }
    let out = '';
    try {
      out = readFileSync(w.logPath, 'utf8');
    } catch {
      /* none */
    }
    const ok = rc === 0;
    const body = {
      status: ok ? 'succeeded' : 'failed',
      evidence: [{ kind: 'command', cmd: w.cmd.join(' '), exit: rc, output: clip(out) }],
      data: {
        report: `1. ${ok ? 'MET' : 'NOT MET'}: land-pr.sh exited ${rc} (${LAND_CODES[rc] || 'unknown'}). Run by graph-dispatch with no agent.`,
        runner: 'graph-dispatch',
      },
    };
    if (!ok) body.error = `land-pr.sh exit ${rc} (${LAND_CODES[rc] || 'unknown'}): ${out.trim().slice(-500)}`;
    try {
      await this.api.complete(this.g, w.node.id, w.runId, body);
      this.say(`land ${w.key} exit=${rc} -> run ${w.runId} ${body.status}`);
    } catch (e) {
      this.say(`complete ${w.key} failed: ${e.message}`);
    }
  }

  async failOrphan(w, s) {
    const body = {
      status: 'failed',
      data: { runner: 'graph-dispatch' },
      error: `graph-dispatch: worker exited (code ${w.proc.returncode}, ${s.turns} turns) without reporting; log ${w.logPath}`,
    };
    try {
      await this.api.complete(this.g, w.node.id, s.run_id, body);
      this.say(`failed orphan run ${s.run_id} of ${w.key}`);
    } catch (e) {
      this.say(`could not fail orphan run of ${w.key}: ${e.message}`);
    }
  }

  /**
   * A worker's transcript only holds the verdict the report call returned, which can be an earlier or a still-pending
   * one. Re-read the node's CURRENT status and the LATEST run's verdict (polling while it is pending, bounded) and
   * return the outcome to count: null when the node is done or the latest verdict is verified.
   */
  async settleOutcome(w, s, outcome) {
    if (!outcome || !s.reported || s.report_status !== 'succeeded' || !s.rejection) return outcome;
    const tries = this.args.verdictPolls ?? 10;
    for (let i = 0; i <= tries; i++) {
      try {
        const n = typeof this.api.node === 'function' ? await this.api.node(this.g, w.node.id) : null;
        if (n?.status === 'done') return null;
        const runs = typeof this.api.runs === 'function' ? await this.api.runs(this.g, w.node.id) : [];
        const mine = runs.find((r) => (r.run_id ?? r.id) === s.run_id) || runs[runs.length - 1];
        const v = mine?.verification ?? mine?.data?.verification ?? mine?.verdict;
        const state = typeof v === 'string' ? v : v?.state;
        if (state === 'verified') return null;
        if (state && state !== 'pending') return outcome;
        if (!mine) return outcome;
      } catch {
        return outcome;
      }
      if (i < tries) await sleepMs(this.args.verdictPollMs ?? 1000);
    }
    return outcome;
  }

  async reap() {
    const harness = this.args.harness || 'claude';
    for (const [key, w] of [...this.workers]) {
      if (w.kind === 'merge') {
        if (alive(w.proc) && now() - w.lastHb > this.args.heartbeat) await this.heartbeatWorker(w);
        if (!alive(w.proc)) {
          await this.finishMerge(w);
          this.workers.delete(key);
        }
        continue;
      }
      w.turns = countTurns(w.logPath, harness);
      if (alive(w.proc) && w.turns > w.maxTurns) {
        this.say(`turn cap: ${key} at ${w.turns} turns > ${w.maxTurns}, stopping it`);
        await killGroup(w.proc, this.args.killGrace * 1000);
      }
      if (alive(w.proc)) continue;
      const s = summarize(w.logPath, harness);
      const limitText = harnessLimitText(s);
      if (limitText) {
        // the harness, not the node: refund the attempt, leave the run to lapse, hold every launch until the reset
        this.workers.delete(key);
        this.attempts.set(key, Math.max(0, (this.attempts.get(key) || 0) - 1));
        const until = limitResetAt(limitText) || now() + this.args.limitBackoff;
        this.limitedUntil = Math.max(this.limitedUntil, until);
        this.say(
          `HARNESS-LIMITED ${key}: ${clip(limitText, 160)}; no attempt spent; ${this.args.onLimit === 'wait' ? 'waiting' : 'exiting'} until ${stamp(until)}`,
        );
        continue;
      }
      const u = s.usage || {};
      this.say(
        `done ${key} exit=${w.proc.returncode} turns=${s.turns} result=${s.result} denials=${s.denials} run=${s.run_id || '-'} reported=${s.reported} cost=${s.cost} session=${w.session} cold cache_read=${u.cache_read_input_tokens ?? '-'} cache_creation=${u.cache_creation_input_tokens ?? '-'} output=${u.output_tokens ?? '-'}`,
      );
      for (const ln of judgeLines(key, s.verification)) this.say(ln);
      let outcome = await this.settleOutcome(w, s, failedOutcome(s, w.proc.returncode));
      if (s.run_id && !s.reported) await this.failOrphan(w, s);
      const down = Object.entries(s.mcp).filter(([k, v]) => k.startsWith('plugin:enforcer') && v !== 'connected');
      if (down.length && !s.run_id) {
        // never reached the graph (a needs-auth flake): not the node's fault; three in a row is an outage
        this.attempts.set(key, this.attempts.get(key) - 1);
        this.mcpDown++;
        this.say(`mcp ${down.map(([k, v]) => `${k}=${v}`).join(',')} for ${key}; retrying later (${this.mcpDown} in a row)`);
        if (this.mcpDown >= 3 && !this.blocked) {
          this.blocked = true;
          this.say(
            'BLOCKED: the enforcer MCP server was not connected for 3 workers in a row; run /enforcer:login, then restart. Launching no more workers (drain).',
          );
        }
        outcome = null;
      } else if (Object.keys(s.mcp).length) this.mcpDown = 0;
      const graphDenied = s.denied_tools.filter((t) => GRAPH_TOOL_RE.test(t) && !(s.decisions || []).some((d) => d.tool === t));
      if (graphDenied.length && !this.blocked) {
        this.blocked = true;
        this.say(`BLOCKED: ${graphDenied.join(', ')} denied in a headless worker; launching no more workers (drain).`);
      }
      const [kind, rec] = denialClass(s);
      if (outcome && !graphDenied.length && (kind === 'salvage' || kind === 'denied') && !this.denied.has(key)) {
        this.denied.set(key, w.path || '-');
        this.say(`DENIED ${key}: ${rec?.code || '-'}; not relaunching it this session. Worktree: ${w.path} (a person can land it)`);
        outcome = null;
      }
      if (outcome && !graphDenied.length) {
        const list = this.failures.get(key) || [];
        list.push(outcome);
        this.failures.set(key, list);
        this.say(
          `FAILED ${key} (attempt ${list.length} of ${this.args.maxAttempts} this session): ${clip(outcome.error, 200)}; next: ${(this.attempts.get(key) || 0) < this.args.maxAttempts ? 'remediation launch' : 'left for a person'}`,
        );
      }
      this.workers.delete(key);
    }
  }

  // ---- pids and orphans
  writePids() {
    try {
      const workers = Object.fromEntries([...this.workers].filter(([, w]) => w.proc).map(([k, w]) => [k, w.proc.pid]));
      const p = join(this.state, 'pids.json');
      writeFileSync(p + '.tmp', JSON.stringify({ dispatcher: process.pid, host: hostname(), workers }));
      renameSync(p + '.tmp', p);
    } catch {
      /* state dir gone */
    }
  }

  /** Startup: kill workers a dead earlier dispatcher left in pids.json (they run in their own session). */
  async reapOrphans() {
    const path = join(this.state, 'pids.json');
    let rec;
    try {
      rec = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return [];
    }
    if (rec.host != null && rec.host !== hostname()) return [];
    if (rec.dispatcher && rec.dispatcher !== process.pid && pidAliveGroup(rec.dispatcher)) return [];
    const reaped = [];
    for (const [key, pid] of Object.entries(rec.workers || {})) {
      if (!Number.isInteger(pid) || pid === process.pid || !pidAliveGroup(pid)) continue;
      for (const sg of ['SIGTERM', 'SIGKILL']) {
        try {
          process.kill(-pid, sg);
        } catch {
          break;
        }
        for (let i = 0; i < 20 && pidAliveGroup(pid); i++) await sleepMs(100);
        if (!pidAliveGroup(pid)) break;
      }
      this.say(`reaped orphan worker ${key} pid ${pid} from a previous dispatcher`);
      reaped.push(key);
    }
    rmSync(path, { force: true });
    return reaped;
  }

  /** Stop every worker (SIGTERM to its group, then SIGKILL), fail the runs they held open, record pids.json, clear the lease. */
  async shutdown(why = 'SIGTERM') {
    this.say(`${why}: stopping ${this.workers.size} worker(s)`);
    const harness = this.args.harness || 'claude';
    for (const [key, w] of [...this.workers]) {
      try {
        if (alive(w.proc)) await killGroup(w.proc, Math.min(this.args.killGrace, 10) * 1000);
        let runId = null;
        if (w.kind === 'merge') runId = w.runId;
        else {
          const s = summarize(w.logPath, harness);
          runId = s.reported ? null : s.run_id;
        }
        if (runId) {
          await this.api.complete(this.g, w.node.id, runId, {
            status: 'failed',
            data: { runner: 'graph-dispatch' },
            error: `graph-dispatch: orphaned: the dispatcher received ${why} and stopped the worker`,
          });
          this.say(`failed orphan run ${runId} of ${key}`);
        }
      } catch (e) {
        this.say(`shutdown of ${key}: ${e.name}: ${e.message}`);
      }
    }
    this.workers.clear();
    if (this.state) removeAgentMcpConfigs(this.state);
    this.writePids();
    await this.lease.release();
  }

  // ---- run
  async run() {
    const a = this.args;
    const handlers = {};
    if (!a.dryRun) {
      for (const sg of ['SIGTERM', 'SIGINT']) {
        handlers[sg] = () => this.requestTerminate(sg);
        process.on(sg, handlers[sg]);
      }
    }
    try {
      if (!a.dryRun) {
        mkdirSync(this.state, { recursive: true });
        await this.reapOrphans();
        if (existsSync(a.stopFile)) {
          rmSync(a.stopFile, { force: true });
          this.say(`removed a stale stop file at startup: ${a.stopFile}`);
        }
      }
      const rc = await this._run();
      if (this.terminating) {
        await this.shutdown(this.terminating);
        return this.terminating === 'SIGTERM' ? 143 : 130;
      }
      if ((rc === 1 || rc === 3) && this.workers.size) await this.shutdown(`exit ${rc}`);
      if (!a.dryRun && !this.workers.size) rmSync(join(this.state, 'pids.json'), { force: true });
      return rc;
    } finally {
      for (const [sg, h] of Object.entries(handlers)) process.off(sg, h);
    }
  }

  async _run() {
    const a = this.args;
    if (!a.dryRun && !a.noLease) {
      try {
        if (!(await this.lease.acquire())) return 3;
      } catch (e) {
        if (!(e instanceof APIError)) throw e;
        this.say(`could not take the dispatcher lease: ${e.message}${e.status === 404 ? NOT_FOUND_HINT : ''}`);
        return 1;
      }
      try {
        return await this.loop();
      } finally {
        if (this.terminating) {
          /* shutdown() releases after stopping workers */
        } else await this.lease.release();
      }
    }
    return this.loop();
  }

  verifyingGate(nodes) {
    const ver = nodes.filter((n) => n.status === 'verifying' && n.key !== LEASE_KEY).map((n) => n.key);
    if (!ver.length) return [];
    const rest = nodes.filter(
      (n) => !['done', 'failed', 'cancelled', 'verifying', 'running'].includes(n.status) && n.key !== LEASE_KEY && !n.data?.dispatcher_lease,
    );
    return rest.length ? ver : [];
  }

  async renewIfDue() {
    if (now() - this.leaseAt <= this.args.leaseRenew) return true;
    if (!(await this.lease.renew())) return false;
    this.leaseAt = now();
    return true;
  }

  async loop() {
    const a = this.args;
    if (a.dryRun) {
      this.say(`dry run on graph ${this.g}, ${a.workers} worker slot(s); nothing is launched`);
      await this.tick();
      return 0;
    }
    mkdirSync(this.logs, { recursive: true, mode: 0o700 });
    if (!this.args.dryRun) {
      const gone = pruneLogs(this.logs, { days: this.args.logDays ?? DEFAULT_LOG_DAYS, maxBytes: this.args.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES });
      if (gone.length) this.say(`pruned ${gone.length} old worker log(s)`, { removed: gone.length });
    }
    this.say(`dispatching graph ${this.g} with ${a.workers} workers; stop file ${a.stopFile}`);
    let idle = 0;
    while (!this.terminating) {
      await this.ciProbe();
      if (this.limitedUntil > now()) {
        // a hold: no launches, but keep reaping, the lease and pids fresh
        await this.reap();
        if (a.onLimit === 'exit' && !this.workers.size) {
          this.say(`harness usage limit: exiting 4; resume after ${stamp(this.limitedUntil)}`);
          return 4;
        }
        if (now() - this.limitNoted > 600) {
          this.say(`harness usage limit: holding every launch until ${stamp(this.limitedUntil)} (${this.workers.size} running)`);
          this.limitNoted = now();
        }
        if (this.stopping() && !this.workers.size) {
          this.say(`drained while limited; exiting (peak ${this.peak})`);
          return 0;
        }
        try {
          if (!(await this.renewIfDue())) return 3;
        } catch (e) {
          if (!(e instanceof APIError)) throw e;
          this.say(`API error renewing the lease during a hold: ${e.message}`);
          if ([401, 403, 404, 'auth'].includes(e.status)) return 1;
        }
        this.writePids();
        await this.sleep(Math.min(Math.max(a.interval, 1) * 1000, (Math.max(this.limitedUntil - now(), 0) + 0.01) * 1000, 300000));
        continue;
      }
      let nodes;
      let launched;
      try {
        await this.reap();
        if (this.limitedUntil > now()) continue; // a worker just reported a usage limit: hold, do not tick
        if (!(await this.renewIfDue())) return 3;
        this.writePids();
        ({ nodes, launched } = await this.tick());
      } catch (e) {
        if (e instanceof APIError) {
          this.say(`API error (pass skipped, retrying): ${e.message}`);
          if ([401, 403, 'auth'].includes(e.status)) return 1;
          if (e.status === 404) {
            this.say(`HTTP 404: graph ${this.g} not found.${NOT_FOUND_HINT}; exiting 1`);
            return 1;
          }
        } else this.say(`pass failed (${e.name}: ${e.message}); retrying`); // a bug in one pass must not orphan the workers
        await this.sleep(a.interval * 1000);
        continue;
      }
      if ((this.stopping() || this.blocked) && !this.workers.size) {
        if (this.blocked && !this.stopping()) {
          this.say(`drained after BLOCKED; exiting 2 (peak ${this.peak})`);
          return 2;
        }
        this.say(`drained: stop file present and no worker running; exiting (peak ${this.peak})`);
        return 0;
      }
      const busy = nodes.some((n) => n.status === 'running' && !lapsed(n));
      const waiting = a.exitWhenIdle ? [] : this.verifyingGate(nodes);
      if (waiting.length && !this.workers.size && !launched.length && !busy) {
        idle = 0;
        if (now() - this.verdictNoted > 600) {
          this.say(`waiting on verdict for ${waiting.join(', ')}`);
          this.verdictNoted = now();
        }
      } else if (!this.workers.size && !launched.length && !busy) {
        if (++idle >= 2) {
          const left = nodes
            .filter((n) => n.status === 'failed' && n.key !== LEASE_KEY)
            .map((n) => n.key)
            .sort();
          for (const k of this.denied.keys()) if (!left.includes(k)) left.push(k);
          if (left.length) {
            this.say(`nothing runnable or running; exiting 6: failed or denied nodes remain: ${left.join(', ')} (peak ${this.peak})`);
            return 6;
          }
          this.say(`nothing runnable or running; exiting (peak ${this.peak} concurrent)`);
          return 0;
        }
      } else idle = 0;
      await this.sleep(a.interval * 1000);
    }
    return 0;
  }
}

// ---- command line
const OPTS = {
  graph: { type: 'string' },
  workers: { type: 'string' },
  'repo-root': { type: 'string' },
  'repo-bases': { type: 'string' },
  'dry-run': { type: 'boolean' },
  model: { type: 'string' },
  'max-turns': { type: 'string' },
  'max-budget-usd': { type: 'string' },
  'max-attempts': { type: 'string' },
  types: { type: 'string' },
  interval: { type: 'string' },
  'exit-when-idle': { type: 'boolean' },
  heartbeat: { type: 'string' },
  'land-timeout': { type: 'string' },
  'state-dir': { type: 'string' },
  'stop-file': { type: 'string' },
  'on-limit': { type: 'string' },
  'limit-backoff': { type: 'string' },
  'ci-backoff': { type: 'string' },
  'ci-probe-interval': { type: 'string' },
  'ci-status-url': { type: 'string' },
  'plugin-dir': { type: 'string', multiple: true },
  takeover: { type: 'boolean' },
  'no-lease': { type: 'boolean' },
  'worker-rules': { type: 'string' },
  agent: { type: 'string' },
  'allow-browser-signin': { type: 'boolean' },
  harness: { type: 'string' },
  experimental: { type: 'boolean' },
  grok: { type: 'string' },
  codex: { type: 'string' },
  claude: { type: 'string' },
  // accepted for compatibility with the Python dispatcher's front door; the features they tune are not in the Node runtime yet
  'no-salvage': { type: 'boolean' },
  'no-triage': { type: 'boolean' },
  'no-warm': { type: 'boolean' },
  'triage-grace': { type: 'string' },
  'triage-model': { type: 'string' },
  'check-acceptance': { type: 'boolean' },
  'warm-max-nodes': { type: 'string' },
  'warm-max-age': { type: 'string' },
};

/** argv -> args object (throws Error with a usage message on bad input). */
export function parseDispatchArgs(argv, env = process.env) {
  const { values: v, positionals } = parseArgs({ args: argv, options: OPTS, allowPositionals: true });
  const num = (x, d) => (x === undefined ? d : Number(x));
  const graph = v.graph || positionals[0];
  if (!graph) throw new Error('a graph id is required');
  const harness = v.harness || 'claude';
  if (!HARNESSES.includes(harness)) throw new Error(`--harness must be one of ${HARNESSES.join(', ')}`);
  const why = harnessRefusal(harness, v.experimental);
  if (why) throw new Error(why);
  const workerRules = v['worker-rules'] ?? DEFAULT_WORKER_RULES;
  if (!WORKER_RULES_MODES.includes(workerRules)) throw new Error('--worker-rules must be on or off');
  const workers = num(v.workers, 3);
  if (!(workers >= 1)) throw new Error('--workers must be >= 1');
  const cfg = env.ENFORCER_CONFIG_HOME || join(homedir(), '.config', 'enforcer');
  const stateDir = v['state-dir'] || join(cfg, 'dispatch', graph);
  const d = defaultArgs();
  return {
    ...d,
    graph,
    workers,
    repoRoot: v['repo-root'] || d.repoRoot,
    repoBases: v['repo-bases'] || null,
    dryRun: !!v['dry-run'],
    model: v.model || null,
    maxTurns: num(v['max-turns'], d.maxTurns),
    maxBudgetUsd: v['max-budget-usd'] ? Number(v['max-budget-usd']) : d.maxBudgetUsd,
    maxAttempts: num(v['max-attempts'], d.maxAttempts),
    types: v.types || d.types,
    interval: num(v.interval, d.interval),
    exitWhenIdle: !!v['exit-when-idle'],
    heartbeat: num(v.heartbeat, d.heartbeat),
    landTimeout: num(v['land-timeout'], d.landTimeout),
    stateDir,
    stopFile: v['stop-file'] || join(stateDir, 'STOP'),
    onLimit: v['on-limit'] === 'exit' ? 'exit' : 'wait',
    limitBackoff: num(v['limit-backoff'], d.limitBackoff),
    ciBackoff: num(v['ci-backoff'], d.ciBackoff),
    ciProbeInterval: num(v['ci-probe-interval'], d.ciProbeInterval),
    ciStatusUrl: v['ci-status-url'] || d.ciStatusUrl,
    pluginDir: v['plugin-dir'] || [],
    workerRules,
    takeover: !!v.takeover,
    noLease: !!v['no-lease'],
    harness,
    experimental: !!v.experimental,
    agent: v.agent || null,
    allowBrowserSignin: !!v['allow-browser-signin'],
    grok: v.grok || null,
    codex: v.codex || null,
    agentBin: v['claude'] || null,
  };
}

/** `enforcer dispatch run <flags>`: the foreground dispatcher. Returns the exit code. */
export async function main(argv, env = process.env) {
  let args;
  try {
    args = parseDispatchArgs(argv, env);
  } catch (e) {
    process.stderr.write(`graph-dispatch: ${e.message}\n`);
    return 2;
  }
  const { resolveConfig } = await import('../config.mjs');
  if (args.agent) {
    const { readAgentKey } = await import('./agent.mjs');
    args.agentKey = readAgentKey(args.agent, env);
    if (!args.agentKey) {
      process.stderr.write(`graph-dispatch: agent "${args.agent}" has no key: set ENFORCER_AGENT_KEY or store one in the OS keychain\n`);
      return 2;
    }
    env = { ...env, GRAPH_API_KEY: args.agentKey };
    addSecret(args.agentKey);
    args.mcpUrl = resolveConfig({ env }).mcpUrl;
  }
  const { headers } = await import('../preflight.mjs');
  const api = new API(resolveConfig({ env }).graphUrl, { headers: () => headers(env) });
  if (!args.dryRun) mkdirSync(args.stateDir, { recursive: true });
  try {
    return await new Dispatcher(api, args).run();
  } catch (e) {
    process.stderr.write(`graph-dispatch: ${e.message}\n`);
    return e instanceof APIError ? 1 : 2;
  }
}
