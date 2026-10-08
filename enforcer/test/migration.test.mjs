// First-run migration of state from the old locations to ~/.config/enforcer/.
// A real receipt chain is written at the old governor path; importing the
// store with no GOVERNOR_HOME must move it, keep the chain verifiable, leave a
// pointer, and leave the second run alone. Session state moves the same way.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { legacyStateDir } from '../hooks/claude/paths.mjs';

const home = mkdtempSync(join(tmpdir(), 'migrate-'));
process.env.HOME = home;
delete process.env.GOVERNOR_HOME;
delete process.env.ENFORCER_CONFIG_HOME;
delete process.env.ENFORCER_STATE_DIR;
delete process.env.CLAUDE_PLUGIN_DATA;
let n = 0;
const ok = (m) => {
  n++;
  console.log('  ok  ' + m);
};

// a chained receipt log at the OLD governor path
const old = join(home, '.enforcer-governor');
mkdirSync(old, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
let prev = 'genesis',
  lines = [];
for (const i of [1, 2, 3]) {
  const body = { ts: `2026-10-05T12:00:0${i}.000Z`, tool: 'Bash', verdict: i === 2 ? 'deny' : 'allow', code: 'x' };
  const hash = sha(prev + JSON.stringify(body));
  prev = hash;
  lines.push(JSON.stringify({ ...body, hash }));
}
writeFileSync(join(old, 'receipts.jsonl'), lines.join('\n') + '\n');
writeFileSync(join(old, 'config.json'), '{"mode":"enforce"}');

const store = await import('../lib/governor/core/store.mjs');
const nu = join(home, '.config', 'enforcer', 'governor');
assert.equal(store.DIR, nu);
ok('governor home defaults to ~/.config/enforcer/governor');
assert.equal(readFileSync(join(nu, 'receipts.jsonl'), 'utf8'), lines.join('\n') + '\n');
ok('the receipt log moved byte for byte');
assert.equal(store.verify().ok, true);
assert.equal(store.verify().receipts, 3);
ok('the moved chain still verifies (3 receipts)');
assert.equal(JSON.parse(readFileSync(join(nu, 'config.json'), 'utf8')).mode, 'enforce');
ok('config moved too');
assert.equal(existsSync(join(old, 'receipts.jsonl')), false);
ok('the old file is gone');
assert.equal(readFileSync(join(old, 'MOVED_TO'), 'utf8').trim(), nu);
ok('a pointer file names the new home');

// second run: nothing moves again, nothing is overwritten
const { migrateDir } = await import('../lib/governor/core/migrate.mjs');
writeFileSync(join(old, 'late.json'), '{}');
assert.deepEqual(migrateDir(old, nu), []);
assert.equal(existsSync(join(nu, 'late.json')), false);
ok('migration runs once');

// session state (the Claude-era state dir -> sessions/claude)
const { stateBase } = await import('../src/state.mjs');
mkdirSync(join(legacyStateDir(), 'runs'), { recursive: true });
writeFileSync(join(legacyStateDir(), 'runs', 'sess1.json'), '{"run_id":"r1"}');
const sb = stateBase();
assert.equal(sb, join(home, '.config', 'enforcer', 'sessions', 'claude'));
assert.equal(JSON.parse(readFileSync(join(sb, 'runs', 'sess1.json'), 'utf8')).run_id, 'r1');
ok('session state moved to sessions/claude');

mkdirSync(join(legacyStateDir(), 'evidence'), { recursive: true });
rmLegacyPointer();
function rmLegacyPointer() {
  try {
    execFileSync('rm', ['-f', join(legacyStateDir(), 'MOVED_TO')]);
  } catch {}
}
writeFileSync(join(legacyStateDir(), 'evidence', 'e.jsonl'), '{}\n');
// no dot-claude string anywhere in the package outside the Claude shims
const grep = execFileSync(
  'bash',
  ['-c', "grep -rn '\\." + "claude' . --include=*.mjs --include=*.sh --exclude-dir=node_modules | grep -v 'hooks/claude/' | wc -l"],
  { cwd: join(import.meta.dirname, '..') },
)
  .toString()
  .trim();
assert.equal(grep, '0');
ok('no dot-claude string outside hooks/claude/');
console.log(`\nmigration: ${n} checks passed`);
