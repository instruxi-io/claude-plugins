// `node --test test/config.test.mjs`: the one config resolver, and every component
// agreeing on the server it names. A stub stands in for the server; a guard in each
// child records any attempt to reach api.instruxi.dev.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { resolveConfig, validateEnv, deriveUrls, VARS, ConfigError, DEFAULT_BASE_URL } from '../src/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const saved = { enforcer: { base_url: 'https://saved.example/' } };

test('precedence flag > env > saved > default', () => {
  const env = { ENFORCER_BASE_URL: 'https://env.example' };
  assert.deepEqual([resolveConfig({ flag: 'https://flag.example', env, saved }).baseUrl, resolveConfig({ flag: 'https://flag.example', env, saved }).source], ['https://flag.example', 'flag']);
  assert.equal(resolveConfig({ env, saved }).baseUrl, 'https://env.example');
  assert.equal(resolveConfig({ env, saved }).source, 'ENFORCER_BASE_URL');
  assert.equal(resolveConfig({ env: {}, saved }).baseUrl, 'https://saved.example');
  assert.equal(resolveConfig({ env: {}, saved: null }).baseUrl, DEFAULT_BASE_URL);
  assert.equal(resolveConfig({ env: {}, saved: null }).source, 'default');
});

test('one base derives the MCP, graph, files and governance URLs', () => {
  const c = resolveConfig({ env: { ENFORCER_BASE_URL: 'http://h:1/' }, saved: null });
  assert.equal(c.mcpUrl, 'http://h:1/mcp');
  assert.equal(c.graphUrl, 'http://h:1/api/v1/graph');
  assert.equal(c.filesUrl, 'http://h:1/api/v1/files');
  assert.equal(c.governanceUrl, 'http://h:1/api/v1/governance');
  assert.equal(deriveUrls('http://h:1', { GRAPH_BASE_URL: 'http://g/x/' }).graphUrl, 'http://g/x');
});

test('state dir and harness resolve from env, then defaults', () => {
  const c = resolveConfig({ env: { HOME: '/h', ENFORCER_HARNESS: 'codex' }, saved: null });
  assert.equal(c.harness, 'codex');
  assert.equal(c.stateDir, '/h/.config/enforcer/sessions/codex');
  assert.equal(resolveConfig({ env: { ENFORCER_STATE_DIR: '/s' }, saved: null }).stateDir, '/s');
});

test('bad GRAPH_HOOK_TIMEOUT is a named error, not a silent disable', () => {
  for (const bad of ['0', '-1', 'abc', 'NaN', '']) {
    const errs = validateEnv({ GRAPH_HOOK_TIMEOUT: bad });
    assert.equal(errs.length, 1, bad);
    assert.ok(errs[0] instanceof ConfigError);
    assert.equal(errs[0].variable, 'GRAPH_HOOK_TIMEOUT');
    assert.match(errs[0].message, /^GRAPH_HOOK_TIMEOUT: /);
    assert.throws(() => resolveConfig({ env: { GRAPH_HOOK_TIMEOUT: bad }, saved: null }), /GRAPH_HOOK_TIMEOUT/);
  }
  assert.equal(validateEnv({ GRAPH_HOOK_TIMEOUT: '2.5' }).length, 0);
  // the Python hooks name it too, on stderr, and keep the default
  const py = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, "lib/graph"); import lib; print(lib.HTTP_TIMEOUT)'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GRAPH_HOOK_TIMEOUT: 'abc' } });
  assert.match(py.stderr, /GRAPH_HOOK_TIMEOUT: must be a number/);
  assert.equal(py.stdout.trim(), '1.5');
});

