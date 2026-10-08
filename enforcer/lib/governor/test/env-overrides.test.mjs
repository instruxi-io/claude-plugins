// Per-process overrides: ENFORCER_GOVERNOR_RULES, _BUDGET and _POLICY turn a
// decision check on or off for one process tree without touching the
// machine-wide config.json. They beat config.json, not an organisation floor.
// `node --test lib/governor/test/env-overrides.test.mjs`. No network, temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../core/policy.mjs';
import { envOverrides, withEnv, merge } from '../core/managed.mjs';

const ENFORCER = fileURLToPath(new URL('../../../bin/enforcer', import.meta.url));
const RM_HOME = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, session_id: 'envov01', cwd: tmpdir() };

// A machine of its own: temp HOME, signed out, no ENFORCER_* variables leaking
// in from the process running the tests.
function machine(config) {
  const home = mkdtempSync(join(tmpdir(), 'gov-env-overrides-'));
  const gov = join(home, '.config', 'enforcer', 'governor');
  const env = { ...process.env, HOME: home, USERPROFILE: home, GOVERNOR_HOME: gov, ENFORCER_HOME: join(home, '.config', 'enforcer') };
  for (const k of Object.keys(env)) if (/^(ENFORCER_(?!HOME$)|JEV_HOOKS_|ANTHROPIC_)/.test(k)) delete env[k];
  delete env.CLAUDE_CODE_ENTRYPOINT;
  mkdirSync(gov, { recursive: true });
  if (config) writeFileSync(join(gov, 'config.json'), JSON.stringify(config));
  return { home, gov, env };
}
const run = (m, args, extra = {}, input) => {
  const r = spawnSync(process.execPath, [ENFORCER, 'governor', ...args], { env: { ...m.env, ...extra }, input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const decide = (m, extra = {}) => JSON.parse(run(m, ['decide'], extra, JSON.stringify(RM_HOME)).trim().split('\n').pop());
const configText = (m) => readFileSync(join(m.gov, 'config.json'), 'utf8');

test('ENFORCER_GOVERNOR_RULES=on turns the rules on over a config that says off', () => {
  assert.deepEqual(envOverrides({ ENFORCER_GOVERNOR_RULES: 'on' }), { rulesOn: true });
  assert.equal(withEnv({ ...DEFAULTS, rulesOn: false }, { ENFORCER_GOVERNOR_RULES: 'on' }).rulesOn, true);
  const m = machine({ rulesOn: false });
  const before = configText(m);
  // Without the variable: the config's off holds.
  assert.equal(decide(m).code, 'checks_off');
  // With it: the delete rule holds `rm -rf ~` for a person.
  const on = decide(m, { ENFORCER_GOVERNOR_RULES: 'on' });
  assert.equal(on.decision, 'ask');
  assert.equal(on.code, 'destructive_delete');
  assert.equal(on.rule, 'fs.delete_tree');
  // ...and the machine-wide file is untouched.
  assert.equal(configText(m), before);
  // The other direction: off beats a config that says on, for this process only.
  const m2 = machine({ rulesOn: true });
  assert.equal(decide(m2).decision, 'ask');
  assert.equal(decide(m2, { ENFORCER_GOVERNOR_RULES: 'off' }).code, 'checks_off');
  // The other two variables map to their own settings.
  assert.deepEqual(envOverrides({ ENFORCER_GOVERNOR_BUDGET: 'on', ENFORCER_GOVERNOR_POLICY: 'off' }), { budgetOn: true, policyOn: false });
});

test('an organisation floor of on beats ENFORCER_GOVERNOR_RULES=off', () => {
  // The merge: the environment is local, and a managed `on` cannot be loosened.
  assert.equal(merge(withEnv({ ...DEFAULTS }, { ENFORCER_GOVERNOR_RULES: 'off' }), { rulesOn: true }).rulesOn, true);
  // End to end, through the managed settings cache.
  const m = machine({ rulesOn: false });
  writeFileSync(join(m.gov, 'managed-settings.json'), JSON.stringify({ at: Date.now(), settings: { rulesOn: true } }));
  const rec = decide(m, { ENFORCER_GOVERNOR_RULES: 'off' });
  assert.equal(rec.decision, 'ask');
  assert.equal(rec.code, 'destructive_delete');
});

test('an unrecognised value is ignored', () => {
  for (const v of ['yes', 'true', '1', '', 'ON please', 'enabled']) {
    assert.deepEqual(envOverrides({ ENFORCER_GOVERNOR_RULES: v, ENFORCER_GOVERNOR_BUDGET: v, ENFORCER_GOVERNOR_POLICY: v }), {}, v);
  }
  // Case and surrounding space are forgiven; the word is not.
  assert.deepEqual(envOverrides({ ENFORCER_GOVERNOR_RULES: ' On ' }), { rulesOn: true });
  // A bad value neither errors nor changes the decision: the config stands.
  const off = machine({ rulesOn: false });
  assert.equal(decide(off, { ENFORCER_GOVERNOR_RULES: 'yes' }).code, 'checks_off');
  const on = machine({ rulesOn: true });
  assert.equal(decide(on, { ENFORCER_GOVERNOR_RULES: 'nope' }).decision, 'ask');
  // ...and config shows no environment marker for it.
  const out = run(off, ['config'], { ENFORCER_GOVERNOR_RULES: 'yes' });
  assert.doesNotMatch(out, /from the environment/);
});

test('governor config marks a value that came from the environment', () => {
  const m = machine({ rulesOn: false });
  const out = run(m, ['config'], { ENFORCER_GOVERNOR_RULES: 'on' });
  const line = out.split('\n').find((l) => /^\s+rulesOn\b/.test(l));
  assert.ok(line, out);
  assert.match(line, /\bon\b/);
  assert.match(line, /~/);
  assert.match(line, /\[from the environment: ENFORCER_GOVERNOR_RULES=on\]/);
  // Only the overridden setting is marked.
  const budget = out.split('\n').find((l) => /^\s+budgetOn\b/.test(l));
  assert.doesNotMatch(budget, /from the environment/);
  assert.match(out, /~ set by this process's environment/);
  // Without the variable there is no marker.
  assert.doesNotMatch(run(m, ['config']), /from the environment/);
  // status says so too.
  const status = run(m, ['status'], { ENFORCER_GOVERNOR_RULES: 'on' });
  assert.match(status, /Set by this process's environment: ENFORCER_GOVERNOR_RULES=on/);
  assert.doesNotMatch(run(m, ['status']), /environment/);
});
