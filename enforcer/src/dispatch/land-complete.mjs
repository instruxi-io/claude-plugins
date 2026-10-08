// Landing-blocked: the worker's PR is open and green but it could not land it. The dispatcher lands it, then
// completes the run with the node's own acceptance commands run on the merged commit as evidence.
import { spawnSync } from 'node:child_process';
import { clip } from './util.mjs';
import { runEvidence } from '../evidence-run.mjs';

export const LAND_CODES = { 0: 'merged', 2: 'CI failed', 3: 'conflict with the base', 4: 'timed out', 5: 'usage or gh error', 7: 'CI unavailable' };
export const ACCEPT_RUNNERS = ['node', 'bash', 'grep', 'ls'];

/** The node's `<command> prints ...` acceptance lines, read-only runners only; PR (gh/git) lines are skipped. */
export function acceptanceCommands(node) {
  const out = [];
  for (const line of (node.data || {}).acceptance || []) {
    if (typeof line !== 'string' || !line.includes(' prints ')) continue;
    const cmd = line
      .split(' prints ')[0]
      .trim()
      .replace(/^`+|`+$/g, '')
      .trim();
    if (/\bgh\b|\bgit\b/.test(cmd)) continue;
    const rest = cmd.replace(/^cd\s+\S+\s*&&\s*/, '');
    if (!ACCEPT_RUNNERS.includes(rest.split(' ')[0])) continue;
    out.push(cmd);
  }
  return out;
}

/** Run each acceptance command in cwd with the harness env cleared; one {kind:'command'} record each.
 *  The rules (Go test flags, cd prefix, one retry on a collision, head+tail output) are `enforcer evidence run`'s. */
export function landingEvidence(node, cwd, { run = spawnSync, env = process.env } = {}) {
  return runEvidence(node, { cwd, env, run, runners: ACCEPT_RUNNERS, graph: node.graph_id ?? '' }).items;
}

/** The completion body for a landed (or not) PR; `evidence` is the acceptance output, attached on success. */
export function completionBody({ pr, url, rc, out = '', mergeCommit = '', workerReport = '-', view = '{}', cmd = [], evidence = [] }) {
  const ok = rc === 0;
  const why = LAND_CODES[rc] || 'unknown';
  const body = {
    status: ok ? 'succeeded' : 'failed',
    evidence: [
      { kind: 'note', text: clip('worker report: ' + workerReport, 3000) },
      { kind: 'command', cmd: `gh pr view ${pr} --json number,state,url,statusCheckRollup`, exit: 0, output: clip(view, 3000) },
      { kind: 'command', cmd: cmd.join(' '), exit: rc, output: clip(out) },
      ...(ok ? evidence : []),
    ],
    data: {
      report:
        `1. ${ok ? 'MET' : 'NOT MET'}: PR #${pr} was open with checks passing or pending (landing_blocked: the worker could not run the lander); ` +
        `the lander exited ${rc} (${why}). Landed by graph-dispatch after the worker could not run the lander${mergeCommit ? '; merge commit ' + mergeCommit : ''}. Run by graph-dispatch with no agent.`,
      runner: 'graph-dispatch',
      outcome: 'landing_blocked',
    },
  };
  if (url) body.pr = url;
  if (!ok) body.error = `landing_blocked: lander exit ${rc} (${why}): ${String(out).trim().slice(-500)}`;
  return body;
}

/**
 * Land and complete. deps: land() -> {rc, out}, mergeCommit() -> sha, evidence(sha) -> records, complete(body).
 * Returns the body posted.
 */
export async function landAndComplete({ pr, url, view, cmd, workerReport, land, mergeCommit, evidence, complete }) {
  const { rc, out } = await land();
  let mc = '',
    ev = [];
  if (rc === 0) {
    mc = (await mergeCommit()) || '';
    ev = await evidence(mc);
  }
  const body = completionBody({ pr, url, rc, out, mergeCommit: mc, workerReport, view, cmd, evidence: ev });
  await complete(body);
  return body;
}

/** No launch while a landing is in flight for the node. `landing` is a Map/Set of node keys. */
export const mayLaunch = (node, landing) => !landing.has(node.key);
