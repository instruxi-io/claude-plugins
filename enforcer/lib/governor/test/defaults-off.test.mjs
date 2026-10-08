// Decisioning is off by default. A fresh install REPORTS (a receipt for every
// call) and does not DECIDE (no capability rules, no spend or rate checks, no
// tenant policy lookup) until someone turns those on. An organisation's `on`
// still wins over the default (core/managed.mjs onWins).
// `node --test lib/governor/test/defaults-off.test.mjs`. No network, temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULTS } from '../core/policy.mjs';
import { merge } from '../core/managed.mjs';
import { SETTINGS } from '../core/settings.mjs';

const ENFORCER = new URL('../../../bin/enforcer', import.meta.url).pathname;
const RM_HOME = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, session_id: 'fresh01', cwd: tmpdir() };

// A machine nobody has configured: its own HOME, no config.json, signed out,
// not headless, not inside a graph run.
function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'gov-defaults-off-'));
  const gov = join(home, '.config', 'enforcer', 'governor');
  const env = { ...process.env, HOME: home, USERPROFILE: home, GOVERNOR_HOME: gov, ENFORCER_HOME: join(home, '.config', 'enforcer') };
  for (const k of Object.keys(env)) if (/^(ENFORCER_(?!HOME$)|JEV_HOOKS_|ANTHROPIC_)/.test(k)) delete env[k];
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return { home, gov, env };
}
const decide = ({ env }, ev = RM_HOME, extra = {}) => {
  const r = spawnSync(process.execPath, [ENFORCER, 'governor', 'decide'], { env: { ...env, ...extra }, input: JSON.stringify(ev), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
};
const receipts = (gov) => readFileSync(join(gov, 'receipts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('fresh config has budgetOn, rulesOn and policyOn false', () => {
  assert.equal(DEFAULTS.budgetOn, false);
  assert.equal(DEFAULTS.rulesOn, false);
  assert.equal(DEFAULTS.policyOn, false);
  for (const k of ['budgetOn', 'rulesOn', 'policyOn']) assert.match(SETTINGS[k].describe, /[Oo]ff by default/, k);
  // The config a fresh machine runs on: no config.json, so the defaults.
  const m = fresh();
  assert.equal(existsSync(join(m.gov, 'config.json')), false);
  const r = spawnSync(process.execPath, [ENFORCER, 'governor', 'config'], { env: m.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const k of ['budgetOn', 'rulesOn', 'policyOn']) assert.match(r.stdout, new RegExp(`${k}\\b[^\\n]*\\boff\\b`), `${k} shows off:\n${r.stdout}`);
});

test('decide allows with code checks_off on a fresh config', () => {
  const m = fresh();
  const rec = decide(m);
  assert.equal(rec.decision, 'allow');
  assert.equal(rec.code, 'checks_off');
  assert.equal(rec.rule, null);
  // ...and turning the capability rules on brings `rm -rf ~` back under them:
  // it is no longer let through, the delete rule holds it for a person.
  mkdirSync(m.gov, { recursive: true });
  writeFileSync(join(m.gov, 'config.json'), JSON.stringify({ rulesOn: true }));
  const on = decide(m);
  assert.notEqual(on.decision, 'allow');
  assert.equal(on.decision, 'ask');
  assert.equal(on.code, 'destructive_delete');
  assert.equal(on.rule, 'fs.delete_tree');
});

test('an organisation setting of on still wins over the default', () => {
  // The merge: an organisation `on` beats the local default `off`, per check.
  const eff = merge({ ...DEFAULTS }, { budgetOn: true, rulesOn: true, policyOn: true });
  assert.equal(eff.budgetOn, true);
  assert.equal(eff.rulesOn, true);
  assert.equal(eff.policyOn, true);
  // ...and an organisation `off` does not loosen a local `on`.
  assert.equal(merge({ ...DEFAULTS, rulesOn: true }, { rulesOn: false }).rulesOn, true);
  // End to end: the managed settings cache turns the rules on for a machine
  // that has no config of its own, and decide stops answering checks_off.
  const m = fresh();
  mkdirSync(m.gov, { recursive: true });
  writeFileSync(join(m.gov, 'managed-settings.json'), JSON.stringify({ at: Date.now(), settings: { rulesOn: true } }));
  const rec = decide(m);
  assert.equal(rec.decision, 'ask');
  assert.equal(rec.code, 'destructive_delete');
});

test('receipts are still written when decisioning is off', () => {
  const m = fresh();
  decide(m);
  decide(m, { ...RM_HOME, tool_input: { command: 'ls' } });
  const r = receipts(m.gov);
  assert.equal(r.length, 2);
  for (const x of r) {
    assert.equal(x.verdict, 'allow');
    assert.equal(x.decision.decision, 'allow');
    assert.equal(x.decision.code, 'checks_off');
    assert.equal(typeof x.hash, 'string', 'chained into the record');
  }
  // The record verifies: reporting does not depend on decisioning.
  const v = spawnSync(process.execPath, [ENFORCER, 'governor', 'verify'], { env: m.env, encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
});
