// `node --test test/dispatch-secret-hygiene.test.mjs`: the agent key does not linger on disk, in logs or in a worker's environment.
// Temp dirs only: no claude, no gh, no network, no real HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher, defaultArgs } from '../src/dispatch/run.mjs';
import { workerEnv, mintWorkerToken } from '../src/dispatch/launch.mjs';
import { redactFile } from '../src/dispatch/logs.mjs';

const KEY = 'ag_TESTKEY0123456789';
const WIN = process.platform === 'win32';
const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-'));
const startup = async (state, o = {}) => {
  const args = defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), agentKey: KEY, ...o });
  const d = new Dispatcher({}, args, () => {});
  d._run = async () => 0;
  await d.run();
  return d;
};

test('startup removes stale mcp config files', async () => {
  const state = tmp();
  writeFileSync(join(state, 'mcp-some-node.json'), JSON.stringify({ headers: { 'X-API-Key': KEY } }));
  writeFileSync(join(state, 'keep.txt'), 'x');
  await startup(state);
  assert.ok(!existsSync(join(state, 'mcp-some-node.json')));
  assert.ok(existsSync(join(state, 'keep.txt')));
});

test('startup redacts existing worker logs', async () => {
  const state = tmp();
  mkdirSync(join(state, 'logs'), { recursive: true });
  const p = join(state, 'logs', 'node.1.jsonl');
  writeFileSync(p, `{"text":"key is ${KEY} here"}\n`);
  await startup(state);
  assert.ok(!readFileSync(p, 'utf8').includes(KEY));
});

test('a bare agent token in a log is redacted', () => {
  const dir = tmp();
  const p = join(dir, 'a.jsonl');
  writeFileSync(p, `ag_ABCDEFGH12345678\nenv3_ZZZZZZZZ99999999\nplain\n`);
  assert.ok(redactFile(p, []) >= 2);
  const t = readFileSync(p, 'utf8');
  assert.ok(!t.includes('ag_ABCDEFGH') && !t.includes('env3_ZZZZ'));
  assert.match(t, /plain/);
});

test('the state dir is 0700 and pids.json is 0600', { skip: WIN }, async () => {
  const state = join(tmp(), 'st');
  mkdirSync(state, { mode: 0o775 });
  const args = defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), agentKey: KEY });
  const d = new Dispatcher({}, args, () => {});
  d._run = async () => 0;
  await d.run();
  assert.equal(statSync(state).mode & 0o777, 0o700);
  d.writePids();
  assert.equal(statSync(join(state, 'pids.json')).mode & 0o777, 0o600);
});

test('workers get the minted token and not the agent key', async () => {
  const api = { call: async () => ({ data: { secret: 'env3_MINTEDTOKEN0001' } }) };
  const env = { ENFORCER_WORKER_AGENT_ID: 'agent-1', ENFORCER_AGENT_KEY: KEY, ENFORCER_API_KEY: KEY, PATH: '/bin' };
  const token = await mintWorkerToken(api, env);
  assert.equal(token, 'env3_MINTEDTOKEN0001');
  const w = workerEnv('g', env, { token });
  assert.equal(w.GRAPH_API_KEY, token);
  assert.equal(w.ENFORCER_API_KEY, token);
  assert.ok(!Object.values(w).includes(KEY));
  assert.equal(await mintWorkerToken(api, { PATH: '/bin' }), null);
});

test('only named CLAUDE variables reach a worker', () => {
  const w = workerEnv('g', { CLAUDE_SECRET_THING: 'x', CLAUDE_CONFIG_DIR: '/c', LC_SNEAKY: 'y', LC_ALL: 'C', PATH: '/bin' });
  assert.ok(!('CLAUDE_SECRET_THING' in w) && !('LC_SNEAKY' in w));
  assert.equal(w.CLAUDE_CONFIG_DIR, '/c');
  assert.equal(w.LC_ALL, 'C');
});
