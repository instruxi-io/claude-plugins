// Keepalive tools never trip the loop detector (2026-10-06): a worker heartbeating its run is not looping.
import assert from 'node:assert/strict';
import { ingest, evaluate } from '../core/economics.mjs';
const cfg = { loopOn: true, loopLimit: 4, loopWindow: 8, budgetOn: false };
const ev = (name, args = {}) => ({ tool: name, name, action: `${name}:${JSON.stringify(args)}`, args, agent: 'a1', session: 's1' });
{
  const state = { agents: {} };
  for (let i = 0; i < 12; i++) ingest(state, ev('mcp__plugin_enforcer_enforcer__graph_heartbeat', { run_id: 'r1' }), cfg, 1000 + i);
  const v = evaluate(state, ev('mcp__plugin_enforcer_enforcer__graph_heartbeat', { run_id: 'r1' }), cfg, 2000);
  assert.ok(!v || v.action !== 'deny', `heartbeats must not be a loop: ${JSON.stringify(v)}`);
  console.log('  ok  twelve identical heartbeats are not a loop');
}
{
  const state = { agents: {} };
  for (let i = 0; i < 12; i++) ingest(state, ev('mcp__plugin_enforcer_enforcer__graph_plan_status', { graph: 'g' }), cfg, 1000 + i);
  const v = evaluate(state, ev('mcp__plugin_enforcer_enforcer__graph_plan_status', { graph: 'g' }), cfg, 2000);
  assert.ok(!v || v.action !== 'deny'); console.log('  ok  polling plan status is not a loop');
}
{
  const state = { agents: {} };
  for (let i = 0; i < 6; i++) ingest(state, ev('Bash', { command: 'npm test' }), cfg, 1000 + i);
  const v = evaluate(state, ev('Bash', { command: 'npm test' }), cfg, 2000);
  assert.equal(v && v.action, 'deny'); console.log('  ok  six identical Bash calls are still a loop');
}
console.log('ok   loop-exempt');
