// A gate is decided by a person with graph_decide; a worker never claims or reports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluate, DEFAULT_RULES } from '../lib/governor/core/capability.mjs';
import { toolEvent } from '../lib/governor/adapters/claude-code/events.mjs';

const home = mkdtempSync(join(tmpdir(), 'gate-decide-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_PLUGIN_DATA = join(home, 'data');
delete process.env.ENFORCER_STATE_DIR;
delete process.env.GRAPH_EVIDENCE_MODE;
const { decide } = await import('../src/graph/hooks/attach.mjs');

const ev = (name, worker) => ({ ...toolEvent({ tool_name: name, tool_input: {}, session_id: 's', cwd: '/tmp' }), worker: worker || { headless: false } });

test('graph_decide is classified as a deciding write', () => {
  const rule = DEFAULT_RULES.find((r) => r.id === 'enforcer.graph_decide');
  assert.equal(rule.authz, 'write');
  const r = evaluate(DEFAULT_RULES, ev('mcp__enforcer__graph_decide'));
  assert.equal(r.decision ?? r.action, 'ask');
  const h = evaluate(DEFAULT_RULES, ev('mcp__plugin_enforcer_enforcer__graph_decide', { headless: true }));
  assert.equal(h.decision ?? h.action, 'deny');
  assert.equal(evaluate(DEFAULT_RULES, ev('mcp__enforcer__graph_report')), null);
});

function fixture(type) {
  const aid = 'agent-' + type;
  const key = createHash('sha256').update(`agent_id:${aid}`).digest('hex').slice(0, 32);
  mkdirSync(join(process.env.CLAUDE_PLUGIN_DATA, 'runs'), { recursive: true });
  writeFileSync(
    join(process.env.CLAUDE_PLUGIN_DATA, 'runs', `${key}.json`),
    JSON.stringify({ run_id: 'r1', node_id: 'n', graph_id: 'g', key: 'k', type, acceptance: ['`ls package.json` prints `package.json`'] }),
  );
  return {
    session_id: 's-' + type,
    agent_id: aid,
    cwd: home,
    tool_name: 'mcp__enforcer__graph_report',
    tool_input: { graph: 'g', node_id: 'n', run_id: 'r1', status: 'succeeded', report: 'x' },
  };
}

test('the report hook runs no acceptance line for a gate node', async () => {
  let ran = 0;
  const out = await decide(fixture('gate'), { acceptanceRun: () => (ran++, { status: 0, stdout: '', stderr: '' }) });
  assert.equal(ran, 0);
  assert.deepEqual(out.updatedInput.evidence, [{ kind: 'note', text: 'this is a gate: decide it with graph_decide, do not report it' }]);
  assert.equal(out.updatedInput.status, 'succeeded');
});

test('the report hook still runs acceptance lines for a task node', async () => {
  let ran = 0;
  await decide(fixture('task'), { acceptanceRun: (...a) => (ran++, { status: 0, stdout: 'x', stderr: '' }) });
  assert.ok(ran > 0);
});
