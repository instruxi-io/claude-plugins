// Server machine codes -> user and model messages, announced once per session; warnings[] surfaced once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, notice, announce, warningNotices } from '../src/errors.mjs';
import { heartbeat } from '../src/graph/hooks/heartbeat.mjs';
import { saveRun } from '../src/graph/run.mjs';
import { logPath } from '../src/graph/hooklog.mjs';

const saved = { ...process.env };
const root = mkdtempSync(join(tmpdir(), 'errs-'));
Object.assign(process.env, { ENFORCER_STATE_DIR: join(root, 'state'), HOME: root });
test.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

test('401 says to log in', () => {
  const d = describe({ status: 401 });
  assert.match(d.user, /\/enforcer:login/);
});
test('insufficient_scope names the scope', () => {
  const d = describe({ status: 403, body: { error: { code: 'insufficient_scope', scope: 'graph:admin' } } });
  assert.match(d.user, /graph:admin/); assert.match(d.user, /--for admin/); assert.match(d.model, /graph:admin/);
  assert.match(describe({ status: 403, code: 'insufficient_scope', detail: 'missing scope: files:write' }).user, /files:write/);
});
test('billing_restricted is a notice', () => assert.match(describe({ status: 403, body: { error: 'billing_restricted' } }).user, /billing/));
test('404 on a run means reclaimed; elsewhere it is not ours', () => {
  assert.equal(describe({ status: 404 }, { run: true }).code, 'run_reclaimed');
  assert.equal(describe({ status: 404 }), null);
});
test('client_attestation_required names the minimum version', () => {
  const d = describe({ status: 409, body: { error: { code: 'client_attestation_required', min_client_version: '2.4.0' } } });
  assert.match(d.user, /2\.4\.0/); assert.match(d.model, /2\.4\.0/);
});
test('run_already_ended means finished', () => assert.match(describe({ status: 409, code: 'run_already_ended' }).user, /finished/));
test('429 and 5xx are retried, never announced', () => {
  for (const status of [429, 500, 503]) { const d = describe({ status }); assert.equal(d.retried, true); assert.equal(d.quiet, true); }
  assert.equal(notice('s-retry', { status: 503 }), null);
});
test('a code is announced once per session', () => {
  const err = { status: 403, body: { error: { code: 'insufficient_scope', scope: 'x:y' } } };
  const first = notice('s1', err);
  assert.match(first.systemMessage, /x:y/);
  assert.equal(notice('s1', err), null, 'quiet the second time');
  assert.ok(notice('s2', err), 'another session hears it again');
  assert.equal(announce('s1', 'other'), true);
  const lines = readFileSync(logPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.filter((l) => l.code === 'insufficient_scope').length >= 3, 'every occurrence is logged locally');
});
test("the server's warnings[] are surfaced once", () => {
  const w = ['hooks_inactive', { code: 'client_outdated', min_client_version: '3.0.0' }];
  const out = warningNotices('s3', w);
  assert.equal(out.length, 2); assert.match(out[1], /3\.0\.0/);
  assert.deepEqual(warningNotices('s3', w), []);
  assert.deepEqual(warningNotices('s3', undefined), []);
});
test('the heartbeat hook speaks a server error once, then stays quiet', async () => {
  process.env.GRAPH_ID = 'g1'; process.env.ENFORCER_BASE_URL = 'http://x.invalid'; process.env.GRAPH_API_KEY = 'k'; process.env.GRAPH_HEARTBEAT_MIN_GAP = '0';
  saveRun('s9', { graph_id: 'g1', node_id: 'n1', run_id: 'r1', key: 'k', claimed_at: '2020-01-01T00:00:00Z', lease_expires_at: '2020-01-01T00:05:00Z' });
  const post = async () => [403, null, { error: { code: 'billing_restricted' } }];
  const inp = { session_id: 's9', tool_name: 'Bash', cwd: root, tool_input: {}, tool_response: { duration_ms: 400000 } };
  const a = await heartbeat(inp, post);
  assert.match(a.systemMessage, /billing/);
  const b = await heartbeat(inp, post);
  assert.equal(b, null);
  const warn = async () => [200, { data: { state: 'ok' }, warnings: ['hooks_inactive'] }, null];
  assert.match((await heartbeat(inp, warn)).systemMessage, /hooks/);
  assert.equal(await heartbeat(inp, warn), null);
});
