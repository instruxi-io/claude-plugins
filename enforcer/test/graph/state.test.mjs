import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateBase, dataDir, evidenceDir, tightenState, actorKey, privateWrite } from '../../src/graph/state.mjs';
import { loadRun, saveRun, runPath } from '../../src/graph/run.mjs';
import { http, httpStatus } from '../../src/graph/http.mjs';
import { legacyStateDir } from '../../hooks/claude/paths.mjs';

const mode = (p) => statSync(p).mode & 0o777;
const KEYS = ['HOME', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_CONFIG_DIR', 'ENFORCER_STATE_DIR', 'ENFORCER_CONFIG_HOME'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const restore = () => { for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); };
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'gstate-'));
  restore();
  process.env.HOME = join(root, 'home'); mkdirSync(process.env.HOME);
  for (const k of KEYS.slice(1)) delete process.env[k];
  return root;
};

test('state dir 0700 and files 0600', () => {
  const root = fresh();
  process.env.ENFORCER_STATE_DIR = join(root, 'state');
  const old = process.umask(0o022);
  try {
    saveRun('s1', { a: 1 });
    const ev = join(evidenceDir(), 's1.jsonl');
    privateWrite(ev, '{"kind":"note"}\n', 'a');
    assert.equal(mode(evidenceDir()), 0o700);
    assert.equal(mode(ev), 0o600);
    assert.equal(mode(dataDir()), 0o700);
    assert.equal(mode(runPath('s1')), 0o600);
    assert.deepEqual(loadRun('s1'), { a: 1 });
    assert.equal(loadRun('nope'), null);
    // tighten existing
    const d = join(root, 'state', 'evidence'); chmodSync(d, 0o775); chmodSync(ev, 0o644);
    tightenState();
    assert.equal(mode(d), 0o700); assert.equal(mode(ev), 0o600);
  } finally { process.umask(old); restore(); }
});

test('legacy runs migrate when CLAUDE_PLUGIN_DATA is set, and honour CLAUDE_CONFIG_DIR', () => {
  const root = fresh();
  mkdirSync(join(legacyStateDir(), 'runs'), { recursive: true });
  writeFileSync(join(legacyStateDir(), 'runs', 's1.json'), '{"run_id":"r1"}');
  const data = join(root, 'plugin-data');
  process.env.CLAUDE_PLUGIN_DATA = data;
  assert.equal(stateBase(), data);
  assert.equal(JSON.parse(readFileSync(join(data, 'runs', 's1.json'), 'utf8')).run_id, 'r1');
  process.env.CLAUDE_CONFIG_DIR = join(root, 'cc');
  assert.equal(legacyStateDir(), join(root, 'cc', 'enforcer-graph'));
  restore();
});

test('actor key: sha256 of agent_id:<id> for a subagent, else the session id', () => {
  const sha = (x) => createHash('sha256').update(`agent_id:${x}`).digest('hex').slice(0, 32);
  assert.equal(actorKey({ agent_id: 'agent-123' }), sha('agent-123'));
  assert.equal(actorKey({ agent_id: 'x', session_id: 's' }), sha('x'));
  assert.equal(actorKey({ session_id: 'sess-9' }), 'sess-9');
  assert.equal(actorKey({}), 'unknown');
  assert.equal(actorKey(null), 'unknown');
});

test('http returns null / status 0 without credentials or on failure, never throws', async () => {
  const root = fresh();
  process.env.ENFORCER_HOME = join(root, 'none');
  const k = process.env.ENFORCER_API_KEY; delete process.env.ENFORCER_API_KEY;
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('down'); };
    const cfg = { base_url: 'http://127.0.0.1:1' };
    assert.equal(await http(cfg, 'GET', '/x', null, { retries: 0 }), null);
    assert.deepEqual(await httpStatus(cfg, 'GET', '/x', null, { retries: 0 }), [0, null]);
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, v: 1 }), { status: 200 });
    process.env.ENFORCER_API_KEY = 'k';
    assert.deepEqual(await http(cfg, 'GET', '/x'), { success: true, v: 1 });
    globalThis.fetch = async () => new Response('{}', { status: 404 });
    assert.deepEqual(await httpStatus(cfg, 'GET', '/x'), [404, null]);
  } finally {
    globalThis.fetch = orig; delete process.env.ENFORCER_HOME;
    if (k === undefined) delete process.env.ENFORCER_API_KEY; else process.env.ENFORCER_API_KEY = k;
    restore();
  }
});
