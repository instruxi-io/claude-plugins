import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const u = (p) => new URL(`../${p}`, import.meta.url);
const hooks = JSON.parse(readFileSync(u('hooks/hooks.json'), 'utf8')).hooks;
for (const e of ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop']) {
  const cmd = hooks[e]?.[0]?.hooks?.[0]?.command ?? '';
  const m = cmd.match(/hooks\/claude\/(governor-[a-z-]+\.mjs)/);
  assert.ok(m && existsSync(u(`hooks/claude/${m[1]}`)), `${e} calls a hooks/claude shim`);
}
console.log('ok   hooks.json wires the governor\'s 7 events to hooks/claude shims');
const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1', cwd: '/tmp' };
const r = spawnSync(process.execPath, [new URL('../bin/enforcer', import.meta.url).pathname, 'governor', 'decide'],
  { input: JSON.stringify(ev), encoding: 'utf8', env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'gov-')) } });
assert.equal(r.status, 0, r.stderr);
const rec = JSON.parse(r.stdout);
assert.deepEqual(Object.keys(rec).sort(), ['code', 'decision', 'rule', 'summary', 'tool']);
console.log('ok   bin/enforcer governor decide prints a decision record');
console.log('\ngovernor-wiring: passed');
