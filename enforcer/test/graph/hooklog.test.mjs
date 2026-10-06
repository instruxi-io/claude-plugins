import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logHook, logPath, noteFailure, rotate } from '../../src/graph/hooklog.mjs';

function fresh() {
  process.env.ENFORCER_STATE_DIR = join(mkdtempSync(join(tmpdir(), 'hooklog-')), 'state');
  delete process.env.ENFORCER_DEBUG;
}

test('debug log lines have the fixed fields', () => {
  fresh();
  assert.equal(logHook({ hook: 'heartbeat', event: 'PostToolUse', actor: 'a', outcome: 'ok', ms: 3, code: 0 }), false);
  process.env.ENFORCER_DEBUG = '1';
  assert.equal(logHook({ hook: 'heartbeat', event: 'PostToolUse', actor: 'a', outcome: 'ok', ms: 3, code: 0 }), true);
  const j = JSON.parse(readFileSync(logPath(), 'utf8').trim());
  assert.deepEqual(Object.keys(j), ['ts', 'hook', 'event', 'actor', 'outcome', 'ms', 'code']);
  assert.equal(statSync(logPath()).mode & 0o777, 0o600);
});

test('rotation keeps two generations', () => {
  fresh();
  process.env.ENFORCER_DEBUG = '1';
  const rec = { hook: 'h', event: 'e', actor: 'a', outcome: 'ok', ms: 1, code: 0 };
  logHook(rec, { max: 100 });
  for (let i = 0; i < 12; i++) logHook({ ...rec, hook: `h${i}` }, { max: 100 });
  const p = logPath();
  assert.ok(existsSync(p) && existsSync(`${p}.1`));
  assert.ok(!existsSync(`${p}.2`));
  assert.equal(statSync(`${p}.1`).mode & 0o777, 0o600);
  assert.equal(rotate(p, 1e9), false);
});

test('third failure announces once', () => {
  fresh();
  assert.equal(noteFailure('s1', 'heartbeat'), null);
  assert.equal(noteFailure('s1', 'heartbeat'), null);
  const m = noteFailure('s1', 'heartbeat');
  assert.match(m, /heartbeat/);
  assert.ok(m.includes(logPath()));
  assert.equal(noteFailure('s1', 'heartbeat'), null);
  assert.equal(noteFailure('s2', 'heartbeat'), null);
});
