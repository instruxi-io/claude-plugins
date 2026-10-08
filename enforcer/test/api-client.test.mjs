import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, request, ApiError, parseRetryAfter } from '../lib/api/client.mjs';

const resp = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const seq = (...rs) => {
  const calls = [];
  const f = async (u, i) => {
    calls.push({ u, i });
    const r = rs[Math.min(calls.length - 1, rs.length - 1)];
    if (r instanceof Error) throw r;
    return r();
  };
  f.calls = calls;
  return f;
};

test('429 with Retry-After waits that long then succeeds', async () => {
  const f = seq(
    () => resp(429, {}, { 'Retry-After': '2' }),
    () => resp(200, { ok: 1 }),
  );
  const waits = [];
  const r = await apiFetch('http://x/a', {}, { fetchImpl: f, sleep: async (ms) => waits.push(ms) });
  assert.equal(r.status, 200);
  assert.deepEqual(waits, [2000]);
  assert.equal(f.calls.length, 2);
});
test('500 is not retried', async () => {
  const f = seq(() => resp(500, { error: 'boom' }));
  const r = await apiFetch('http://x/a', {}, { fetchImpl: f, sleep: async () => {} });
  assert.equal(r.status, 500);
  assert.equal(f.calls.length, 1);
});
test('4xx is not retried', async () => {
  const f = seq(() => resp(404, {}));
  await apiFetch('http://x/a', {}, { fetchImpl: f, sleep: async () => {} });
  assert.equal(f.calls.length, 1);
});
test('network errors retry with jittered backoff then rethrow with the request id', async () => {
  const f = seq(new Error('ECONNRESET'));
  const waits = [];
  await assert.rejects(apiFetch('http://x/a', {}, { fetchImpl: f, retries: 2, random: () => 0, sleep: async (ms) => waits.push(ms) }), /ECONNRESET/);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(waits, [100, 200]);
});
test('ApiError carries the machine code', async () => {
  const f = seq(() => resp(403, { error: 'scope_missing', detail: 'need files:write' }, { 'X-Request-Id': 'rid-1' }));
  await assert.rejects(request('http://x/a', {}, { fetchImpl: f, auth: false }), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 403);
    assert.equal(e.code, 'scope_missing');
    assert.equal(e.detail, 'need files:write');
    assert.equal(e.requestId, 'rid-1');
    return true;
  });
});
test('every request has X-Request-Id and X-Graph-Client', async () => {
  const f = seq(() => resp(200));
  await apiFetch('http://x/a', { headers: { A: 'b' } }, { fetchImpl: f });
  const h = f.calls[0].i.headers;
  assert.match(h['X-Request-Id'], /^[0-9a-f-]{36}$/);
  assert.match(h['X-Graph-Client'], /^enforcer-plugin\/\S+; hooks=(on|off)$/);
  assert.equal(h.A, 'b');
});
test('parseRetryAfter reads seconds and dates', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(
    parseRetryAfter('Wed, 01 Jan 2025 00:00:05 GMT', () => Date.parse('2025-01-01T00:00:00Z')),
    5000,
  );
  assert.equal(parseRetryAfter(null), null);
});
