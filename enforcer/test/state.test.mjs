// Legacy session state migrates even when CLAUDE_PLUGIN_DATA is set, and the
// legacy dir honours CLAUDE_CONFIG_DIR.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'state-'));
process.env.HOME = join(root, 'home');
for (const k of ['ENFORCER_STATE_DIR', 'ENFORCER_CONFIG_HOME', 'CLAUDE_CONFIG_DIR']) delete process.env[k];
let n = 0; const ok = (m) => { n++; console.log('  ok  ' + m); };
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
console.log(`${n} passed, 0 failed`);
