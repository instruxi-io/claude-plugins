// The hooks/claude shims fed Codex-shaped stdin (same field names plus turn_id,
// model, permission_mode). Fixtures are in test/fixtures/codex (see its README:
// not recorded from a live Codex run).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const fx = (n) => readFileSync(join(root, 'test/fixtures/codex', n), 'utf8');
const home = mkdtempSync(join(tmpdir(), 'codex-shim-'));
const run = (shim, input) => spawnSync(process.execPath, [join(root, 'hooks/claude', shim)],
  { input, encoding: 'utf8', env: { ...process.env, HOME: home, ENFORCER_HOME: home, GOVERNOR_HOME: join(home, 'g') } });
let n = 0; const ok = (m) => { n++; console.log('  ok  ' + m); };

let r = run('governor-pre-tool-use.mjs', fx('pre-tool-use-allow.json'));
assert.equal(r.status, 0, r.stderr);
const allow = JSON.parse(r.stdout);
assert.equal(allow.hookSpecificOutput.hookEventName, 'PreToolUse');
assert.equal(allow.hookSpecificOutput.permissionDecision, undefined); ok('PreToolUse allow: exit 0, no objection');

r = run('governor-pre-tool-use.mjs', fx('pre-tool-use-deny.json'));
assert.equal(r.status, 0, r.stderr);
const deny = JSON.parse(r.stdout).hookSpecificOutput;
assert.equal(deny.permissionDecision, 'deny');
assert.match(deny.permissionDecisionReason, /pipe_to_shell/); ok('PreToolUse deny: permissionDecision deny, code pipe_to_shell');

for (const [f, shims] of [['permission-request.json', ['governor-pre-tool-use.mjs', 'governor-post-tool-use.mjs']],
  ['post-compact.json', ['governor-pre-tool-use.mjs', 'governor-session-start.mjs', 'governor-user-prompt-submit.mjs']],
  ['interrupt.json', ['governor-pre-tool-use.mjs', 'governor-post-tool-use.mjs', 'governor-session-end.mjs', 'governor-subagent-stop.mjs']]]) {
  for (const s of shims) {
    r = run(s, fx(f));
    assert.equal(r.status, 0, `${s} ${f}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${s} ignores ${f} (prints nothing)`);
  }
  ok(`${f.replace('.json', '')} is ignored cleanly (exit 0, no output)`);
}

const plugin = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
assert.equal(plugin.extensions['com.openai'].hooks, './hooks/hooks.json');
assert.ok(plugin.extensions['com.openai'].interface.displayName); ok('plugin.json carries extensions.com.openai');
const mk = JSON.parse(readFileSync(join(root, '../.agents/plugins/marketplace.json'), 'utf8'));
assert.ok(mk.plugins.some((p) => p.name === 'enforcer' && p.source === './enforcer')); ok('.agents/plugins/marketplace.json lists enforcer');
console.log(`\ncodex-shims: ${n} checks passed`);
