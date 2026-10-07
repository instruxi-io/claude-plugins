// `enforcer evidence run <graph>:<node-key|id> [--graph <id>] [--cwd dir] [--only <index>] [--timeout <s>] [--test-db <url>]`
//
// One place for the rules every completion path (a worker before graph_report, the dispatcher's landing completion,
// a coordinator, `plan check`) re-learned the hard way before the judge accepted their evidence:
//   - run each `<command> prints|exits ...` acceptance line with the harness environment cleared and a timeout;
//   - the judge reads the evidence, not the repository, so quote the literal output: head and tail of the output, and
//     the line holding a quoted literal when the clip would drop it;
//   - Go tests need `-tags integration -run <Name> -v` so `--- PASS: <Name>` appears;
//   - substitute `<graph>` (and `<test db>`, `<key>`, `<node-id>`); a line with any other placeholder is skipped;
//   - run from the directory the line implies (`cd enforcer/test && ...` sets the cwd, relative to --cwd);
//   - retry a suite once when it collides with a concurrent run (port in use, locked database);
//   - skip the PR (gh, git) and prose lines: those are proved by the delivery step, not by a command here.
// Output: one JSON evidence item per command run ({kind:'command', cmd, exit, output, line_index}), skipped lines on
// stderr, then `literals found: <k>/<n>`. Exit 0 when every quoted literal was found, 1 when one was not, 2 on usage or
// a node that cannot be loaded. `line_index` is the 0-based position in the node's acceptance list.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseLine } from './plan-check.mjs';
import { headers, allNodes } from './preflight.mjs';
import { resolveConfig } from './config.mjs';

export const DEFAULT_RUNNERS = ['node', 'bash', 'sh', 'grep', 'ls', 'npm', 'npx', 'cat', 'test', 'wc', 'head', 'tail', 'go', 'make'];
export const COLLISION = /EADDRINUSE|address already in use|database is locked|SQLITE_BUSY|deadlock detected|could not obtain lock|resource temporarily unavailable|text file busy|ETXTBSY|port is already allocated|being accessed by other users/i;
const CLEAN_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOFLAGS', 'GOROOT'];

/** The node's acceptance lines as an array of strings. */
export const acceptanceOf = (node) => { const a = node?.data?.acceptance; return (Array.isArray(a) ? a : a ? [a] : []).map(String); };

/** Add the flags a Go test line needs for `--- PASS: <Name>` to appear. */
export function goTestFlags(cmd, literals) {
  if (!/\bgo test\b/.test(cmd)) return cmd;
  const names = [...new Set(literals.flatMap((l) => [...l.matchAll(/--- PASS: ([A-Za-z0-9_]+)/g)].map((m) => m[1])))];
  if (!names.length) return cmd;
  const add = [];
  if (!/(^|\s)-tags[ =]/.test(cmd)) add.push('-tags integration');
  if (!/(^|\s)-(test\.)?v(\s|$)/.test(cmd)) add.push('-v');
  if (!/(^|\s)-run[ =]/.test(cmd)) add.push(`-run '^(${names.join('|')})$'`);
  return add.length ? cmd.replace(/\bgo test\b/, () => `go test ${add.join(" ")}`) : cmd;
}

/** Substitute placeholders. Returns {cmd} or {skip: reason}. */
export function substitute(cmd, { graph, nodeKey, nodeId, testDb }) {
  const values = { graph, 'test db': testDb, key: nodeKey, 'node-key': nodeKey, 'node-id': nodeId };
  let skip = null;
  const out = cmd.replace(/<([^<>\s][^<>]*)>/g, (all, name) => {
    const v = values[name.trim()];
    if (v) return v;
    skip ??= values[name.trim()] === undefined && !(name.trim() in values) ? `placeholder ${all}` : `no value for ${all}`;
    return all;
  });
  return skip ? { skip } : { cmd: out };
}