test('every variable has a named check, a default, and a row in docs/CONFIG.md', () => {
  assert.equal(Object.keys(VARS).length, 22);
  const doc = readFileSync(join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
  for (const [name, spec] of Object.entries(VARS)) {
    assert.ok(doc.includes('`' + name + '`'), name + ' missing from docs/CONFIG.md');
    assert.equal(typeof spec.default, 'string');
  }
});

test('with ENFORCER_BASE_URL set no component contacts api.instruxi.dev', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const send = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url.includes('/auth/me')) return send({ data: { id: 'u1', email: 'a@b.c', role: { slug: 'member' }, tenant: { id: 't1', name: 'T' } } });
    if (req.url.includes('/heartbeat')) return send({ data: { state: 'ok' } });
    if (req.url.includes('/nodes')) return send({ data: [], meta: { total: 0 } });
    if (req.url.includes('/frontier')) return send({ data: [] });
    send({});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const tmp = mkdtempSync(join(tmpdir(), 'cfg-test-'));
  const log = join(tmp, 'noprod.log');
  writeFileSync(log, '');
  const home = join(tmp, 'home');
  mkdirSync(join(home, '.enforcer'), { recursive: true });
  // The saved sign-in points at production: the env var must still win.
  writeFileSync(join(home, '.enforcer', 'credentials.json'), JSON.stringify({ enforcer: { base_url: DEFAULT_BASE_URL, api_key: 'good' } }));
  const env = {
    ...process.env, HOME: home, ENFORCER_HOME: join(home, '.enforcer'), GOVERNOR_HOME: join(home, '.g'),
    ENFORCER_BASE_URL: base, ENFORCER_API_KEY: 'good', ENFORCER_STATE_DIR: join(tmp, 'state'),
    NOPROD_LOG: log, NODE_OPTIONS: `--import ${join(ROOT, 'test/fixtures/noprod/guard.mjs')}`,
    PYTHONPATH: join(ROOT, 'test/fixtures/noprod'),
  };
  delete env.GRAPH_BASE_URL; delete env.CLAUDE_PLUGIN_DATA;
  // Async: the stub lives in this process, so a blocking spawn would deadlock it.
  const run = (cmd, args, extra = {}) => new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: ROOT, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => stdout += d); c.stderr.on('data', (d) => stderr += d);
    const t = setTimeout(() => c.kill('SIGKILL'), 30_000);
    c.on('close', () => { clearTimeout(t); resolve({ stdout, stderr }); });
  });
  const mark = () => seen.length;
  const hit = (since) => seen.slice(since).length > 0;

  try {
  let m = mark();
  const st = await run('node', ['bin/login.mjs', 'status']);
  assert.match(st.stdout, new RegExp(`Signed in to ${base.replace(/[.]/g, '\\.')}`), st.stdout + st.stderr);
  assert.ok(hit(m), 'login status hit the stub');

  m = mark();
  const dr = await run('node', ['bin/enforcer', 'doctor']);
  assert.match(dr.stdout, new RegExp(`${base.replace(/[.]/g, '\\.')}/mcp answered`), dr.stdout + dr.stderr);
  assert.ok(hit(m), 'doctor hit the stub');

  m = mark();
  const hb = await run('python3', ['-c', `
import sys, json
sys.path.insert(0, "lib/graph")
import lib, heartbeat
lib.find_config = lambda cwd: {"base_url": ${JSON.stringify(base)}, "graph_id": "g1", "api_key": "good"}
run = {"graph_id": "g1", "node_id": "n1", "run_id": "r1", "key": "k"}
print(heartbeat.beat({}, run, "s", 10**9))
`]);
  assert.match(hb.stdout, /ok/, hb.stdout + hb.stderr);
  assert.ok(hit(m), 'hook heartbeat hit the stub');

  m = mark();
  const dp = await run('python3', ['bin/graph-dispatch', '--graph', 'g1', '--dry-run', '--exit-when-idle', '--no-lease', '--workers', '1', '--repo-root', tmp, '--state-dir', join(tmp, 'ds')], { GRAPH_API_KEY: 'good', GRAPH_AUTH_HELPER: '' });
  assert.ok(hit(m), 'dispatcher dry-run hit the stub: ' + dp.stdout + dp.stderr);
  assert.ok(seen.slice(m).every((l) => l.includes('/api/v1/graph/')), seen.slice(m).join('\n'));

  assert.equal(readFileSync(log, 'utf8'), '', 'nothing tried to reach production');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
