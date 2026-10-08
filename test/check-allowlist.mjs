#!/usr/bin/env node
// Every MCP tool name this repo pre-approves or routes must be a tool the
// enforcer MCP server actually registers. A renamed tool otherwise fails
// silently: the allow rule matches nothing, so every call prompts a person
// (and a headless worker is denied and its node reclaimed), and a hook matcher
// on the old name simply never fires.
//
// The truth is the MCP manifest locked with the other pinned specs
// (enforcer/lib/api/spec/mcp-manifest.json, pinned by enforcer/lib/api/spec.lock.json;
// `npm run sync:spec` in enforcer refreshes it). One copy: there is no vendored
// fixture and no token-gated soft step, so CI always checks the locked one, and
// the contract tests catch the lock drifting from the live server.
//
// Tools the default profile does not serve are listed as warnings: a rule for
// them is valid but matches nothing under that profile.
//
//   node test/check-allowlist.mjs                    locked manifest, profile graph
//   node test/check-allowlist.mjs --manifest <file>  another manifest
//   node test/check-allowlist.mjs --profile <name>   the profile whose tools are served
//   node test/check-allowlist.mjs --root <dir>       check another checkout (the tests use this)
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const root = arg('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = arg('--manifest') ?? join(root, 'enforcer', 'lib', 'api', 'spec', 'mcp-manifest.json');
const profile = arg('--profile') ?? 'graph';

// The names the enforcer server's tools reach Claude Code under: the enforcer
// plugin's, one added by hand as `enforcer`, and the older `enforcer-graph`.
const PREFIXES = ['mcp__plugin_enforcer_enforcer__', 'mcp__enforcer__', 'mcp__enforcer-graph__', 'enforcer__'];

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const registered = new Set((manifest.tools ?? []).map((t) => t.name));
const served = new Set((manifest.tools ?? []).filter((t) => (t.profiles ?? []).includes(profile)).map((t) => t.name));
if (registered.size === 0) { console.error(`FAIL ${manifestPath}: no tools in the manifest`); process.exit(1); }

const read = (p) => readFileSync(join(root, p), 'utf8');
const sources = []; // [where, name]

// 1. The allow rules a person copies (and /enforcer:setup offers).
for (const rule of JSON.parse(read('enforcer/docs/graph/settings.example.json')).permissions.allow) {
  sources.push(['enforcer/docs/graph/settings.example.json', rule]);
}
// 2. The worker agent's tool allowlist (frontmatter `tools:`).
const agent = read('enforcer/agents/graph-worker.md').match(/^tools:\s*(.+)$/m)?.[1] ?? '';
for (const t of agent.split(',').map((s) => s.trim()).filter((s) => s.startsWith('mcp__'))) {
  sources.push(['enforcer/agents/graph-worker.md tools', t]);
}
// 3. `allowed-tools:` / `tools:` frontmatter of every command, skill and agent in every local plugin.
const listFiles = (d) => existsSync(join(root, d)) ? readdirSync(join(root, d), { withFileTypes: true }) : [];
const fm = [];
for (const e of listFiles('enforcer/commands')) if (e.name.endsWith('.md')) fm.push(`enforcer/commands/${e.name}`);
for (const e of listFiles('enforcer/skills')) if (e.isDirectory()) fm.push(`enforcer/skills/${e.name}/SKILL.md`);
for (const e of listFiles('enforcer/agents')) if (e.name.endsWith('.md')) fm.push(`enforcer/agents/${e.name}`);
for (const e of listFiles('enforcer/harness/grok/agents')) if (e.name.endsWith('.md')) fm.push(`enforcer/harness/grok/agents/${e.name}`);
for (const f of fm) {
  if (!existsSync(join(root, f))) continue;
  const head = read(f).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const at = head.match(/^(?:allowed-tools|tools):\s*(.+)$/m)?.[1] ?? '';
  for (const t of at.split(/[,\s]+/).filter((s) => /^(mcp__|enforcer__)/.test(s))) sources.push([`${f} tools`, t]);
}
// 3b. Grok hook matchers (names without the mcp__ plugin prefix): enforcer__graph_(a|b|c).
let grokMatchers = 0;
const grokHooks = existsSync(join(root, 'enforcer/harness/grok/hooks/enforcer.json')) ? JSON.parse(read('enforcer/harness/grok/hooks/enforcer.json')).hooks : {};
for (const [event, groups] of Object.entries(grokHooks)) {
  for (const g of groups) {
    const m = (g.matcher ?? '').match(/^enforcer__graph_\(([^)]+)\)$/);
    if (g.matcher && !m) { console.error(`FAIL grok ${event}: matcher ${g.matcher} is not enforcer__graph_(...)`); process.exit(1); }
    if (m) for (const t of m[1].split('|')) { sources.push([`enforcer/harness/grok/hooks/enforcer.json ${event}`, `enforcer__graph_${t}`]); grokMatchers++; }
  }
}
// The Grok template runs one `enforcer event` command per event; the graph-tool matchers live in enforcer/src/event.mjs.
// 4. Hook matchers: each alternative of a graph_(a|b|c) group is a tool name.
const hooks = JSON.parse(read('enforcer/hooks/hooks.json')).hooks;
for (const [event, groups] of Object.entries(hooks)) {
  for (const g of groups) {
    const m = (g.matcher ?? '').match(/__graph_\(([^)]+)\)$/);
    if (m) for (const t of m[1].split('|')) sources.push([`enforcer/hooks/hooks.json ${event}`, `${PREFIXES[0]}graph_${t}`]);
  }
}
// The per-event runner holds the graph-tool matchers now (hooks.json routes every tool to it).
for (const m of read('enforcer/src/event.mjs').matchAll(/^const (\w+_GRAPH) = .*__graph_\(([^)]+)\)\$\//gm)) {
  for (const t of m[2].split('|')) sources.push([`enforcer/src/event.mjs ${m[1]} (the hooks.json matchers)`, `${PREFIXES[0]}graph_${t}`]);
}

let bad = 0;
for (const [where, name] of sources) {
  const pre = PREFIXES.find((p) => name.startsWith(p));
  if (!pre) { console.error(`FAIL ${where}: ${name} is not under a known enforcer server prefix (${PREFIXES.join(', ')})`); bad++; continue; }
  const tool = name.slice(pre.length);
  if (!registered.has(tool)) { console.error(`FAIL ${where}: ${name} - "${tool}" is not a tool in ${manifestPath}`); bad++; }
}
if (bad) { console.error(`\n${bad} tool name(s) the MCP server does not register. Rename them to match, or regenerate the manifest if the server changed.`); process.exit(1); }
const profileOnly = new Set();
for (const [where, name] of sources) {
  const tool = name.slice(PREFIXES.find((p) => name.startsWith(p)).length);
  if (!served.has(tool)) profileOnly.add(`${tool} (${where})`);
}
for (const w of profileOnly) console.log(`profile-only: ${w} is not served by the ${profile} profile`);
for (const [w, n] of sources) if (w.includes('grok/hooks')) console.log(`grok matcher checked: ${n} (${w})`);
console.log(`OK  ${sources.length} allow rules / tool names checked against ${registered.size} tools in ${manifestPath}`);
