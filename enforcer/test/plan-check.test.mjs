// `node test/plan-check.test.mjs`: `enforcer plan check` against a stub graph server. No network.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { test, after } from 'node:test';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'plan-check-test-'));
mkdirSync(join(tmp, 'apps', 'r1'), { recursive: true });
const t = test;
const tmpRoot = join(tmp, 'tmpdir');
mkdirSync(tmpRoot);

const say = `node -e "console.log('3 passed, 0 failed')"`;
const nodes = (acc) => [
  { key: 'fx', status: 'ready', data: { repo: 'r1', acceptance: acc } },
  { key: 'other', status: 'ready', data: { repo: 'r1', acceptance: [`${say} prints 'zzz'`] } },
  { key: 'old', status: 'done', data: { repo: 'r1', acceptance: [`${say} prints 'never'`] } },
];
let acceptance = [];
let lintWarnings = [];
const srv = http.createServer((req, res) => {
  const send = (c, b) => {
    res.writeHead(c, { 'content-type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  if (req.headers['x-api-key'] !== 'good') return send(401, {});
  if (req.url.startsWith('/graphs/g1/nodes')) {
    const d = nodes(acceptance);
    return send(200, { data: d, meta: { total: d.length } });
  }
  if (req.method === 'POST' && req.url === '/graphs/g1/acceptance/lint') return send(200, { success: true, warnings: lintWarnings });
  send(404, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const run = (extra = [], { onFirst } = {}) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, 'bin/enforcer'), 'plan', 'check', 'g1', '--repo-root', join(tmp, 'apps'), ...extra], {
      env: { ...process.env, TMPDIR: tmpRoot, GRAPH_BASE_URL: `http://127.0.0.1:${srv.address().port}`, GRAPH_API_KEY: 'good' },
    });
    let out = '',
      stdout = '',
      first = null,
      err = '';
    p.stdout.on('data', (d) => {
      if (first === null) {
        first = Date.now();
        onFirst?.();
      }
      out += d;
      stdout += d;
    });
    p.stderr.on('data', (d) => {
      out += d;
      err += d;
    });
    p.on('close', (code) => resolve({ code, out, stdout, err, first, closed: Date.now() }));
  });
const only = ['--only', 'fx'];

await t("'prints all passed' vs real '3 passed, 0 failed' is a MISMATCH, exit 1", async () => {
  acceptance = [`${say} prints 'all passed'`];
  const r = await run(only);
  assert.equal(r.code, 1);
  assert.match(r.out, /^MISMATCH fx:.*last line: 3 passed, 0 failed/m);
});
await t('matching literal is ok, placeholder is SKIPPED, one line each, exit 0', async () => {
  acceptance = [`${say} prints \`0 failed\``, '`gh pr view <n> --json state` prints `"state":"MERGED"`', `${say} exits 0`];
  const r = await run(only);
  assert.equal(r.code, 0, r.out);
  const ls = r.stdout.trim().split('\n');
  assert.equal(ls.length, 3);
  assert.match(ls[0], /^ok fx:/);
  assert.match(ls[1], /^SKIPPED fx:/);
  assert.match(ls[2], /^ok fx:/);
});
await t('exit code mismatch is a MISMATCH', async () => {
  acceptance = ['bash -c "exit 3" exits 0'];
  const r = await run(only);
  assert.equal(r.code, 1);
  assert.match(r.out, /exit 3, expected 0/);
});
await t('server warnings are merged into the report', async () => {
  acceptance = [`${say} prints \`0 failed\``, 'it works'];
  lintWarnings = [{ index: 1, code: 'vague_phrase', hint: 'name a command', line: 'it works' }];
  const r = await run(only);
  lintWarnings = [];
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ok fx:/m);
  assert.match(r.out, /^WARN fx: \[vague_phrase\] name a command/m);
});
await t('results stream before the run ends', async () => {
  acceptance = [`${say} prints \`0 failed\``, `node -e "setTimeout(function(){console.log('late')},2500)" prints \`late\``];
  const started = Date.now();
  const r = await run(only);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.first - started < r.closed - started - 1500, `first line at ${r.first - started} ms, process ended at ${r.closed - started} ms`);
  assert.match(r.err, /\[1\/2\]/);
  assert.match(r.err, /\[2\/2\]/);
});
await t('read-only temp files are removed and the report is still printed', async () => {
  writeFileSync(
    join(tmp, 'apps', 'r1', 'mk.mjs'),
    `import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
const d = join(process.env.TMPDIR, 'go', 'pkg'); // what Go's module cache looks like: 0444 files in a 0555 directory
mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'f'), 'x'); chmodSync(join(d, 'f'), 0o444); chmodSync(d, 0o555);
console.log('made');`,
  );
  acceptance = ['node mk.mjs prints `made`', `${say} prints \`0 failed\``];
  const r = await run(only);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ok fx:.*made/m);
  assert.match(r.out, /^ok fx:.*0 failed/m);
  assert.deepEqual(
    readdirSync(tmpRoot).filter((n) => n.startsWith('plan-check-')),
    [],
    'no plan-check-* tree left behind',
  );
});
await t('--only filters to one node', async () => {
  acceptance = [`${say} prints \`0 failed\``];
  const all = await run();
  assert.match(all.out, /fx:/);
  assert.match(all.out, /other:/);
  const one = await run(['--only', 'other']);
  assert.match(one.out, /^MISMATCH other:/m);
  assert.doesNotMatch(one.out, /fx:/);
  assert.equal(one.code, 1);
});
await t('a command past --timeout is SKIPPED, not a MISMATCH, and the exit code stays 0', async () => {
  acceptance = [`node -e "setTimeout(function(){},5000)" prints \`never\``];
  const r = await run([...only, '--timeout', '1']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^SKIPPED fx:.*timed out after 1s/m);
});
after(() => {
  srv.close();
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows can hold the cwd of a just-exited child */
  }
});
