import test from 'node:test';
import assert from 'node:assert/strict';
import { workerEnv } from '../../src/dispatch/launch.mjs';
import { identityCheck, readAgentKey, estimateHours } from '../../src/dispatch/agent.mjs';
import { parseDispatchArgs } from '../../src/dispatch/run.mjs';

const plan = (n) => Array.from({ length: n }, () => ({ status: 'active', data: {} }));

test('agent credential is passed to workers and not the browser sign-in', () => {
  const env = { PATH: '/bin', ENFORCER_AGENT_KEY: 'agent-secret', GRAPH_API_KEY: 'browser-token', ENFORCER_API_KEY: 'browser-token' };
  const key = readAgentKey('ci', env);
  assert.equal(key, 'agent-secret');
  const w = workerEnv('g', env, { token: key });
  assert.equal(w.GRAPH_API_KEY, 'agent-secret');
  assert.ok(!Object.values(w).includes('browser-token'));
  assert.equal(w.ENFORCER_AGENT_KEY, undefined);
  assert.equal(parseDispatchArgs(['g', '--agent', 'ci'], env).agent, 'ci');
  assert.equal(identityCheck({ agent: 'ci', agentKey: key }).ok, true);
  assert.equal(identityCheck({ agent: 'ci', agentKey: null }).ok, false);
});

test('a long plan on a browser sign-in is refused without --allow-browser-signin', () => {
  assert.ok(estimateHours(plan(10), 1) > 2);
  const refused = identityCheck({ nodes: plan(10), workers: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.line, /--allow-browser-signin/);
  assert.equal(identityCheck({ nodes: plan(10), workers: 1, allowBrowserSignin: true }).ok, true);
  assert.equal(identityCheck({ nodes: plan(2), workers: 1 }).ok, true);
});
