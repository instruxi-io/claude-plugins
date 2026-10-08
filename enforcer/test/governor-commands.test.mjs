import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/enforcer', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'gov-cmd-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, ENFORCER_CONFIG_HOME: join(home, 'cfg'), GOVERNOR_HOME: join(home, 'gov') };
for (const k of ['ENFORCER_GOVERNOR_RULES', 'ENFORCER_GOVERNOR_BUDGET', 'ENFORCER_GOVERNOR_POLICY']) delete env[k];
const gov = (...a) => spawnSync(process.execPath, [bin, 'governor', ...a], { env, encoding: 'utf8' });
const cfg = () => { const f = join(home, 'gov', 'config.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; };

test('governor set writes a valid value', () => {
  const r = gov('set', 'dollars', '12');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cfg().dollars, 12);
});
test('governor set refuses a value the validator rejects', () => {
  const r = gov('set', 'soft', '75');
  assert.match(r.stdout, /Not changed/);
  assert.equal(cfg().soft, undefined);
});
test('governor enable rules sets rulesOn true', () => {
  const r = gov('enable', 'rules');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rulesOn: off -> on/);
  assert.equal(cfg().rulesOn, true);
});
test('governor disable policy sets policyOn false', () => {
  gov('enable', 'policy');
  const r = gov('disable', 'policy');
  assert.match(r.stdout, /policyOn: on -> off/);
  assert.equal(cfg().policyOn, false);
});
test('governor enable refuses an unknown check', () => {
  assert.notEqual(gov('enable', 'bogus').status, 0);
});
test('governor telemetry status runs', () => {
  const r = gov('telemetry', 'status');
  assert.equal(r.status, 0, r.stderr);
});
