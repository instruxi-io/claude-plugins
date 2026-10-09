// `node --test test/evidence-run.test.mjs`: the acceptance-line rules in src/evidence-run.mjs and the
// `enforcer evidence run` command against a stub graph server. No network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvidence, prepareLine, goTestFlags, clipEvidence } from '../src/evidence-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'evidence-run-test-'));
mkdirSync(join(tmp, 'sub', 'dir'), { recursive: true });
writeFileSync(join(tmp, 'echo.mjs'), "console.log(process.argv.slice(2).join(' '));\n");
writeFileSync(join(tmp, 'sub', 'dir', 'seven.mjs'), 'console.log(7);\n');
after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows can hold the cwd of a just-exited child */
  }
});
const node = (acceptance) => ({ key: 'fx', node_id: 'n-1', data: { acceptance } });
const fakeRun =
  (log, result = { status: 0, stdout: 'ok\n', stderr: '' }) =>
  (cmd, args, opts) => {
    log.push({ cmd, args, opts });
    return result;
  };

test('go test lines get -run -v', () => {
  const line = 'go test ./internal/db prints `--- PASS: TestMigrate`';
  const p = prepareLine(line, { cwd: tmp, graph: 'g' });
  assert.equal(p.cmd, "go test -tags integration -v -run '^(TestMigrate)$' ./internal/db");
  // already complete: left alone
  const full = 'go test -tags integration -run TestA -v ./x';
  assert.equal(goTestFlags(full, ['--- PASS: TestA']), full);
  // no PASS literal: nothing to add
  assert.equal(goTestFlags('go test ./x', ['ok']), 'go test ./x');
  // two names become one alternation
  assert.match(goTestFlags('go test ./x', ['--- PASS: TestA', '--- PASS: TestB']), /-run '\^\(TestA\|TestB\)\$'/);
  // and it is what actually runs
  const log = [];
  const r = runEvidence(node([line]), { cwd: tmp, run: fakeRun(log, { status: 0, stdout: '--- PASS: TestMigrate (0.01s)\n', stderr: '' }) });
  assert.equal(log[0].cmd, 'go');
  assert.deepEqual(log[0].args, ['test', '-tags', 'integration', '-v', '-run', '^(TestMigrate)$', './internal/db']);
  assert.equal(log[0].opts.shell, false);
  assert.equal(r.found, 1);
  assert.equal(r.total, 1);
});

test('placeholders are substituted', () => {
  const log = [];
  const r = runEvidence(node(['node echo.mjs <graph> prints `g-123`', 'node echo.mjs <test db> prints `postgres://t`', 'node echo.mjs <n> prints `x`']), {
    cwd: tmp,
    graph: 'g-123',
    testDb: '',
    run: fakeRun(log),
  });
  assert.deepEqual(log[0].args, ['echo.mjs', 'g-123']);
  assert.deepEqual(
    r.skipped.map((s) => [s.line_index, s.reason]),
    [
      [1, 'no value for <test db>'],
      [2, 'placeholder <n>'],
    ],
  );
  const withDb = prepareLine('node echo.mjs <test db> prints `x`', { cwd: tmp, graph: 'g', testDb: 'postgres://t' });
  assert.deepEqual(withDb.argv, ['node', 'echo.mjs', 'postgres://t']);
});

test('cd is never allowed; a path argument names the directory instead', () => {
  const log = [];
  const r = runEvidence(node(['cd sub/dir && ls prints `x`']), { cwd: tmp, run: fakeRun(log) });
  assert.equal(log.length, 0);
  assert.match(r.skipped[0].reason, /not run: not an allowed command shape/);
  // for real: the command lists that directory
  writeFileSync(join(tmp, 'sub', 'dir', 'marker.txt'), 'm');
  const ok = runEvidence(node(['ls sub/dir prints `marker.txt`']), { cwd: tmp });
  assert.equal(ok.found, 1);
  assert.match(ok.items[0].output, /marker\.txt/);
});

