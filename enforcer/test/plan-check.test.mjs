// `node test/plan-check.test.mjs`: `enforcer plan check` against a stub graph server. No network.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'plan-check-test-'));
mkdirSync(join(tmp, 'apps', 'r1'), { recursive: true });
let pass = 0, fail = 0;
const t = async (label, fn) => { try { await fn(); pass++; console.log('ok  ' + label); } catch (e) { fail++; console.log('FAIL  ' + label + '\n  ' + e.message); } };

const say = `node -e "console.log('3 passed, 0 failed')"`;
const nodes = (acc) => [
  { key: 'fx', status: 'ready', data: { repo: 'r1', acceptance: acc } },
  { key: 'old', status: 'done', data: { repo: 'r1', acceptance: [`${say} prints 'never'`] } },
];
let acceptance = [];
const srv = http.createServer((req, res) => {
  const send = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (req.headers['x-api-key'] !== 'good') return send(401, {});
  if (req.url.startsWith('/graphs/g1/nodes')) { const d = nodes(acceptance); return send(200, { data: d, meta: { total: d.length } }); }
  send(404, {});
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const run = () => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(ROOT, 'bin/enforcer'), 'plan', 'check', 'g1', '--repo-root', join(tmp, 'apps')],
    { env: { ...process.env, GRAPH_BASE_URL: `http://127.0.0.1:${srv.address().port}`, GRAPH_API_KEY: 'good' } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});

await t("'prints all passed' vs real '3 passed, 0 failed' is a MISMATCH, exit 1", async () => {
  acceptance = [`${say} prints 'all passed'`];
  const r = await run();
  assert.equal(r.code, 1);
  assert.match(r.out, /^MISMATCH fx:.*last line: 3 passed, 0 failed/m);
});
await t('matching literal is ok, placeholder is SKIPPED, one line each, exit 0', async () => {
  acceptance = [`${say} prints \`0 failed\``, '`gh pr view <n> --json state` prints `"state":"MERGED"`', `${say} exits 0`];
  const r = await run();
  assert.equal(r.code, 0, r.out);
  const ls = r.out.trim().split('\n');
  assert.equal(ls.length, 3);
  assert.match(ls[0], /^ok fx:/); assert.match(ls[1], /^SKIPPED fx:/); assert.match(ls[2], /^ok fx:/);
});
await t('exit code mismatch is a MISMATCH', async () => {
  acceptance = ['bash -c "exit 3" exits 0'];
  const r = await run();
  assert.equal(r.code, 1); assert.match(r.out, /exit 3, expected 0/);
});
srv.close(); rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
