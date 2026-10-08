// `enforcer governor status` first line: is decisioning on? Temp HOME, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decisioningLine } from '../lib/governor/core/managed.mjs';

const ENFORCER = fileURLToPath(new URL('../bin/enforcer', import.meta.url));
function status(config, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gov-status-mode-'));
  const gov = join(home, '.config', 'enforcer', 'governor');
  mkdirSync(gov, { recursive: true });
  if (config) writeFileSync(join(gov, 'config.json'), JSON.stringify(config));
  const env = { ...process.env, HOME: home, USERPROFILE: home, GOVERNOR_HOME: gov, ENFORCER_HOME: join(home, '.config', 'enforcer') };
  for (const k of Object.keys(env)) if (/^(ENFORCER_(?!HOME$)|JEV_HOOKS_|ANTHROPIC_)/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, [ENFORCER, 'governor', 'status'], { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n')[0];
}

test('status says OFF when every check is off', () => {
  assert.equal(status({ rulesOn: false, budgetOn: false, policyOn: false }),
    'Decisioning: OFF (report only). Turn on: enforcer governor enable rules');
  assert.equal(status(), 'Decisioning: OFF (report only). Turn on: enforcer governor enable rules');
});

test('status names the checks that are on', () => {
  assert.equal(status({ rulesOn: true, budgetOn: true, policyOn: false }), 'Decisioning: ON (rules, budget)');
});

test('status marks a check forced on by the organisation', () => {
  const line = decisioningLine({ rulesOn: false, budgetOn: true }, { managed: { rulesOn: true }, env: {} });
  assert.equal(line, 'Decisioning: ON (rules (organisation), budget)');
});

test('status marks a check set by the environment', () => {
  assert.equal(status({}, { ENFORCER_GOVERNOR_POLICY: 'on' }), 'Decisioning: ON (policy (environment))');
});