/** Prepare one acceptance line: {cmd, cwd, literals, exit} to run, or {skip}. Pure. */
export function prepareLine(line, { cwd, graph, nodeKey, nodeId, testDb, runners = DEFAULT_RUNNERS }) {
  let p = parseLine(line);
  if (!p) { // `<command> prints the file` quotes nothing, but the command's output is still the evidence
    const m = /^(.*?)\s+prints\s+/s.exec(line.trim());
    if (!m) return { skip: 'no "prints|exits <literal>" form' };
    p = { cmd: m[1].trim().replace(/^`([^`]*)`$/, '$1'), exit: null, literals: [] };
  }
  let cmd = p.cmd;
  const sub = substitute(cmd, { graph, nodeKey, nodeId, testDb });
  if (sub.skip) return { skip: sub.skip };
  cmd = sub.cmd;
  if (/(^|[\s;&|(])(\S*bin\/enforcer|enforcer)\s+evidence\s+run\b/.test(cmd)) return { skip: 'would run itself' };
  if (/(^|[\s;&|(])(gh|git)\s/.test(cmd) || /\bpull request\b/i.test(line)) return { skip: 'PR line: proved by the delivery step' };
  let dir = cwd;
  const cd = /^cd\s+(\S+)\s*&&\s*(.*)$/s.exec(cmd);
  if (cd) { dir = resolve(cwd, cd[1].replace(/^['"]|['"]$/g, '')); cmd = cd[2].trim(); }
  const parts = cmd.split(/\s*(?:&&|;|\|\|?)\s*/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const w = part.split(/\s+/)[0];
    if (w === 'cd') continue;
    if (!runners.includes(w)) return { skip: `not a runnable command: ${w}` };
  }
  if (/(^|[\s;&|(])(rm|mv|curl|tee)\s|\bsed\s+-[a-zA-Z]*i|(^|\s)>{1,2}\s*(?!\/dev\/null|&)\S/.test(cmd)) return { skip: 'not read-only' };
  return { cmd: goTestFlags(cmd, p.literals), cwd: dir, literals: p.literals, exit: p.exit };
}

const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Head and tail of the output, plus the line holding any quoted literal the clip dropped. */
export function clipEvidence(out, literals = []) {
  const text = out.trim();
  let clipped = text.length > 3000 ? text.slice(0, 1200) + '\n...\n' + text.slice(-1800) : text;
  if (clipped !== text) {
    for (const l of literals) {
      if (!text.includes(l) || clipped.includes(l)) continue;
      const hit = text.split('\n').find((s) => s.includes(l));
      if (hit) clipped += `\n[match] ${hit.slice(0, 300)}`;
    }
  }
  return clipped;
}

/** Run a prepared line with the harness env cleared; retry once on a collision. */
export function runPrepared(p, { env = process.env, timeoutMs = 600000, retryDelayMs = 2000, run = spawnSync } = {}) {
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => CLEAN_ENV.includes(k)));
  const once = () => {
    const r = run('bash', ['-c', p.cmd], { cwd: p.cwd, env: clean, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 });
    if (r.error?.code === 'ETIMEDOUT') return { exit: 124, out: `timed out after ${Math.round(timeoutMs / 1000)} s` };
    if (r.error) return { exit: 127, out: String(r.error.message) };
    return { exit: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
  };
  let r = once(), retried = false;
  if (r.exit !== 0 && COLLISION.test(r.out)) { retried = true; sleep(retryDelayMs); r = once(); }
  return { ...r, retried };
}

/** Run a node's acceptance lines. Returns {items, skipped, found, total, retried}. */
export function runEvidence(node, { cwd = process.cwd(), graph = '', only = null, env = process.env, timeoutMs, retryDelayMs, testDb = env.ENFORCER_TEST_DB || env.TEST_DATABASE_URL || '', runners, run } = {}) {
  const items = [], skipped = [], retried = [];
  let found = 0, total = 0;
  acceptanceOf(node).forEach((line, i) => {
    if (only !== null && i !== only) return;
    const p = prepareLine(line, { cwd, graph, nodeKey: node.key, nodeId: node.node_id ?? node.id, testDb, runners });
    if (p.skip) { skipped.push({ line_index: i, reason: p.skip }); return; }
    if (!existsSync(p.cwd)) { skipped.push({ line_index: i, reason: `no directory ${p.cwd}` }); return; }
    const r = runPrepared(p, { env, timeoutMs, retryDelayMs, run });
    if (r.retried) retried.push(i);
    total += p.literals.length;
    found += p.literals.filter((l) => r.out.includes(l)).length;
    items.push({ kind: 'command', cmd: p.cmd, exit: r.exit, output: clipEvidence(r.out, p.literals), line_index: i });
  });
  return { items, skipped, found, total, retried };
}

/** Find a node by key or id in a graph. */
export async function loadNode(graph, ref, env = process.env) {
  const base = resolveConfig({ env }).graphUrl;
  const nodes = await allNodes(base, graph, await headers(env));
  const node = nodes.find((n) => n.key === ref || n.node_id === ref || n.id === ref);
  if (!node) throw new Error(`no node ${ref} in graph ${graph}`);
  return node;
}

const USAGE = 'usage: enforcer evidence run <graph>:<node-key|id> [--graph <id>] [--cwd dir] [--only <index>] [--timeout <seconds>] [--test-db <url>]\n';

export async function main(argv, env = process.env) {
  if (argv[0] !== 'run') { process.stderr.write(USAGE); return 2; }
  const rest = argv.slice(1);
  const valued = new Set(['--graph', '--cwd', '--only', '--timeout', '--test-db']);
  const opt = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const target = rest.find((a, i) => !a.startsWith('-') && !valued.has(rest[i - 1]));
  if (!target) { process.stderr.write(USAGE); return 2; }
  let graph = opt('--graph'), ref = target;
  const m = /^([^:]+):(.+)$/.exec(target);
  if (m && !graph) [, graph, ref] = m;
  if (!graph) { process.stderr.write('enforcer evidence run: name the graph as <graph>:<node> or --graph <id>\n' + USAGE); return 2; }
  const secs = opt('--timeout') === undefined ? 600 : Number(opt('--timeout'));
  const only = opt('--only') === undefined ? null : Number(opt('--only'));
  if (!(secs > 0) || (only !== null && !(Number.isInteger(only) && only >= 0))) { process.stderr.write(USAGE); return 2; }
  try {
    const node = await loadNode(graph, ref, env);
    const r = runEvidence(node, { cwd: resolve(opt('--cwd') ?? '.'), graph, only, env, timeoutMs: secs * 1000, ...(opt('--test-db') ? { testDb: opt('--test-db') } : {}) });
    for (const it of r.items) process.stdout.write(JSON.stringify(it) + '\n');
    for (const s of r.skipped) process.stderr.write(`SKIPPED line ${s.line_index}: ${s.reason}\n`);
    for (const i of r.retried) process.stderr.write(`line ${i} collided with a concurrent run and was retried once\n`);
    process.stdout.write(`literals found: ${r.found}/${r.total}\n`);
    return r.found < r.total ? 1 : 0;
  } catch (e) { process.stderr.write(`enforcer evidence run: ${e.message}\n`); return 2; }
}
