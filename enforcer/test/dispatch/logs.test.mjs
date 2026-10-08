// `node --test test/dispatch/logs.test.mjs`: structured dispatcher log, redacted 0600 worker streams, retention.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLog, pruneLogs } from '../../src/dispatch/logs.mjs';
import { spawnWorker } from '../../src/dispatch/launch.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'logs-'));

test('log lines are JSON with ts level event', () => {
  const d = tmp();
  writeLog(d, 'human\n', 'FAILED alpha (attempt 1): boom', { key: 'alpha', run: 'r1', fields: { n: 1 } });
  writeLog(d, 'human\n', 'launch beta pid=1');
  const rows = readFileSync(join(d, 'dispatcher.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.ok(!Number.isNaN(Date.parse(rows[0].ts)) && rows[0].ts.includes('T'));
  assert.equal(rows[0].level, 'error');
  assert.equal(rows[0].event, 'failed');
  assert.equal(rows[0].key, 'alpha');
  assert.equal(rows[0].run, 'r1');
  assert.deepEqual(rows[0].fields, { n: 1 });
  assert.equal(rows[1].level, 'info');
  assert.equal(readFileSync(join(d, 'dispatcher.log'), 'utf8'), 'human\nhuman\n');
  assert.equal(statSync(join(d, 'dispatcher.jsonl')).mode & 0o777, 0o600);
});

test('worker stream has no bearer token', async () => {
  const d = tmp();
  const logPath = join(d, 'w.1.jsonl');
  const p = spawnWorker(['sh', '-c', 'echo "{\\"out\\":\\"curl -H Authorization: Bearer abcdef1234567890SECRET\\"}"'], { cwd: d, logPath });
  const keep = setInterval(() => {}, 100);
  await p.done;
  clearInterval(keep);
  const text = readFileSync(logPath, 'utf8');
  assert.ok(!text.includes('abcdef1234567890SECRET'));
  assert.ok(text.includes('[redacted:bearer]'));
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test('prune removes streams older than the retention', () => {
  const d = tmp();
  const old = join(d, 'old.1.jsonl'),
    fresh = join(d, 'new.1.jsonl'),
    big = join(d, 'big.1.jsonl');
  for (const f of [old, fresh]) writeFileSync(f, 'x');
  const past = new Date(Date.now() - 20 * 86400e3);
  utimesSync(old, past, past);
  assert.deepEqual(pruneLogs(d, { days: 14 }), [old]);
  assert.ok(!existsSync(old) && existsSync(fresh));
  writeFileSync(big, 'y'.repeat(100));
  const older = new Date(Date.now() - 3600e3);
  utimesSync(big, older, older);
  assert.deepEqual(pruneLogs(d, { days: 14, maxBytes: 50 }), [big]);
});
