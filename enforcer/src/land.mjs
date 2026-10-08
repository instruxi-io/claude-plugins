// `enforcer land <pr> [-R owner/repo] [--timeout SECONDS]`: lands one pull request with no model in the loop.
// Port of the former bin/land-pr.sh. Exit codes:
//   0 merged (prints end-state evidence)   2 CI failed on the head (or usage error)
//   3 conflicts with the base              4 timed out still waiting
//   5 gh error, PR closed unmerged, or merge not found on the base
//   7 CI unavailable: the cancelled check's jobs ran zero steps (an Actions outage)
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const USAGE = 'usage: enforcer land <pr> [-R owner/repo] [--timeout s]\n';
const BAD = ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'];

export async function main(argv, env = process.env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let pr = '',
    repo = null,
    timeout = 3600;
  const poll = Number(env.LAND_PR_POLL || 15);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-R') {
      if (i + 1 >= argv.length) {
        io.err(USAGE);
        return 2;
      }
      repo = argv[++i];
    } else if (a === '--timeout') {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) {
        io.err(USAGE);
        return 2;
      }
      timeout = Number(v);
    } else if (a === '-h' || a === '--help') {
      io.out(USAGE);
      return 0;
    } else if (a.startsWith('-')) {
      io.err(USAGE);
      return 2;
    } else pr = a;
  }
  if (!pr) {
    io.err(USAGE);
    return 2;
  }
  const R = repo ? ['-R', repo] : [];
  const gh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8', env });
    return r.status === 0 && !r.error ? r.stdout : null;
  };
  const ghJson = (args) => {
    const o = gh(args);
    if (o == null) return null;
    try {
      return JSON.parse(o);
    } catch {
      return null;
    }
  };
  const view = (fields) => ghJson(['pr', 'view', pr, ...R, '--json', fields]);
  const field = (f) => view(f)?.[f] ?? null;

  let state = field('state');
  if (state == null) {
    io.err(`land-pr: cannot read PR ${pr}\n`);
    return 5;
  }
  const nwo = (ghJson(['repo', 'view', ...(repo ? [repo] : []), '--json', 'nameWithOwner']) || {}).nameWithOwner || '';

  // A merge method the repo allows: squash, then merge commit, then rebase.
  let method = '--squash';
  const f = ghJson(['repo', 'view', ...(repo ? [repo] : []), '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed']);
  if (f) {
    if (f.squashMergeAllowed) method = '--squash';
    else if (f.mergeCommitAllowed) method = '--merge';
    else if (f.rebaseMergeAllowed) method = '--rebase';
  }

  // --auto only where branch protection enforces green; otherwise merge ourselves once every check finished green.
  let manual = true;
  if (state === 'OPEN') {
    const base = field('baseRefName');
    const out = gh(['api', `repos/${nwo}/branches/${base}/protection`, '--jq', '.required_status_checks.checks | length']);
    const required = /^\d+$/.test((out || '').trim()) ? Number(out.trim()) : 0;
    if (required > 0 && gh(['pr', 'merge', pr, ...R, method, '--auto', '--delete-branch']) != null) manual = false;
  } else if (state !== 'MERGED') {
    io.err(`land-pr: PR ${pr} is ${state}\n`);
    return 5;
  }

  const rollup = (v) =>
    (v?.statusCheckRollup || []).map((c) => {
      const concl = c.conclusion || c.state || '';
      return {
        n: c.name || c.context,
        done: (c.status || 'COMPLETED') === 'COMPLETED' && c.state !== 'PENDING' && c.state !== 'EXPECTED',
        canc: concl === 'CANCELLED',
        bad: BAD.includes(concl),
      };
    });

  const start = Date.now(),
    deadline = start + timeout * 1000;
  let last = '';
  for (;;) {
    const v = view('state,mergeStateStatus,statusCheckRollup,headRefOid');
    state = v?.state ?? null;
    if (state === 'MERGED') break;
    if (state === 'CLOSED') {
      io.err(`land-pr: PR ${pr} was closed without merging\n`);
      return 5;
    }
    const ms = v?.mergeStateStatus ?? '';
    if (ms !== last) {
      io.out(`land-pr: #${pr} ${state} / ${ms}\n`);
      last = ms;
    }
    if (ms === 'DIRTY') {
      io.err(`land-pr: #${pr} conflicts with its base; rebase, resolve by reading both sides, re-verify, push, then run this again\n`);
      return 3;
    }
    if (ms === 'BEHIND' && gh(['pr', 'update-branch', pr, ...R]) == null) {
      if (field('state') === 'MERGED') break; // a queued --auto merge landed between read and update
      io.err(`land-pr: #${pr} is behind and could not be updated cleanly (conflict); rebase by hand\n`);
      return 3;
    }
    const checks = rollup(v);
    const head = v?.headRefOid ?? '';
    let failed = checks.filter((c) => c.bad).map((c) => c.n);
    const cancelled = checks.filter((c) => c.canc).map((c) => c.n);
    if (cancelled.length) {
      // Cancelled is a superseded run when a newer, non-cancelled run exists for the same head.
      const runs = ghJson(['run', 'list', ...R, '--commit', head, '--json', 'conclusion,createdAt,databaseId']) || [];
      const lastCanc = runs
        .filter((r) => r.conclusion === 'cancelled')
        .map((r) => r.createdAt)
        .sort()
        .at(-1);
      const newer = runs.filter((r) => r.conclusion !== 'cancelled' && (lastCanc === undefined || r.createdAt > lastCanc)).length;
      if (!newer) {
        const ids = runs.filter((r) => r.conclusion === 'cancelled').map((r) => r.databaseId);
        let steps = 0;
        for (const id of ids) {
          const j = ghJson(['run', 'view', String(id), ...R, '--json', 'jobs']);
          steps += j ? (j.jobs || []).reduce((s, x) => s + (x.steps || []).length, 0) : 1;
        }
        if (ids.length && steps === 0 && !failed.length) {
          io.err(`land-pr: #${pr} CI unavailable: ${cancelled.join(', ')} cancelled with zero steps run (GitHub Actions outage?)\n`);
          return 7;
        }
        failed = [...failed, ...cancelled];
      }
    }
    if (failed.length) {
      io.err(`land-pr: #${pr} CI failed: ${failed.join(', ')}\n`);
      const o = spawnSync('gh', ['pr', 'checks', pr, ...R], { encoding: 'utf8', env });
      io.err(
        ((o.stdout || '') + (o.stderr || ''))
          .split('\n')
          .filter((l) => l && !/pass|skipping/i.test(l))
          .join('\n') + '\n',
      );
      return 2;
    }
    if (manual && ms !== 'BEHIND' && ms !== 'BLOCKED') {
      const pending = checks.filter((c) => !c.done).length;
      // The rollup lists only registered check runs; also require every workflow run for the head to be completed and not failed.
      const runs = ghJson(['run', 'list', ...R, '--commit', head, '--json', 'status,conclusion,name']);
      const list = Array.isArray(runs) ? runs : [];
      const runsPending = list.filter((r) => r.status !== 'completed').length;
      const runsBad = list.filter((r) => r.status === 'completed' && !['success', 'skipped', 'neutral'].includes(r.conclusion)).map((r) => r.name);
      if (runsBad.length) {
        io.err(`land-pr: #${pr} workflow run(s) failed: ${runsBad.join(', ')}\n`);
        return 2;
      }
      const registered = checks.length > 0 && list.length > 0;
      if (pending === 0 && runsPending === 0 && (registered || Date.now() - start >= 90000)) {
        gh(['pr', 'merge', pr, ...R, method, '--delete-branch', '--match-head-commit', head]);
      }
    }
    if (Date.now() >= deadline) {
      io.err(`land-pr: #${pr} still ${ms} after ${timeout}s\n`);
      return 4;
    }
    await sleep(poll * 1000);
  }

  // End-state evidence: what a merge node's acceptance is judged on.
  const e = view('number,state,mergedAt,mergeCommit,baseRefName') || {};
  const sha = e.mergeCommit?.oid ?? null,
    base = e.baseRefName ?? null;
  io.out(JSON.stringify({ number: e.number, state: e.state, mergedAt: e.mergedAt, mergeCommit: sha, base }) + '\n');
  if (repo) {
    const cmp = (gh(['api', `repos/${nwo}/compare/${base}...${sha}`, '--jq', '.status']) || '').trim();
    if (cmp === 'identical' || cmp === 'behind') io.out(`gh api repos/${nwo}/compare/${base}...${sha} -> ${cmp}\n`);
    else {
      io.err(`gh api repos/${nwo}/compare/${base}...${sha} -> '${cmp}' (merge not on ${base})\n`);
      return 5;
    }
  } else if (spawnSync('git', ['rev-parse', '--git-dir'], { env }).status === 0 && spawnSync('git', ['fetch', '-q', 'origin', base], { env }).status === 0) {
    if (spawnSync('git', ['merge-base', '--is-ancestor', sha, `origin/${base}`], { env }).status === 0)
      io.out(`git merge-base --is-ancestor ${sha} origin/${base} -> exit 0\n`);
    else {
      io.err(`git merge-base --is-ancestor ${sha} origin/${base} -> not an ancestor\n`);
      return 5;
    }
  }
  return 0;
}
