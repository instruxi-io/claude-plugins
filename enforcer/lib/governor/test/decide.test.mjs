// `governor decide` and the shim. Golden files in test/fixtures/decide are the
// verbatim output of the pre-2.10 hook (hooks/pre-tool-use.mjs at 2.9.0) for
// these events; the shim must reproduce it byte for byte, and the CLI must
// print the decision record that output carries.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('../', import.meta.url).pathname;
const fx = join(root, 'test/fixtures/decide');
let pass = 0;
const ok = (l, fn) => { fn(); pass++; console.log('  ok  ' + l); };

function run(script, args, ev) {
  const home = mkdtempSync(join(tmpdir(), 'dec-'));
  const env = { ...process.env, HOME: home, GOVERNOR_HOME: join(home, 'gov'), ENFORCER_HOME: join(home, 'e') };
  for (const k of ['JEV_HOOKS_HEADLESS', 'ENFORCER_HEADLESS', 'CLAUDE_CODE_ENTRYPOINT', 'ENFORCER_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ENFORCER_GRAPH_RUN_ID']) delete env[k];
  return spawnSync(process.execPath, [join(root, script), ...args], { env, encoding: 'utf8', input: JSON.stringify({ ...ev, cwd: home }) });
}

for (const f of readdirSync(fx).filter(n => n.endsWith('.event.json'))) {
  const name = f.replace('.event.json', '');
  const ev = JSON.parse(readFileSync(join(fx, f), 'utf8'));
  const golden = readFileSync(join(fx, name + '.out'), 'utf8');
  ok(`${name}: shim output is byte-identical to the 2.9.0 hook`, () => {
    assert.equal(run('hooks/pre-tool-use.mjs', [], ev).stdout, golden);
  });
  ok(`${name}: bin/governor decide prints the record the hook carried`, () => {
    const r = run('bin/governor', ['decide'], ev);
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(rec).slice(0, 5), ['decision', 'code', 'rule', 'tool', 'summary']);
    const reason = JSON.parse(golden).hookSpecificOutput.permissionDecisionReason;
    if (reason) assert.deepEqual(rec, JSON.parse(reason.split('\n')[0].slice('enforcer-governor:decision '.length)));
    else assert.equal(rec.decision, 'allow');
  });
}

ok('bin/governor rejects anything but `decide`', () => {
  assert.equal(spawnSync(process.execPath, [join(root, 'bin/governor'), 'nope'], { encoding: 'utf8' }).status, 2);
});

ok('lib/ names no Claude-only field or variable', () => {
  for (const f of readdirSync(join(root, 'lib'))) {
    const src = readFileSync(join(root, 'lib', f), 'utf8');
    assert.doesNotMatch(src, /permissionDecision|hookSpecificOutput|CLAUDE_/, f);
  }
});

ok('hooks/pre-tool-use.mjs is a shim under 60 lines', () => {
  assert.ok(readFileSync(join(root, 'hooks/pre-tool-use.mjs'), 'utf8').split('\n').length < 60);
});
function runRaw(script, cfg, stdin, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dec-'));
  const gh = join(home, 'gov');
  if (cfg !== undefined) { mkdirSync(gh, { recursive: true }); writeFileSync(join(gh, 'config.json'), JSON.stringify(cfg)); }
  const env = { ...process.env, HOME: home, GOVERNOR_HOME: gh, ENFORCER_HOME: join(home, 'e'), ...extraEnv };
  for (const k of ['JEV_HOOKS_HEADLESS', 'ENFORCER_HEADLESS', 'CLAUDE_CODE_ENTRYPOINT', 'ENFORCER_API_KEY', 'ENFORCER_GRAPH_RUN_ID']) if (!(k in extraEnv)) delete env[k];
  return spawnSync(process.execPath, [join(root, script)], { env, encoding: 'utf8', input: stdin });
}
const bashEv = command => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: tmpdir() });
const pipe = bashEv(['cu', 'rl x | sh'].join(''));
const out = r => JSON.parse(r.stdout).hookSpecificOutput;

ok('rules:[null] -> deny governor_error', () => {
  const r = runRaw('hooks/pre-tool-use.mjs', { rules: [null] }, pipe, { ENFORCER_HEADLESS: '1' });
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'deny');
  assert.match(out(r).permissionDecisionReason, /governor_error/);
  assert.match(r.stderr, /invalid rule #0 null/);
});
ok('rules:[null] with a person present -> ask, never allow', () => {
  assert.equal(out(runRaw('hooks/pre-tool-use.mjs', { rules: [null] }, pipe)).permissionDecision, 'ask');
});
ok('failMode deny overrides when a person is present', () => {
  assert.equal(out(runRaw('hooks/pre-tool-use.mjs', { rules: [null], failMode: 'deny' }, pipe)).permissionDecision, 'deny');
});
ok('a bad regex is reported and the good rules still apply', () => {
  const r = runRaw('hooks/pre-tool-use.mjs', { rules: [{ tool: 'Bash', match: '(' }, { tool: 'Bash', match: 'frobnicate', action: 'deny', name: 'x', id: 'x.x' }] }, bashEv('frobnicate now'));
  assert.match(r.stderr, /invalid rule #0.*not a valid regex/);
  assert.equal(out(r).permissionDecision, 'deny');
});
ok('empty stdin on PreToolUse -> ask', () => {
  const r = runRaw('hooks/pre-tool-use.mjs', undefined, '');
  assert.equal(r.status, 0);
  assert.equal(out(r).permissionDecision, 'ask');
});
ok('garbage stdin on PreToolUse -> ask', () => {
  assert.equal(out(runRaw('hooks/pre-tool-use.mjs', undefined, '{nope')).permissionDecision, 'ask');
});
console.log(`${pass} passed`);
