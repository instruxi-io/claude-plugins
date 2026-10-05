// The allowlist check fails on a deliberately renamed tool and passes otherwise.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'test', 'check-allowlist.mjs');
const run = (...a) => spawnSync('node', [script, ...a], { encoding: 'utf8' });
const copy = () => {
  const d = mkdtempSync(join(tmpdir(), 'allowlist-'));
  for (const p of ['enforcer/docs/graph/settings.example.json', 'enforcer/agents/graph-worker.md',
    'enforcer/hooks/hooks.json', 'enforcer/commands/setup.md', 'test/fixtures/mcp-tool-names.json']) {
    cpSync(join(repo, p), join(d, p), { recursive: true });
  }
  return d;
};
let n = 0;
const ok = (name) => { n++; console.log(`ok   ${name}`); };

let r = run();
assert.equal(r.status, 0, r.stderr); ok('the repo as it is passes');

// A rule renamed on OUR side (a typo, or a tool name copied from an old doc).
let d = copy();
let f = join(d, 'enforcer/docs/graph/settings.example.json');
writeFileSync(f, readFileSync(f, 'utf8').replace('mcp__plugin_enforcer_enforcer__graph_heartbeat', 'mcp__plugin_enforcer_enforcer__graph_heartbeat_v2'));
r = run('--root', d);
assert.equal(r.status, 1); assert.match(r.stderr, /graph_heartbeat_v2" is not a tool/); ok('a renamed allow rule fails');

// The SERVER renames a tool: the manifest no longer has graph_report.
d = copy();
f = join(d, 'test/fixtures/mcp-tool-names.json');
const m = JSON.parse(readFileSync(f, 'utf8'));
m.tools = m.tools.map((t) => (t.name === 'graph_report' ? { ...t, name: 'graph_complete' } : t));
writeFileSync(f, JSON.stringify(m));
r = run('--root', d);
assert.equal(r.status, 1); assert.match(r.stderr, /"graph_report" is not a tool/);
assert.match(r.stderr, /hooks\.json/); ok('a tool the server renamed fails, hook matchers included');

// A rule under a server name nobody registers.
d = copy();
f = join(d, 'enforcer/agents/graph-worker.md');
writeFileSync(f, readFileSync(f, 'utf8').replace('mcp__enforcer__graph_report', 'mcp__enforcr__graph_report'));
r = run('--root', d);
assert.equal(r.status, 1); assert.match(r.stderr, /not under a known enforcer server prefix/); ok('an unknown server prefix fails');

console.log(`\ncheck-allowlist: ${n} checks passed`);
