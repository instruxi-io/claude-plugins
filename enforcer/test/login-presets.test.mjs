import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS } from '../bin/login.mjs';

const offered = JSON.parse(readFileSync(new URL('./fixtures/offered-scopes.json', import.meta.url), 'utf8'));
const listed = Object.entries(PRESETS).filter(([, v]) => Array.isArray(v));

test('every preset scope is in the offered list', () => {
  for (const [name, scopes] of listed) for (const s of scopes) assert.ok(offered.includes(s), `${name}: ${s}`);
});

test('the plan preset asks for graph-graph-templates.write', () => {
  assert.ok(PRESETS.plan.includes('enforcer:graph-graph-templates.write'));
  assert.ok(!PRESETS.plan.includes('enforcer:graph-templates.write'));
});

test('the agents preset has the two agent scopes and not the destructive one', () => {
  assert.ok(PRESETS.agents.includes('enforcer:agents.write'));
  assert.ok(PRESETS.agents.includes('enforcer:agents-credentials.write'));
  assert.ok(!PRESETS.agents.includes('enforcer:agents-credentials.destructive'));
});

test('no preset asks for a scope outside the offered list', () => {
  const outside = listed.flatMap(([, v]) => v).filter((s) => !offered.includes(s));
  assert.deepEqual(outside, []);
});
