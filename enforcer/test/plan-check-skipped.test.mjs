// `enforcer plan check` flags the lines the judge will get no evidence for. Fixture nodes on a stub server, no network.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test, after } from 'node:test';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'plan-check-skipped-'));
mkdirSync(join(tmp, 'apps', 'r1'), { recursive: true });
writeFileSync(join(tmp, 'apps', 'r1', 'say.mjs'), "console.log('3 passed, 0 failed');\n");
let acceptance = [];
const srv = http.createServer((req, res) => {
  const send = (c, b) => {
    res.writeHead(c, { 'content-type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  if (req.headers['x-api-key'] !== 'good') return send(401, {});
  if (req.url.startsWith('/graphs/g1/nodes')) {
    const d = [{ key: 'fx', status: 'ready', data: { repo: 'r1', acceptance } }];
    return send(200, { data: d, meta: { total: 1 } });
  }
  if (req.method === 'POST' && req.url === '/graphs/g1/acceptance/lint') return send(200, { success: true, warnings: [] });
  send(404, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const run = (extra = []) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, 'bin/enforcer'), 'plan', 'check', 'g1', '--repo-root', join(tmp, 'apps'), ...extra], {
      env: { ...process.env, GRAPH_BASE_URL: `http://127.0.0.1:${srv.address().port}`, GRAPH_API_KEY: 'good' },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

const WARN = (out, i) => out.split('\n').find((l) => l.startsWith(`WARN fx: line ${i} will not be run`)) ?? '';

test('a skipped line gets a specific hint', async () => {
  acceptance = [
    "node say.mjs prints '3 passed'",
    "curl http://x prints 'a'",
    "gh pr view <foo> prints 'a'",
    'node say.mjs',
    'node say.mjs prints all tests passed',
  ];
  const r = await run();
  assert.match(WARN(r.out, 1), /\(not run: not an allowed command shape \(curl\)\); the judge will see only the worker's own output\. Allowed shapes:/);
  assert.match(WARN(r.out, 2), /Supported placeholders: <graph>/);
  assert.match(WARN(r.out, 3), /prints .*<literal line of real output>.* or .*exits 0/);
  assert.match(WARN(r.out, 4), /literal line of real output/);
  assert.equal(WARN(r.out, 0), '');
});

test('a near miss names the closest allowed shape', async () => {
  acceptance = ['npm run build prints `ok`'];
  const r = await run();
  assert.match(WARN(r.out, 0), /Closest allowed shape: npm \[--prefix <dir>\] test/);
});

test('the summary line counts runnable skipped and mismatch lines', async () => {
  acceptance = ["node say.mjs prints '3 passed'", "node say.mjs prints 'nope'", "curl x prints 'a'", 'node say.mjs prints all good'];
  const r = await run();
  assert.match(r.out, /^plan check: 1 runnable, 2 will not be run, 1 mismatch$/m);
});

test('strict exits 1 when a line is skipped', async () => {
  acceptance = ["node say.mjs prints '3 passed'", "curl x prints 'a'"];
  assert.equal((await run(['--strict'])).code, 1);
});

test('default exit codes are unchanged', async () => {
  acceptance = ["node say.mjs prints '3 passed'", "curl x prints 'a'"];
  assert.equal((await run()).code, 0);
  acceptance = ["node say.mjs prints 'nope'"];
  assert.equal((await run()).code, 1);
  acceptance = ["node say.mjs prints '3 passed'"];
  assert.equal((await run(['--strict'])).code, 0);
});

after(() => {
  srv.close();
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows can hold the cwd of a just-exited child */
  }
});
