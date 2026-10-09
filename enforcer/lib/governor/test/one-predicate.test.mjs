// One predicate for the boolean settings: the gate, the rule resolver and
// `governor status` must agree about the same config.json and the same floor.
// `node --test lib/governor/test/one-predicate.test.mjs`. No network, temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { toBool } from '../core/bool.mjs';
import { resolveRules } from '../core/capability.mjs';

const ENFORCER = fileURLToPath(new URL('../../../bin/enforcer', import.meta.url));
const RM_HOME = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, session_id: 'onepred01', cwd: tmpdir() };

function machine(config, managed) {
  const home = mkdtempSync(join(tmpdir(), 'gov-one-pred-'));
  const gov = join(home, '.config', 'enforcer', 'governor');
  const env = { ...process.env, HOME: home, USERPROFILE: home, GOVERNOR_HOME: gov, ENFORCER_HOME: join(home, '.config', 'enforcer') };
  for (const k of Object.keys(env)) if (/^(ENFORCER_(?!HOME$)|JEV_HOOKS_|ANTHROPIC_)/.test(k)) delete env[k];
  delete env.CLAUDE_CODE_ENTRYPOINT;
  mkdirSync(gov, { recursive: true });
  if (config) writeFileSync(join(gov, 'config.json'), JSON.stringify(config));
  if (managed) writeFileSync(join(gov, 'managed-settings.json'), JSON.stringify({ at: Date.now(), settings: managed }));
  return { env };
}
const run = (m, args, input) => {
  const r = spawnSync(process.execPath, [ENFORCER, 'governor', ...args], { env: m.env, input, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r;
};
// What the gate does with a destructive delete, and what status says.
const probe = (config, managed) => {
  const m = machine(config, managed);
  const rec = JSON.parse(run(m, ['decide'], JSON.stringify(RM_HOME)).stdout.trim().split('\n').pop());
  const status = run(m, ['status']);
  return {
    enforcing: rec.decision !== 'allow',
    statusOn: /Decisioning: ON/.test(status.stdout),
    statusOff: /Decisioning: OFF/.test(status.stdout),
    stderr: status.stderr,
  };
};

test('status and gate agree for every accepted spelling', () => {
  const on = [true, 'true', 'TRUE', ' on ', 'yes', 1, '1'];
  const off = [false, 'false', 'False', 'off', ' no ', 0, '0'];
  for (const v of on) {
    assert.equal(toBool(v), true, String(v));
    const p = probe({ rulesOn: v });
    assert.ok(p.enforcing && p.statusOn && !p.statusOff, `rulesOn ${JSON.stringify(v)}: ${JSON.stringify(p)}`);
  }
  for (const v of off) {
    assert.equal(toBool(v), false, String(v));
    const p = probe({ rulesOn: v });
    assert.ok(!p.enforcing && p.statusOff && !p.statusOn, `rulesOn ${JSON.stringify(v)}: ${JSON.stringify(p)}`);
  }
  assert.deepEqual(resolveRules({ rulesOn: 'off' }), []);
  assert.ok(resolveRules({ rulesOn: 'on' }).length > 0);
});

test('a string false in config.json turns the rules off and status says OFF', () => {
  const p = probe({ rulesOn: 'false' });
  assert.equal(p.enforcing, false);
  assert.equal(p.statusOff, true);
});

test('a managed string true is honored as on', () => {
  for (const v of ['true', 'on', 1]) {
    const p = probe({ rulesOn: false }, { rulesOn: v });
    assert.ok(p.enforcing && p.statusOn, `managed ${JSON.stringify(v)}: ${JSON.stringify(p)}`);
  }
});

test('an unrecognised value is ignored with a notice', () => {
  // The default applies (rules off on a fresh config), and it is said once.
  const p = probe({ rulesOn: 'maybe' });
  assert.equal(p.enforcing, false);
  assert.equal(p.statusOff, true);
  assert.equal((p.stderr.match(/rulesOn="maybe" is not a boolean/g) || []).length, 1, p.stderr);
  const q = probe({ rulesOn: false }, { rulesOn: 'maybe' });
  assert.equal(q.enforcing, false);
  assert.match(q.stderr, /organisation settings rulesOn="maybe"/);
});
