// `enforcer plan check <graph> [--repo-root dir]`: run each open node's acceptance commands and flag lines
// whose quoted output never appears. Per line: ok | MISMATCH (ran, literal absent; shows the real last line) | SKIPPED.
// Exit 1 on any MISMATCH. Only read-only commands run, in the node's repo checkout, 300 s, isolated env.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { headers, allNodes, DEFAULT_GRAPH_BASE } from './preflight.mjs';

const RUNNABLE = new Set(['node', 'python3', 'bash', 'sh', 'grep', 'ls', 'npm', 'cat', 'test', 'wc', 'head', 'tail']);
const CLOSED = new Set(['done', 'cancelled', 'succeeded']);

/** "<command> prints|exits ... <quoted literal>" -> {cmd, exit, literals} or null. */
export function parseLine(line) {
  const m = /^(.*?)\s+(prints|exits)\s+(.*)$/s.exec(line.trim());
  if (!m) return null;
  let cmd = m[1].trim();
  if (/^`[^`]*`$/.test(cmd)) cmd = cmd.slice(1, -1);
  const after = m[2] + ' ' + m[3];
  const literals = [];
  for (const q of after.matchAll(/`([^`]+)`|"((?:[^"\\]|\\.)+)"|'([^']+)'/g)) literals.push(q[1] ?? q[2] ?? q[3]);
  const ex = /\bexits\s+(\d+)/.exec(after);
  if (!literals.length && !ex) return null;
  return { cmd, exit: ex ? Number(ex[1]) : null, literals };
}

/** Why a command cannot run here, or null when it can. */
export function skipReason(cmd) {
  if (/<[^<>\s][^<>]*>/.test(cmd)) return 'placeholder in command';
  const parts = cmd.split(/\s*(?:&&|;|\|\|?)\s*/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const w = p.split(/\s+/);
    if (w[0] === 'cd') continue;
    if (w[0] === 'gh') { if (!/^gh pr view\b/.test(p)) return 'gh command is not pr view'; continue; }
    if (!RUNNABLE.has(w[0])) return `not a runnable command: ${w[0]}`;
  }
  if (/(^|\s)(rm|mv|curl)\s/.test(cmd) || />\s*[^&\s]/.test(cmd.replace(/2>&1|>\s*\/dev\/null/g, ''))) return 'not read-only';
  return null;
}

export function checkLine(line, cwd, env) {
  const p = parseLine(line);
  if (!p) return { state: 'SKIPPED', note: 'no "prints|exits <literal>" form' };
  const why = skipReason(p.cmd);
  if (why) return { state: 'SKIPPED', note: why };
  if (!cwd || !existsSync(cwd)) return { state: 'SKIPPED', note: `no checkout at ${cwd}` };
  const home = mkdtempSync(join(tmpdir(), 'plan-check-'));
  try {
    const r = spawnSync('sh', ['-c', p.cmd], { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 64 << 20,
      env: { PATH: env.PATH, HOME: home, TMPDIR: home, LANG: 'C.UTF-8', CI: '1' } });
    if (r.error) return { state: 'SKIPPED', note: `could not run: ${r.error.message}` };
    const out = (r.stdout || '') + (r.stderr || '');
    const last = out.split('\n').map((s) => s.trimEnd()).filter(Boolean).at(-1) ?? '(no output)';
    const missing = p.literals.filter((l) => !out.includes(l));
    if (p.exit !== null && r.status !== p.exit) return { state: 'MISMATCH', note: `exit ${r.status}, expected ${p.exit}; last line: ${last}` };
    if (missing.length) return { state: 'MISMATCH', note: `output never contains ${missing.map((l) => JSON.stringify(l)).join(', ')}; last line: ${last}` };
    return { state: 'ok', note: '' };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Returns {code, lines}. */
export async function planCheck({ graph, repoRoot = join(homedir(), 'apps'), env = process.env } = {}) {
  const base = env.GRAPH_BASE_URL || DEFAULT_GRAPH_BASE;
  const h = await headers(env);
  const nodes = (await allNodes(base, graph, h)).filter((n) => !CLOSED.has(n.status));
  const lines = [];
  let bad = 0;
  for (const n of nodes) {
    const acc = n.data?.acceptance;
    for (const a of Array.isArray(acc) ? acc : acc ? [acc] : []) {
      const cwd = n.data?.repo ? join(repoRoot, n.data.repo) : repoRoot;
      const r = checkLine(String(a), cwd, env);
      if (r.state === 'MISMATCH') bad++;
      lines.push(`${r.state} ${n.key}: ${String(a).replace(/\s+/g, ' ').slice(0, 100)}${r.note ? ' -- ' + r.note : ''}`);
    }
  }
  return { code: bad ? 1 : 0, lines };
}

export async function main(argv) {
  const ri = argv.indexOf('--repo-root');
  const graph = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--repo-root');
  if (!graph) { process.stderr.write('usage: enforcer plan check <graph> [--repo-root dir]\n'); return 2; }
  try {
    const { code, lines } = await planCheck({ graph, ...(ri >= 0 ? { repoRoot: argv[ri + 1] } : {}) });
    for (const l of lines) process.stdout.write(l + '\n');
    return code;
  } catch (e) { process.stderr.write(`enforcer plan check: ${e.message}\n`); return 2; }
}
