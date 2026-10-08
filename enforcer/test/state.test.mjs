// Legacy session state migrates even when CLAUDE_PLUGIN_DATA is set, and the
// legacy dir honours CLAUDE_CONFIG_DIR.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'state-'));
process.env.HOME = join(root, 'home');
for (const k of ['ENFORCER_STATE_DIR', 'ENFORCER_CONFIG_HOME', 'CLAUDE_CONFIG_DIR']) delete process.env[k];
let n = 0;
const ok = (m) => {
  n++;
  console.log('  ok  ' + m);
};
const { stateBase } = await import('../src/state.mjs');
const { legacyStateDir } = await import('../hooks/claude/paths.mjs');

mkdirSync(join(legacyStateDir(), 'runs'), { recursive: true });
writeFileSync(join(legacyStateDir(), 'runs', 's1.json'), '{"run_id":"r1"}');
const data = join(root, 'plugin-data');
process.env.CLAUDE_PLUGIN_DATA = data;
assert.equal(stateBase(), data);
assert.equal(JSON.parse(readFileSync(join(data, 'runs', 's1.json'), 'utf8')).run_id, 'r1');
ok('legacy runs migrate when CLAUDE_PLUGIN_DATA is set');

process.env.CLAUDE_CONFIG_DIR = join(root, 'cc');
assert.equal(legacyStateDir(), join(root, 'cc', 'enforcer-graph'));
ok('legacy state dir honours CLAUDE_CONFIG_DIR');
import { statSync } from 'node:fs';
{
  const old = process.umask(0o002);
  try {
    process.env.ENFORCER_STATE_DIR = join(root, 'fresh', 'state');
    delete process.env.CLAUDE_PLUGIN_DATA;
    const { runChecks } = await import('../src/doctor.mjs');
    const rows = await runChecks({ network: false });
    const row = rows.find((r) => r.name === 'state dir writable, 0700');
    if (process.platform !== 'win32') assert.equal(statSync(process.env.ENFORCER_STATE_DIR).mode & 0o777, 0o700);
    assert.ok(row.ok, row.detail);
  } finally {
    process.umask(old);
  }
  ok('state dir is created 0700 under a permissive umask');
}
console.log(`${n} passed, 0 failed`);
