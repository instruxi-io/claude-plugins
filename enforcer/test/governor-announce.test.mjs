// The governor announces itself: SessionStart sets ENFORCER_GOVERNOR=1 so other hook packs never read the plugin cache.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const ev = JSON.stringify({ hook_event_name: 'SessionStart', session_id: '', cwd: tmpdir() });
const home = mkdtempSync(join(tmpdir(), 'gov-announce-'));
const envFile = join(home, 'env'); writeFileSync(envFile, '');
const env = { ...process.env, HOME: home, CLAUDE_ENV_FILE: envFile, ENFORCER_GOVERNOR: '' };
const go = (args) => spawnSync(process.execPath, args, { input: ev, env, encoding: 'utf8' });
for (const [name, args] of [['claude', [join(root, 'hooks/claude/governor-session-start.mjs')]],
  ['codex', [join(root, 'hooks/claude/governor-session-start.mjs')]],
  ['grok', [join(root, 'hooks/grok/shim.mjs'), 'governor-session-start.mjs']]]) {
  writeFileSync(envFile, '');
  const r = go(args);
  assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.env.ENFORCER_GOVERNOR, '1', `${name} output`);
  assert.match(readFileSync(envFile, 'utf8'), /export ENFORCER_GOVERNOR=1/, `${name} env file`);
}
writeFileSync(envFile, '');
go([join(root, 'bin/enforcer'), 'hook', 'session-start']);
assert.match(readFileSync(envFile, 'utf8'), /export ENFORCER_GOVERNOR=1/, 'bin/enforcer hook session-start');
console.log('governor-announce ok');
