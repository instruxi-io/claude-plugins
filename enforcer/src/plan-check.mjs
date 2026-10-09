// @ts-nocheck TODO(typecheck): many inferred-shape errors from untyped option objects, not bugs; annotate with JSDoc when tightening
// `enforcer plan check <graph> [--repo-root dir]`: run each open node's acceptance commands and flag lines
// whose quoted output never appears. Per line: ok | MISMATCH (ran, literal absent; shows the real last line) | SKIPPED.
// Each result is printed as soon as it is known, with a running count on stderr. Exit 1 on MISMATCH only.
// Only lines that fully match a shape in src/acceptance-allowlist.mjs run (no shell), in the node's repo checkout,
// 300 s each (--timeout), with a minimal env and a temporary HOME.
// Options: --repo-root <dir>, --only <node key>, --timeout <seconds>.
import { literalIn } from './literal-match.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from '../lib/api/client.mjs';
import { headers, allNodes } from './preflight.mjs';
import { resolveConfig } from './config.mjs';
import { substitute } from './evidence-run.mjs'; // the one place that knows the acceptance-line rules
import { ACCEPTANCE_SHAPES, allowedCommand, goTestArgv, removeTree, spawnAllowed } from './acceptance-allowlist.mjs';

/** The shared allow list (src/acceptance-allowlist.mjs); removeTree moved there with the runner. */
export { ACCEPTANCE_SHAPES, removeTree };
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

/** Why a command cannot run here, or null when it can. `root` is the checkout its paths must stay inside. */
export function skipReason(cmd, root = process.cwd()) {
  if (/<[^<>\s][^<>]*>/.test(cmd)) return 'placeholder in command';
  return allowedCommand(cmd, { root }).skip ?? null;
}

export function checkLine(line, cwd, env, { timeoutMs = 300000, graph = '' } = {}) {
  const p = parseLine(line);
  if (!p) return { state: 'SKIPPED', note: 'no "prints|exits <literal>" form' };
  const sub = substitute(p.cmd, { graph });
  if (!sub.skip) p.cmd = sub.cmd; // `<graph>` filled in, as `enforcer evidence run` does
  if (/<[^<>\s][^<>]*>/.test(p.cmd)) return { state: 'SKIPPED', note: 'placeholder in command' };
  if (!cwd || !existsSync(cwd)) return { state: 'SKIPPED', note: `no checkout at ${cwd}` };
  const ok = allowedCommand(p.cmd, { root: cwd });
  if (ok.skip) return { state: 'SKIPPED', note: ok.skip };
  const r = spawnAllowed(goTestArgv(ok.argv, p.literals), { cwd, env, timeoutMs });
  if (r.timedOut) return { state: 'SKIPPED', note: `timed out after ${Math.round(timeoutMs / 1000)}s` };
  if (r.error) return { state: 'SKIPPED', note: `could not run: ${r.error.message}` };
  const out = r.out;
  const last =
    out
      .split('\n')
      .map((s) => s.trimEnd())
      .filter(Boolean)
      .at(-1) ?? '(no output)';
  const missing = p.literals.filter((l) => !literalIn(out, l));
  if (p.exit !== null && r.exit !== p.exit) return { state: 'MISMATCH', note: `exit ${r.exit}, expected ${p.exit}; last line: ${last}` };
  if (missing.length) return { state: 'MISMATCH', note: `output never contains ${missing.map((l) => JSON.stringify(l)).join(', ')}; last line: ${last}` };
  return { state: 'ok', note: '' };
}

/** Server-side advisory lint (one ruleset, enforcer-graph POST /graphs/{id}/acceptance/lint). Never fatal: [] on any failure. */
export async function serverLint(base, graph, h, acceptance) {
  try {
    const b = await request(
      `${base}/graphs/${encodeURIComponent(graph)}/acceptance/lint`,
      {
        method: 'POST',
        headers: { ...h, 'content-type': 'application/json' },
        body: JSON.stringify({ acceptance }),
      },
      { retries: 0 },
    );
    return Array.isArray(b?.warnings) ? b.warnings : Array.isArray(b?.data?.warnings) ? b.data.warnings : [];
  } catch {
    return [];
  }
}

/** Returns {code, lines}. `onLine(text, {done, total})` is called with each line as soon as it is known. */
export async function planCheck({ graph, repoRoot = join(homedir(), 'apps'), env = process.env, only = null, timeoutMs = 300000, onLine = () => {} } = {}) {
  const base = resolveConfig({ env }).graphUrl;
  const h = await headers(env);
  const nodes = (await allNodes(base, graph, h)).filter((n) => !CLOSED.has(n.status) && (!only || n.key === only));
  const accOf = (n) => {
    const a = n.data?.acceptance;
    return Array.isArray(a) ? a : a ? [a] : [];
  };
  const total = nodes.reduce((k, n) => k + accOf(n).length, 0);
  const lines = [];
  let bad = 0;
  const emit = (text) => {
    lines.push(text);
    onLine(text, { done: lines.filter((l) => !l.startsWith('WARN ')).length, total });
  };
  for (const n of nodes) {
    const accs = accOf(n);
    const warns = accs.length ? await serverLint(base, graph, h, accs.map(String)) : [];
    for (const [i, a] of accs.entries()) {
      await new Promise((r) => setImmediate(r)); // let the previous line reach the reader before the next command blocks
      const cwd = n.data?.repo ? join(repoRoot, n.data.repo) : repoRoot;
      const r = checkLine(String(a), cwd, env, { timeoutMs, graph });
      if (r.state === 'MISMATCH') bad++;
      emit(`${r.state} ${n.key}: ${String(a).replace(/\s+/g, ' ').slice(0, 100)}${r.note ? ' -- ' + r.note : ''}`);
      for (const w of warns.filter((w) => w.index === i)) emit(`WARN ${n.key}: [${w.code}] ${w.hint ?? ''}`.trimEnd());
    }
  }
  return { code: bad ? 1 : 0, lines };
}

export async function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const valued = new Set(['--repo-root', '--only', '--timeout']);
  const graph = argv.find((a, i) => !a.startsWith('-') && !valued.has(argv[i - 1]));
  if (!graph) {
    process.stderr.write('usage: enforcer plan check <graph> [--repo-root dir] [--only <node key>] [--timeout <seconds>]\n');
    return 2;
  }
  const secs = opt('--timeout') === undefined ? 300 : Number(opt('--timeout'));
  if (!(secs > 0)) {
    process.stderr.write('enforcer plan check: --timeout must be a positive number of seconds\n');
    return 2;
  }
  try {
    const { code } = await planCheck({
      graph,
      only: opt('--only') ?? null,
      timeoutMs: secs * 1000,
      ...(opt('--repo-root') ? { repoRoot: opt('--repo-root') } : {}),
      onLine: (text, { done, total }) => {
        process.stdout.write(text + '\n');
        if (!text.startsWith('WARN ')) process.stderr.write(`[${done}/${total}]\n`);
      },
    });
    return code;
  } catch (e) {
    process.stderr.write(`enforcer plan check: ${e.message}\n`);
    return 2;
  }
}
