// `npm test`: run every suite in its own process, report every suite's result (a failure never masks the
// ones after it), and write JUnit XML to test-results/junit.xml for CI.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = (file, ...rest) => ({ cmd: process.execPath, args: ['--import', './test/tmp-cleanup.mjs', file, ...rest] });
const nodeTest = (...files) => ({ cmd: process.execPath, args: ['--test', ...files] });
const isolatedPy = (...args) => ({ cmd: 'bash', args: ['test/isolated.sh', 'python3', ...args] });

// every top-level test/*.test.mjs runs under the isolating preload, discovered so a new suite never needs a list edit
const top = readdirSync(join(ROOT, 'test')).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => [n.replace('.test.mjs', ''), node(`test/${n}`)]);
const SUITES = [
  ...top,
  ['tsc (generated API types)', { cmd: join(ROOT, 'node_modules/.bin/tsc'), args: ['--noEmit', '-p', 'lib/api/tsconfig.json'] }],
  ['dispatch/injection', node('test/dispatch/injection.test.mjs')],
  ['contract', node('test/contract/contract.test.mjs')],
  ['dispatch/pure', nodeTest('test/dispatch/pure.test.mjs')],
  ['dispatch/env', nodeTest('test/dispatch/env.test.mjs')],
  ['governor', { cmd: 'npm', args: ['test'], cwd: join(ROOT, 'lib/governor') }],
  ['graph (hooks, evidence, session, run.test against the stub graph)', nodeTest('test/graph/*.test.mjs')],
  ['dispatch/runtime', nodeTest('test/dispatch/runtime.test.mjs')],
  ['dispatch/logs', nodeTest('test/dispatch/logs.test.mjs')],
  ['dispatch/status', nodeTest('test/dispatch/status.test.mjs')],
  ['dispatch/salvage', nodeTest('test/dispatch/salvage.test.mjs')],
  ['python test/', isolatedPy('-m', 'unittest', 'discover', 'test')],
  ['python lib/graph', isolatedPy('-m', 'unittest', 'discover', '-s', 'lib/graph', '-p', 'test_*.py')],
];

// Per-platform profile: on Windows only hooks and CLIs run; the dispatcher, governor and python suites are skipped with a reason.
const WIN_SKIP = /^(dispatch\/|governor|python |graph \()/;
const skipReason = (name) => (process.platform === 'win32' && WIN_SKIP.test(name) ? 'dispatcher/governor/python suites are not supported on Windows (hooks and CLIs only)' : null);
// test/quarantine.json: [{suite, owner, expires: YYYY-MM-DD, reason, os?}]. A quarantined suite still runs; its failure is
// reported as skipped, not red, until the expiry date, after which it fails the run again. An optional `os` list
// (process.platform values: darwin, win32, linux) scopes the entry, so a suite red only on macOS stays a gate on Linux.
const QFILE = join(ROOT, '..', 'test', 'quarantine.json');
const quarantine = existsSync(QFILE) ? JSON.parse(readFileSync(QFILE, 'utf8')) : [];
const quarantined = (name) =>
  quarantine.find((q) => name.includes(q.suite) && (!q.os || q.os.includes(process.platform)) && q.expires >= new Date().toISOString().slice(0, 10));

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const results = [];
for (const [name, { cmd, args, cwd }] of SUITES) {
  if (only && !only.test(name)) continue;
  const skip = skipReason(name);
  if (skip) { process.stdout.write(`skip  ${name} (${skip})\n`); results.push({ name, ok: true, skipped: skip, seconds: 0, out: '', status: 0 }); continue; }
  const t = Date.now();
  // glob arguments for node --test are expanded by node itself (>= 21); older nodes get the shell's expansion
  const r = spawnSync(cmd, args, { cwd: cwd || ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: args.some((a) => /\*/.test(a)) && process.versions.node.split('.')[0] < 21 });
  const out = (r.stdout || '') + (r.stderr || '') + (r.error ? `\n${r.error.message}` : '');
  const q = r.status === 0 ? null : quarantined(name);
  const ok = r.status === 0 || !!q;
  process.stdout.write(`${r.status === 0 ? 'ok  ' : q ? 'quar' : 'FAIL'}  ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)\n`);
  if (!ok) process.stdout.write(out.split('\n').slice(-60).join('\n') + '\n');
  results.push({ name, ok, quarantined: q && `quarantined until ${q.expires}, owner ${q.owner}`, seconds: (Date.now() - t) / 1000, out, status: r.status });
}

const failed = results.filter((r) => !r.ok);
const expired = quarantine.filter((q) => q.expires < new Date().toISOString().slice(0, 10));
if (expired.length) { console.log(`expired quarantine entries: ${expired.map((q) => q.suite).join(', ')}`); failed.push(...expired.map((q) => ({ name: `quarantine expired: ${q.suite}` }))); }
mkdirSync(join(ROOT, 'test-results'), { recursive: true });
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="enforcer" tests="${results.length}" failures="${failed.length}" time="${results.reduce((a, r) => a + r.seconds, 0).toFixed(3)}">
${results.map((r) => `  <testsuite name="${esc(r.name)}" tests="1" failures="${r.ok ? 0 : 1}" skipped="${r.skipped || r.quarantined ? 1 : 0}" time="${r.seconds.toFixed(3)}">
    <testcase classname="enforcer" name="${esc(r.name)}" time="${r.seconds.toFixed(3)}">${r.skipped ? `
      <skipped message="${esc(r.skipped)}"/>` : r.quarantined ? `
      <skipped message="${esc(r.quarantined)}"/>` : r.ok ? '' : `
      <failure message="exit ${r.status}">${esc(r.out.split('\n').slice(-80).join('\n'))}</failure>`}
    </testcase>
  </testsuite>`).join('\n')}
</testsuites>
`;
writeFileSync(join(ROOT, 'test-results', 'junit.xml'), xml);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) console.log(`failed: ${failed.map((r) => r.name).join(', ')}`);
process.exit(failed.length ? 1 : 0);
