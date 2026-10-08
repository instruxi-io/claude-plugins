import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const u = (p) => new URL(`../${p}`, import.meta.url);
const hooks = JSON.parse(readFileSync(u('hooks/hooks.json'), 'utf8')).hooks;
for (const e of ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart']) {
  const cmd = hooks[e]?.[0]?.hooks?.[0]?.command ?? '';
  assert.match(cmd, /bin\/enforcer" event [a-z-]+$/, `${e} runs the single per-event process`);
}
// every command has a timeout, and no event runs more than one command
for (const [e, groups] of Object.entries(hooks)) {
  const cmds = groups.flatMap((g) => g.hooks);
  assert.equal(cmds.length, 1, `${e}: one command`);
  assert.ok(cmds[0].timeout > 0, `${e}: timeout set`);
}
console.log('ok   hooks.json runs one `enforcer event` process per event, each with a timeout');
const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1', cwd: '/tmp' };
const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/enforcer', import.meta.url)), 'governor', 'decide'], {
  input: JSON.stringify(ev),
  encoding: 'utf8',
  env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'gov-')) },
});
assert.equal(r.status, 0, r.stderr);
const rec = JSON.parse(r.stdout);
assert.deepEqual(Object.keys(rec).sort(), ['code', 'decision', 'rule', 'summary', 'tool']);
console.log('ok   bin/enforcer governor decide prints a decision record');
console.log('\ngovernor-wiring: passed');
