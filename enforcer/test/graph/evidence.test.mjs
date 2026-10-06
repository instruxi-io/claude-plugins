import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, truncateSync, statSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvidence, loadEvidence, evidencePath, sweepSessions, selectEvidence, mergeEvidence, RAW_RUN_CAP } from '../../src/graph/evidence.mjs';
import { dataDir } from '../../src/graph/state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LIBDIR = join(here, '../../lib/graph');
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'gevid-'));
  process.env.ENFORCER_STATE_DIR = join(root, 'state');
  return root;
};
const cmd = (c, exit = 0, extra = {}) => ({ kind: 'command', cmd: c, exit, output: 'o', ...extra });

const FIXTURE = [
  { kind: 'command', cmd: 'ls -la', exit: 0, output: 'a\nb\t"q"', _run: 'r1' },
  { kind: 'command', cmd: 'npm test', exit: 1, output: 'fail ✗ 日本語 😀\u0001\u007f' },
  { kind: 'file', path: '/tmp/x', excerpt: 'é', nested: { a: [1, 2.5, null, true], b: {} } },
  { kind: 'artifact', url: 'https://github.com/o/r/pull/1', label: 'pr', raw: 'zzz' },
  { kind: 'command', cmd: 'x', exit: null, output: '' },
];

test('jsonl is byte-identical to the python store for the fixture sequence', () => {
  const root = fresh();
  for (const r of FIXTURE) appendEvidence('sess', r);
  const node = readFileSync(evidencePath('sess'));
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(LIBDIR)})
import lib
for r in json.loads(sys.stdin.read()):
    lib.append_evidence('sess2', r)
print(lib.evidence_path('sess2'))`;
  process.env.ENFORCER_STATE_DIR = join(root, 'pystate');
  const out = execFileSync('python3', ['-I', '-c', py], { input: JSON.stringify(FIXTURE), env: { ...process.env } }).toString().trim();
  assert.ok(existsSync(out), out);
  assert.equal(Buffer.compare(node, readFileSync(out)), 0);
  assert.equal(loadEvidence('sess2').length, FIXTURE.length);
});

test('concurrent appends do not interleave', async () => {
  const root = fresh();
  const big = 'x'.repeat(60000);
  const script = join(root, 'w.mjs');
  writeFileSync(script, `import { appendEvidence } from ${JSON.stringify(join(here, '../../src/graph/evidence.mjs'))};
for (let i = 0; i < 15; i++) appendEvidence('c', { kind: 'command', cmd: 'w' + process.argv[2], exit: 0, output: ${JSON.stringify(big)}, i });`);
  await Promise.all([0, 1, 2, 3, 4, 5].map((n) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [script, String(n)], { env: process.env, stdio: 'ignore' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error('exit ' + c))));
  })));
  const lines = readFileSync(evidencePath('c'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 90);
  for (const l of lines) assert.equal(JSON.parse(l).output.length, 60000);
});

test('cap holds at 50 MB', () => {
  fresh();
  const p = evidencePath('big');
  writeFileSync(p, '');
  truncateSync(p, RAW_RUN_CAP - 300);
  appendEvidence('big', { kind: 'command', cmd: 'a', exit: 0, raw: 'y'.repeat(500) });
  const marked = readFileSync(p).subarray(RAW_RUN_CAP - 300).toString();
  assert.match(marked, /raw_truncated/);
  assert.ok(statSync(p).size <= RAW_RUN_CAP);
  appendEvidence('big', { kind: 'command', cmd: 'b', exit: 0, output: 'z'.repeat(5000) });
  assert.ok(statSync(p).size <= RAW_RUN_CAP);
  assert.ok(!readFileSync(p).subarray(RAW_RUN_CAP - 300).toString().includes('zzzz'));
});

test('sweep removes sessions older than 7 days', () => {
  fresh();
  appendEvidence('old', cmd('a')); appendEvidence('new', cmd('b'));
  const old = Date.now() / 1000 - 8 * 86400;
  utimesSync(evidencePath('old'), old, old);
  writeFileSync(join(dataDir(), 'o.json'), '{}'); utimesSync(join(dataDir(), 'o.json'), old, old);
  assert.equal(sweepSessions(), 2);
  assert.ok(existsSync(evidencePath('new')) && !existsSync(evidencePath('old')));
});

test('load scopes by run tag', () => {
  fresh();
  appendEvidence('s', cmd('a', 0, { _run: 'r1' })); appendEvidence('s', cmd('b', 0, { _run: 'r2' })); appendEvidence('s', cmd('c'));
  assert.deepEqual(loadEvidence('s', 'r1').map((r) => r.cmd), ['a', 'c']);
});

test('selection keeps failures first', () => {
  const recs = [];
  for (let i = 0; i < 30; i++) recs.push(cmd('ls ' + i));
  recs.splice(5, 0, cmd('bad', 2)); recs.splice(10, 0, cmd('npm test', 0));
  const out = selectEvidence(recs);
  assert.equal(out.length, 20);
  assert.equal(out[0].cmd, 'bad');
  assert.ok(out.some((r) => r.cmd === 'npm test'));
  assert.deepEqual(selectEvidence([cmd('a'), cmd('b', 1)]).map((r) => r.cmd), ['b', 'a']);
});

test('merge: captured first, worker non-duplicates after', () => {
  const cap = [cmd('a'), cmd('b', 1)];
  const out = mergeEvidence(cap, [cmd('a'), { kind: 'note', text: 'x' }, cmd('c'), { kind: 'command' }]);
  assert.deepEqual(out.map((r) => r.cmd), ['b', 'a', 'c']);
});
