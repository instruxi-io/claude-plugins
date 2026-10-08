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
  for (const p of [
    'enforcer/docs/graph/settings.example.json',
    'enforcer/agents/graph-worker.md',
    'enforcer/hooks/hooks.json',
    'enforcer/src/event.mjs',
    'enforcer/commands',
    'enforcer/skills',
    'enforcer/harness/grok/hooks/enforcer.json',
    'enforcer/harness/grok/agents',
    'enforcer/lib/api/spec/mcp-manifest.json',
  ]) {
    cpSync(join(repo, p), join(d, p), { recursive: true });
  }
  return d;
};
let n = 0;
const ok = (name) => {
  n++;
  console.log(`ok   ${name}`);
};

let r = run();
assert.equal(r.status, 0, r.stderr);
ok('every allowlisted tool is in the locked manifest');
assert.doesNotMatch(r.stdout, /profile-only/);

// A rule renamed on OUR side (a typo, or a tool name copied from an old doc).
let d = copy();
let f = join(d, 'enforcer/docs/graph/settings.example.json');
writeFileSync(f, readFileSync(f, 'utf8').replace('mcp__plugin_enforcer_enforcer__graph_heartbeat', 'mcp__plugin_enforcer_enforcer__graph_heartbeat_v2'));
r = run('--root', d);
assert.equal(r.status, 1);
assert.match(r.stderr, /graph_heartbeat_v2" is not a tool/);
ok('a renamed allow rule fails');

// The SERVER renames a tool: the manifest no longer has graph_report.
d = copy();
f = join(d, 'enforcer/lib/api/spec/mcp-manifest.json');
const m = JSON.parse(readFileSync(f, 'utf8'));
m.tools = m.tools.map((t) => (t.name === 'graph_report' ? { ...t, name: 'graph_complete' } : t));
writeFileSync(f, JSON.stringify(m));
r = run('--root', d);
assert.equal(r.status, 1);
assert.match(r.stderr, /"graph_report" is not a tool/);
assert.match(r.stderr, /hooks\.json/);
ok('a tool the server renamed fails, hook matchers included');

// A rule under a server name nobody registers.
d = copy();
f = join(d, 'enforcer/agents/graph-worker.md');
writeFileSync(f, readFileSync(f, 'utf8').replace('mcp__enforcer__graph_report', 'mcp__enforcr__graph_report'));
r = run('--root', d);
assert.equal(r.status, 1);
assert.match(r.stderr, /not under a known enforcer server prefix/);
ok('an unknown server prefix fails');

// A command's allowed-tools other than setup.md.
d = copy();
f = join(d, 'enforcer/commands/workspace.md');
writeFileSync(f, readFileSync(f, 'utf8').replace('enforcer_whoami', 'enforcer_whoami_v2'));
r = run('--root', d);
assert.equal(r.status, 1);
assert.match(r.stderr, /workspace\.md/);
ok('a renamed tool in any command fails');

// A tool only a non-default profile serves is flagged, not failed.
d = copy();
f = join(d, 'enforcer/lib/api/spec/mcp-manifest.json');
const pm = JSON.parse(readFileSync(f, 'utf8'));
pm.tools = pm.tools.map((t) => (t.name === 'graph_report' ? { ...t, profiles: ['workflow'] } : t));
writeFileSync(f, JSON.stringify(pm));
r = run('--root', d);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /profile-only: graph_report .*not served by the graph profile/);
r = run('--root', d, '--profile', 'workflow');
assert.doesNotMatch(r.stdout, /profile-only/);
ok('profile-only tools are flagged');

// Tool results against the generated schemas (the pinned graph spec).
const spec = JSON.parse(readFileSync(join(repo, 'enforcer/lib/api/spec/graph.json'), 'utf8'));
const deref = (s) => (s.$ref ? spec.components.schemas[s.$ref.split('/').pop()] : s);
const check = (v, s, at = '$') => {
  s = deref(s);
  const t = s.type;
  if (t === 'object') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return [`${at}: want object`];
    return Object.entries(s.properties ?? {})
      .flatMap(([k, ps]) => (k in v ? check(v[k], ps, `${at}.${k}`) : []))
      .concat((s.required ?? []).filter((k) => !(k in v)).map((k) => `${at}.${k}: required`));
  }
  if (t === 'array') return Array.isArray(v) ? v.flatMap((x, i) => check(x, s.items ?? {}, `${at}[${i}]`)) : [`${at}: want array`];
  if (t === 'integer') return Number.isInteger(v) ? [] : [`${at}: want integer`];
  if (t === 'string' || t === 'boolean') return typeof v === t ? [] : [`${at}: want ${t}`];
  return [];
};
const opResponse = (path) => spec.paths[path].post.responses['200'].content['application/json'].schema;
const claimed = {
  node_id: 'd82ceb14',
  key: 'k',
  title: 't',
  run_id: 'r1',
  attempt: 1,
  epoch: 1,
  run_status: 'running',
  lease_expires_at: '2026-10-06T18:24:45Z',
  acceptance: ['a'],
  skills: [],
  observations: [],
  inputs: {},
  data: {},
};
const nextWork = { success: true, data: [claimed], remaining: 0 };
const claimPath = Object.keys(spec.paths).find((p) => /\/claim$/.test(p) && spec.paths[p].post);
const claimSchema = claimPath ? opResponse(claimPath) : { $ref: '#/components/schemas/internal_runs.ClaimResponse' };
assert.deepEqual(check(nextWork, claimSchema), []);
assert.deepEqual(check({ ...nextWork, data: [{ ...claimed, attempt: 'one' }] }, claimSchema), ['$.data[0].attempt: want integer']);
ok('next_work result matches its schema');

const hb = { success: true, data: { run_id: 'r1', attempt: 1, run_status: 'running', state: 'ok', lease_expires_at: '2026-10-06T18:24:47Z' } };
const hbSchema = { $ref: '#/components/schemas/internal_runs.HeartbeatResponse' };
assert.deepEqual(check(hb, hbSchema), []);
assert.deepEqual(check({ ...hb, data: { ...hb.data, run_id: 7 } }, hbSchema), ['$.data.run_id: want string']);
ok('heartbeat result matches its schema');

console.log(`\ncheck-allowlist: ${n} checks passed`);
