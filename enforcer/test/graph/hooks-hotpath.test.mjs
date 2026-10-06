import { realpathSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackRun } from '../../src/graph/hooks/track-run.mjs';
import { captureEvidence } from '../../src/graph/hooks/capture.mjs';
import { heartbeat } from '../../src/graph/hooks/heartbeat.mjs';
import { saveRun, loadRun } from '../../src/graph/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '../../bin/enforcer');
const NEXT = 'mcp__plugin_enforcer_enforcer__graph_next_work';
const REPORT = 'mcp__plugin_enforcer_enforcer__graph_report';
const claimResp = { state: 'claimed', graph_id: 'g1', node: { node_id: 'n1', key: 'k', title: 'T' }, run: { run_id: 'r1', lease_expires_at: '2026-01-01T00:05:00Z' }, acceptance_evidence: [{ criterion: 1, kind: 'check' }, 'junk'] };
const cleanEnv = (state, home) => {
  const e = { ...process.env, ENFORCER_STATE_DIR: state, HOME: home, ENFORCER_HOME: join(home, '.enforcer'), GRAPH_HEARTBEAT_MIN_GAP: '20' };
  for (const k of ['GRAPH_ID', 'GRAPH_BASE_URL', 'ENFORCER_BASE_URL', 'GRAPH_API_KEY', 'ENFORCER_API_KEY', 'CLAUDE_PLUGIN_DATA']) delete e[k];
  return e;
};

test('graph-live PostToolUse spawns no python3', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'nopy-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'python.log');
  writeFileSync(join(bin, 'python3'), `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`); chmodSync(join(bin, 'python3'), 0o755);
  const state = join(root, 'state');
  const env = { ...cleanEnv(state, root), PATH: `${bin}:${process.env.PATH}`, CLAUDE_PLUGIN_DATA: state };
  delete env.ENFORCER_STATE_DIR;
  const run = (ev) => spawnSync(process.execPath, [CLI, 'event', 'post-tool-use'], { input: JSON.stringify(ev), env, cwd: root, encoding: 'utf8' });
  let r = run({ hook_event_name: 'PostToolUse', session_id: 's9', tool_name: NEXT, tool_response: JSON.stringify(claimResp) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(state, 'runs', 's9.json')), 'run file written in process');
  r = run({ hook_event_name: 'PostToolUse', session_id: 's9', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: { stdout: 'hi' } });
  assert.equal(r.status, 0, r.stderr);
  const ev = readFileSync(join(state, 'evidence', 's9.jsonl'), 'utf8');
  assert.match(ev, /"cmd": "echo hi"/);
  r = run({ hook_event_name: 'PostToolUse', session_id: 's9', tool_name: REPORT, tool_response: '{}' });
  assert.equal(r.status, 0);
  assert.ok(!existsSync(log), 'python3 was never started');
  // garbage stdin: silent exit 0
  const g = spawnSync(process.execPath, [CLI, 'event', 'post-tool-use'], { input: 'garbage', env, cwd: root, encoding: 'utf8' });
  assert.equal(g.status, 0); assert.doesNotMatch(g.stdout, /systemMessage|additionalContext/); assert.equal(g.stderr, '');
});

const withServer = async (status, body, fn) => {
  const seen = [];
  const srv = createServer((req, res) => { seen.push(req.url); res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`, seen); } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
};
const liveRun = (sid) => saveRun(sid, { graph_id: 'g1', node_id: 'n1', run_id: 'r1', key: 'k', claimed_at: '2020-01-01T00:00:00.000Z', lease_expires_at: '2020-01-01T00:05:00.000Z' });
const withEnv = async (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
};

test('reclaimed on 409', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'hb-'));
  await withServer(409, { error: 'x' }, async (base, seen) => {
    await withEnv({ ENFORCER_STATE_DIR: join(root, 's'), HOME: root, GRAPH_ID: 'g1', ENFORCER_BASE_URL: base, GRAPH_API_KEY: 'k', ENFORCER_API_KEY: 'k', GRAPH_HEARTBEAT_MIN_GAP: '0' }, async () => {
      liveRun('s2');
      const out = await heartbeat({ session_id: 's2', tool_name: 'Bash', cwd: root, tool_input: {}, tool_response: {} });
      assert.match(out.systemMessage, /lease on node k lapsed/);
      assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
      assert.equal(loadRun('s2').reclaimed, true);
      assert.deepEqual(seen, ['/api/v1/graph/graphs/g1/nodes/n1/runs/r1/heartbeat']);
      assert.equal(await heartbeat({ session_id: 's2', tool_name: 'Bash', cwd: root }), null); // reclaimed: silent from now on
    });
  });
});

test('fail-open on 401, silent on ok, lease/3 gate', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'hb-'));
  const env = (base) => ({ ENFORCER_STATE_DIR: join(root, 's'), HOME: root, GRAPH_ID: 'g1', ENFORCER_BASE_URL: base, GRAPH_API_KEY: 'k', ENFORCER_API_KEY: 'k', GRAPH_HEARTBEAT_MIN_GAP: '20' });
  await withServer(401, {}, async (base) => withEnv(env(base), async () => {
    liveRun('s3');
    const first = await heartbeat({ session_id: 's3', tool_name: 'Bash', cwd: root });
    assert.match(first.systemMessage, /\/enforcer:login/); // a 401 is announced once per session (src/errors.mjs)
    assert.ok(!loadRun('s3').reclaimed);
  }));
  await withServer(200, { success: true, data: { state: 'ok', lease_expires_at: '2099-01-01T00:00:00Z' } }, async (base, seen) => withEnv(env(base), async () => {
    liveRun('s4');
    assert.equal(await heartbeat({ session_id: 's4', tool_name: 'Bash', cwd: root }), null);
    assert.equal(loadRun('s4').lease_expires_at, '2099-01-01T00:00:00Z');
    assert.equal(seen.length, 1);
    assert.equal(await heartbeat({ session_id: 's4', tool_name: 'Bash', cwd: root }), null); // within the 20 s gap
    assert.equal(seen.length, 1);
  }));
});
