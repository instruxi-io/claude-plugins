// The heartbeat ticker: a Bash call that outlasts lease/3 keeps the lease alive while it runs.
import { realpathSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { startTicker, stopTicker, tickLoop } from '../../src/graph/hooks/ticker.mjs';
import { heartbeat } from '../../src/graph/hooks/heartbeat.mjs';
import { saveRun, loadRun } from '../../src/graph/run.mjs';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'tick-'));
Object.assign(process.env, { ENFORCER_STATE_DIR: join(root, 's'), HOME: root, GRAPH_ID: 'g1', ENFORCER_BASE_URL: 'http://127.0.0.1:9', GRAPH_API_KEY: 'k', ENFORCER_API_KEY: 'k', GRAPH_TICK_SECONDS: '0.05' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
// a 300 s lease claimed just now; the call under test runs for a few ticks
const live = () => {
  const sid = `t${++n}`;
  saveRun(sid, { graph_id: 'g1', node_id: 'n1', run_id: 'r1', key: 'k', claimed_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 300000).toISOString() });
  return sid;
};
const pre = (sid, id) => ({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_use_id: id, cwd: root });
const markers = (sid) => readdirSync(join(root, 's', 'runs')).filter((f) => f.startsWith(`${sid}.tick-`));
const answer = (state, calls) => async (cfg, method, path) => { calls.push(path); return [200, { data: { state, lease_expires_at: new Date(Date.now() + 300000).toISOString() } }, null]; };

test('a Bash call longer than lease/3 heartbeats while it runs', async () => {
  const sid = live(), calls = [];
  await startTicker(pre(sid, 'u1')).then(() => { assert.equal(markers(sid).length, 1, 'a marker for the call'); });
  // the spawned ticker has no stub server to talk to, so drive the same loop in process
  const loop = tickLoop(pre(sid, 'u1'), answer('ok', calls));
  await sleep(400);
  assert.ok(calls.length >= 3, `heartbeats while the call runs: ${calls.length}`);
  assert.match(calls[0], /\/graphs\/g1\/nodes\/n1\/runs\/r1\/heartbeat$/);
  await stopTicker({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash', tool_use_id: 'u1' });
  assert.equal(await loop, 'stopped');
});

test('the ticker stops on PostToolUse', async () => {
  const sid = live(), calls = [];
  await startTicker(pre(sid, 'u2'));
  const loop = tickLoop(pre(sid, 'u2'), answer('ok', calls));
  await sleep(200);
  // another call's PostToolUse leaves this one ticking
  await stopTicker({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash', tool_use_id: 'other' });
  assert.ok(existsSync(join(root, 's', 'runs', `${sid}.tick-u2`)));
  await stopTicker({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash', tool_use_id: 'u2' });
  assert.equal(await loop, 'stopped');
  const after = calls.length;
  await sleep(250);
  assert.equal(calls.length, after, 'no heartbeat after the call ended');
  // Stop and SessionEnd stop every ticker of the actor
  await startTicker(pre(sid, 'u3'));
  await stopTicker({ hook_event_name: 'SessionEnd', session_id: sid });
  assert.deepEqual(markers(sid), []);
});

test('the ticker stops on a reclaimed heartbeat', async () => {
  const sid = live(), calls = [];
  await startTicker(pre(sid, 'u4'));
  const loop = tickLoop(pre(sid, 'u4'), answer('reclaimed', calls));
  assert.equal(await loop, 'reclaimed');
  assert.equal(calls.length, 1, 'one heartbeat, then the ticker stops');
  assert.deepEqual(markers(sid), []);
  await sleep(200);
  assert.equal(calls.length, 1, 'a reclaimed run is never heartbeated again');
  // the worker hears about it at its next PostToolUse
  const out = await heartbeat({ session_id: sid, tool_name: 'Bash', cwd: root });
  assert.match(out.systemMessage, /lapsed and another harness now owns it/);
});

test('the ticker stops when the run file is gone, and ignores non-Bash tools', async () => {
  assert.equal(await tickLoop({ session_id: 'nobody', tool_use_id: 'u5', cwd: root }, answer('ok', [])), 'no-run');
  const sid = live();
  await startTicker({ ...pre(sid, 'u6'), tool_name: 'Read' });
  assert.deepEqual(markers(sid), []);
});

test('the spawned ticker process heartbeats a real server and stops with the call', async () => {
  const seen = [];
  const srv = createServer((req, res) => { seen.push(req.url); req.resume(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data: { state: 'ok', lease_expires_at: new Date(Date.now() + 300000).toISOString() } })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const prev = process.env.ENFORCER_BASE_URL;
  process.env.ENFORCER_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  try {
    const sid = live();
    await startTicker(pre(sid, 'u7'));
    for (let i = 0; i < 60 && seen.length < 3; i++) await sleep(100);
    assert.ok(seen.length >= 3, `the detached ticker heartbeated: ${seen.length}`);
    await stopTicker({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash', tool_use_id: 'u7' });
    await sleep(300);
    const after = seen.length;
    await sleep(400);
    assert.equal(seen.length, after, 'the ticker process exited with the call');
  } finally { process.env.ENFORCER_BASE_URL = prev; srv.close(); }
});
