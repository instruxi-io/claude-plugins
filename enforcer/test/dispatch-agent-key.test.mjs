// `node --test test/dispatch-agent-key.test.mjs`: which credential a dispatched worker carries. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerEnv } from '../src/dispatch/launch.mjs';

test('workerEnv gives the agent key to the hooks and to the MCP credential helper', () => {
  const env = workerEnv('g1', { PATH: '/bin', HOME: '/home/u' }, { token: 'ag_agent' });
  assert.equal(env.GRAPH_API_KEY, 'ag_agent');
  assert.equal(env.ENFORCER_API_KEY, 'ag_agent');
});

test('the operator ENFORCER_API_KEY never reaches a worker', () => {
  const env = workerEnv('g1', { PATH: '/bin', HOME: '/home/u', ENFORCER_API_KEY: 'env3_operator', GRAPH_API_KEY: 'env3_operator' }, {});
  assert.equal(env.ENFORCER_API_KEY, undefined);
  assert.equal(env.GRAPH_API_KEY, undefined);
});

test('an agent key replaces an operator key in the worker environment', () => {
  const env = workerEnv('g1', { PATH: '/bin', ENFORCER_API_KEY: 'env3_operator' }, { token: 'ag_agent' });
  assert.equal(env.ENFORCER_API_KEY, 'ag_agent');
});
