// `node --test test/dispatch-worker-rules.test.mjs`: the --worker-rules flag, workerEnv and the preflight line. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerEnv, ENV_ALLOW, DEFAULT_WORKER_RULES, workerRulesLine } from '../src/dispatch/launch.mjs';
import { parseDispatchArgs } from '../src/dispatch/run.mjs';

test('workerEnv sets ENFORCER_GOVERNOR_RULES from --worker-rules', () => {
  assert.equal(workerEnv('g', {}, { workerRules: 'on' }).ENFORCER_GOVERNOR_RULES, 'on');
  assert.equal(workerEnv('g', {}, { workerRules: 'off' }).ENFORCER_GOVERNOR_RULES, 'off');
  assert.equal(workerEnv('g', { ENFORCER_GOVERNOR_RULES: 'on' }, { workerRules: 'off' }).ENFORCER_GOVERNOR_RULES, 'off');
  assert.equal(parseDispatchArgs(['g', '--worker-rules', 'on'], {}).workerRules, 'on');
  assert.throws(() => parseDispatchArgs(['g', '--worker-rules', 'maybe'], {}), /on or off/);
});

test('preflight states the worker rules mode', () => {
  assert.match(workerRulesLine('off'), /workers run with the worker rules OFF \(pass --worker-rules on to enforce them\)/);
  assert.match(workerRulesLine('on'), /worker rules ON/);
});

test('the default is off', () => {
  assert.equal(DEFAULT_WORKER_RULES, 'off');
  assert.equal(workerEnv('g', {}).ENFORCER_GOVERNOR_RULES, 'off');
  assert.equal(parseDispatchArgs(['g'], {}).workerRules, 'off');
  assert.equal(workerRulesLine(), workerRulesLine('off'));
});

test('ENV_ALLOW still rejects an arbitrary variable', () => {
  assert.ok(!ENV_ALLOW.includes('SOME_ARBITRARY_VAR'));
  const out = workerEnv('g', { SOME_ARBITRARY_VAR: 'x', ENFORCER_API_KEY: 'secret' }, {});
  assert.equal(out.SOME_ARBITRARY_VAR, undefined);
  assert.equal(out.ENFORCER_API_KEY, undefined);
});
