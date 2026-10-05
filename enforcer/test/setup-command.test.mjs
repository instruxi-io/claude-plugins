// /enforcer:setup shows the plan and applies only on the person's confirmation.
// A command is a prompt, so what is testable is its contract: the tools it may
// use without asking, and the order it gives.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const cmd = readFileSync(new URL('../commands/setup.md', import.meta.url), 'utf8');
const fm = cmd.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const body = readFileSync(new URL('../skills/enforcer/setup.md', import.meta.url), 'utf8');
const allowed = (fm.match(/^allowed-tools:\s*(.+)$/m)?.[1] ?? '').split(/[,\s]+/).filter(Boolean);
let n = 0;
const ok = (s) => { n++; console.log(`ok   ${s}`); };

assert.match(fm, /^description: .+/m); ok('has a description');
assert.ok(allowed.includes('mcp__plugin_enforcer_enforcer__enforcer_setup_plan'), 'plan pre-allowed'); ok('the plan (a read) runs without a prompt');
assert.ok(!allowed.some((t) => /setup_apply|api_write|Write|Edit|Bash/.test(t)), `nothing that writes is pre-allowed: ${allowed}`);
ok('nothing that writes is pre-allowed (enforcer_setup_apply, Write, Edit, Bash all ask)');

const at = (re) => { const i = body.search(re); assert.ok(i >= 0, `missing ${re}`); return i; };
const plan = at(/Call `enforcer_setup_plan`/);
const show = at(/## 2\. Show the plan/);
const ask = at(/\*\*"Apply this\?/);
const stop = at(/STOP\. End your turn there and wait for their answer/);
const apply = at(/call `enforcer_setup_apply`/);
assert.ok(plan < show && show < ask && ask < stop && stop < apply, 'order: plan, show, ask, stop, apply');
ok('order: plan -> show -> ask -> stop -> apply');
assert.ok(body.indexOf('enforcer_setup_apply') >= ask, 'apply is not mentioned as an action before the question'); ok('apply appears only after the question');
assert.match(body, /\*\*no\*\*, or anything else: apply nothing/); ok('anything but a yes applies nothing');
assert.match(body, /permissions_allow/); assert.match(body, /plugin_commands/); ok('shows the allow rules and the plugin commands from the plan');
assert.match(body, /Do not run these yourself/); ok('plugin commands are the person\'s to run');
assert.match(body, /never edit `~\/\.claude\/settings\.json`/); ok('writes only the project settings file');
console.log(`\nsetup-command: ${n} checks passed`);