test('the PR line is skipped', () => {
  const log = [];
  const r = runEvidence(node(['`gh pr view 12 -R o/r --json state` prints `"state":"MERGED"`', 'git log -1 prints `abc`', 'ls prints `x`']), {
    cwd: tmp,
    run: fakeRun(log),
  });
  assert.equal(log.length, 1);
  assert.deepEqual(
    r.skipped.map((s) => s.line_index),
    [0, 1],
  );
  assert.match(r.skipped[0].reason, /PR line/);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].line_index, 2);
});

test('a colliding suite is retried once', () => {
  writeFileSync(
    join(tmp, 'flaky.mjs'),
    `import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('seen')) { writeFileSync('seen', '1'); console.error('listen tcp :5432: bind: address already in use'); process.exit(1); }
console.log('second run passed');`,
  );
  const r = runEvidence(node(['node flaky.mjs prints `second run passed`']), { cwd: tmp, retryDelayMs: 0 });
  assert.deepEqual(r.retried, [0]);
  assert.equal(r.items[0].exit, 0);
  assert.equal(r.found, 1);
  // a plain failure is not retried; a collision that persists is retried only once
  const log = [];
  runEvidence(node(['node flaky.mjs prints `a`']), { cwd: tmp, retryDelayMs: 0, run: fakeRun(log, { status: 1, stdout: 'database is locked', stderr: '' }) });
  assert.equal(log.length, 2);
  const log2 = [];
  runEvidence(node(['node flaky.mjs prints `a`']), { cwd: tmp, retryDelayMs: 0, run: fakeRun(log2, { status: 1, stdout: 'assertion failed', stderr: '' }) });
  assert.equal(log2.length, 1);
});

test('the quoted literal survives the clip', () => {
  const big = 'A'.repeat(2000) + '\nthe 126 passed, 0 failed line\n' + 'B'.repeat(2000);
  assert.ok(clipEvidence(big, ['126 passed']).includes('126 passed'));
  assert.ok(clipEvidence(big, ['126 passed']).length < 3500);
});

test('enforcer evidence run prints one JSON item per command and the literals summary', async () => {
  const srv = http.createServer((req, res) => {
    const send = (c, b) => {
      res.writeHead(c, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (req.headers['x-api-key'] !== 'good') return send(401, {});
    if (req.url.startsWith('/graphs/g1/nodes')) {
      const d = [node(['ls prints `marker.txt`', 'node seven.mjs prints `never-there`', '`gh pr view 1` prints `MERGED`'])];
      return send(200, { data: d, meta: { total: 1 } });
    }
    send(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [join(ROOT, 'bin/enforcer'), 'evidence', 'run', ...args], {
        env: { ...process.env, GRAPH_BASE_URL: `http://127.0.0.1:${srv.address().port}`, GRAPH_API_KEY: 'good' },
      });
      let stdout = '',
        stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  try {
    writeFileSync(join(tmp, 'sub', 'dir', 'marker.txt'), 'm');
    const r = await run(['g1:fx', '--cwd', join(tmp, 'sub', 'dir')]);
    const lines = r.stdout.trim().split('\n');
    const items = lines.slice(0, -1).map((l) => JSON.parse(l));
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((i) => [i.kind, i.exit, i.line_index]),
      [
        ['command', 0, 0],
        ['command', 0, 1],
      ],
    );
    assert.equal(lines.at(-1), 'literals found: 1/2');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SKIPPED line 2: PR line/);
    const only = await run(['--graph', 'g1', 'fx', '--cwd', join(tmp, 'sub', 'dir'), '--only', '0']);
    assert.equal(only.code, 0);
    assert.equal(only.stdout.trim().split('\n').at(-1), 'literals found: 1/1');
    const missing = await run(['g1:nope']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no node nope/);
  } finally {
    srv.close();
  }
});

test('a line that calls evidence run is skipped, never recursed into', () => {
  const r = runEvidence(node(['node bin/enforcer evidence run <graph>:<node-key> --cwd . prints `literals found`']), {
    cwd: tmp,
    graph: 'g',
    run: () => assert.fail('must not run'),
  });
  assert.deepEqual(
    r.skipped.map((s) => s.reason),
    ['would run itself'],
  );
});
