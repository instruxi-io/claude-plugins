// Salvage a worker that could not publish its PR: publish the branch, reuse or open the PR, neutralise auto-link
// markers in the body, and land it with a heartbeat on the worker's run so the lease outlives CI.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, statSync } from 'node:fs';
import { clip } from './util.mjs';

export const ATTRIBUTION = '\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)';
export const TRANSIENT_RE =
  /temporary failure in name resolution|could not resolve host|connection (reset|refused|timed out)|timed? ?out|network is unreachable|tls handshake|unexpected eof|http (502|503|504)|error connecting to|name or service not known/i;
export const PUSH_DENIAL_RE = /git\s+push|gh\s+pr\b|\bpush(ed|ing)?\b[\s\S]*\bdenied|\bdenied\b[\s\S]*\b(push|pull request)/i;

/** Worker text as a quoted block: `Fixes #N` no longer closes issues, @mentions no longer ping. */
export function quoteBody(text) {
  let t = String(text).replace(/\b(fix(?:e[sd])?|close[sd]?|resolve[sd]?)(:?)\s+(?=[\w./-]*#\d)/gi, (_, v, c) => `${v}​${c} `);
  t = t.replaceAll('@', '@​');
  const lines = t.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => '> ' + l).join('\n') || '> ';
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Run a command, retrying a transient network failure with backoff; never throws. -> [rc, out] */
export function sh(cmd, cwd, { timeout = 300000, sleepMs = 1000, run = spawnSync } = {}) {
  let rc = 127,
    out = '';
  for (let i = 0; i < 3; i++) {
    const r = run(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout });
    if (r.error) {
      rc = 127;
      out = String(r.error.message);
    } else {
      rc = r.status ?? 1;
      out = ((r.stdout || '') + (r.stderr || '')).trim();
    }
    if (rc === 0 || !TRANSIENT_RE.test(out) || i === 2) break;
    if (sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs * 2 ** i);
  }
  return [rc, out];
}

/**
 * Publish the worker's branch and find or open its PR. Returns {pr, reused} or {skip: why}.
 * `run` is injectable: (cmd, cwd) -> [rc, out].
 */
export function preparePr({ node, path, result, base = 'origin/HEAD', run = sh }) {
  const key = node.key;
  const branch = 'graph/' + key;
  if (!path || path === '-' || !isDir(path)) return { skip: 'no worktree' };
  let [rc, cur] = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], path);
  if (rc || cur !== branch) return { skip: `branch is ${cur || 'unknown'}, not ${branch}` };
  let st;
  [rc, st] = run(['git', 'status', '--porcelain'], path);
  if (rc || st) return { skip: 'worktree is dirty or unreadable' };
  let n;
  [rc, n] = run(['git', 'rev-list', '--count', base + '..HEAD'], path);
  if (rc || !/^\d+$/.test(n) || Number(n) < 1) return { skip: `branch has no commits ahead of ${base}` };
  let out;
  [rc, out] = run(['git', 'push', '-u', 'origin', branch], path);
  if (rc) return { skip: 'publish failed: ' + clip(out, 200) };
  // a PR for this branch may already exist (the worker opened it, or a retry): reuse it
  [rc, out] = run(['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number'], path);
  if (rc === 0 && /^\d+$/.test(out.trim())) return { pr: out.trim(), reused: true };
  let prBase = base === 'origin/HEAD' ? 'origin/main' : base;
  if (base === 'origin/HEAD') {
    const [hrc, h] = run(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], path);
    if (hrc === 0 && h) prBase = h;
  }
  prBase = prBase.replace(/^origin\//, '');
  const body = quoteBody(result || '(no final report)') + '\n\n' + ATTRIBUTION;
  [rc, out] = run(['gh', 'pr', 'create', '--base', prBase, '--head', branch, '--title', node.title || key, '--body', body], path);
  const m = rc === 0 ? /\/pull\/(\d+)/.exec(out) : null;
  if (!m) return { skip: 'gh pr create failed: ' + clip(out, 200) };
  return { pr: m[1], reused: false };
}

/**
 * Run the lander as a child and heartbeat the run every `everyMs` while it waits for CI, so the
 * lease does not lapse. Resolves {rc}. `heartbeat` is async () => state.
 */
export function landWithHeartbeat({ cmd, cwd, logPath, heartbeat, everyMs = 120000, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const fd = openSync(logPath, 'w');
    let proc;
    try {
      proc = spawnImpl(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', fd, fd], detached: true });
    } catch {
      closeSync(fd);
      return resolve({ rc: 127 });
    }
    const timer = setInterval(() => {
      Promise.resolve(heartbeat()).catch(() => {});
    }, everyMs);
    const done = (rc) => {
      clearInterval(timer);
      closeSync(fd);
      resolve({ rc });
    };
    proc.on('error', () => done(127));
    proc.on('close', (code) => done(code ?? 1));
  });
}
