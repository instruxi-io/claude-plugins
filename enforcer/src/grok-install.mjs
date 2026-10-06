// `enforcer harness install grok` / `uninstall grok`.
// The runtime is copied to ~/.config/enforcer/grok/<version> and the hooks point there, so a plugin
// update that prunes the version directory cannot break them. Everything written is listed in a
// manifest; uninstall removes only that. Changed files are backed up with a timestamp.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, cpSync, rmSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { installShim, shimPath } from './shim.mjs';
import { assertSchema, stamp as stampSchema } from './schema.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const rd = (p) => readFileSync(join(root, p), 'utf8');
const version = () => JSON.parse(rd('plugin.json')).version;
const RUNTIME = ['bin', 'hooks', 'lib', 'src', 'agents', 'harness', 'package.json', 'plugin.json'];
// Grok bounds session-end at 1.5 s; the rest get what each hook needs.
const TIMEOUTS = { SessionEnd: 1, SessionStart: 15, PreToolUse: 10, PostToolUse: 10 };
const DEFAULT_TIMEOUT = 10;

// Grok agent from the Claude source: same body, frontmatter reduced to what Grok reads,
// and Claude's mcp__<server>__ tool prefixes rewritten to Grok's enforcer__ names.
export function grokPrefixes(s) {
  return s.replace(/mcp__(?:plugin_enforcer_enforcer|enforcer-graph|enforcer)__/g, 'enforcer__');
}
export function grokAgent(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return grokPrefixes(src);
  const get = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1];
  const lines = ['name', 'description', 'model', 'tools'].map((k) => {
    let v = get(k);
    if (v === undefined || v === '') return null;
    if (k === 'tools') v = [...new Set(grokPrefixes(v).split(/\s*,\s*/))].join(', ');
    return `${k}: ${v}`;
  }).filter(Boolean);
  return `---\n${lines.join('\n')}\n---\n${grokPrefixes(m[2])}`;
}

const HEADER = /^\s*\[\[?\s*[^\]\s][^\]]*\]\]?\s*(#.*)?$/;
function sectionRange(lines, name) {
  const start = lines.findIndex((l) => l.trim().replace(/\s+/g, '') === `[${name}]`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (HEADER.test(lines[i])) { end = i; break; }
  return [start, end];
}
const kv = (lines) => Object.fromEntries(lines.map((l) => l.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));

// Add-only merge. Returns {content, status: 'added'|'unchanged'|'conflict', diff}.
export function mergeMcp(toml, snippet) {
  const want = snippet.split('\n').filter((l) => !l.trim().startsWith('#'));
  const wl = want.filter((l) => l.trim());
  const lines = toml.split('\n');
  const r = sectionRange(lines, 'mcp_servers.enforcer');
  if (!r) {
    const sep = !toml ? '' : toml.endsWith('\n\n') ? '' : toml.endsWith('\n') ? '\n' : '\n\n';
    return { content: toml + sep + wl.join('\n') + '\n', status: 'added', diff: '' };
  }
  const have = kv(lines.slice(r[0] + 1, r[1]));
  const need = kv(wl.slice(1));
  const bad = Object.keys(need).filter((k) => have[k] !== need[k]);
  if (!bad.length) return { content: toml, status: 'unchanged', diff: '' };
  const diff = bad.map((k) => `- ${k} = ${have[k] ?? '(missing)'}\n+ ${k} = ${need[k]}`).join('\n');
  return { content: toml, status: 'conflict', diff };
}
function removeMcp(toml) {
  const lines = toml.split('\n');
  const r = sectionRange(lines, 'mcp_servers.enforcer');
  if (!r) return toml;
  lines.splice(r[0], r[1] - r[0]);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

const paths = (home) => {
  const g = join(home, '.grok'), base = join(home, '.config', 'enforcer', 'grok');
  return { g, base, hooks: join(g, 'hooks', 'enforcer.json'), cfg: join(g, 'config.toml'),
    agent: join(g, 'agents', 'graph-worker.md'), manifest: join(base, 'manifest.json'),
    versionFile: join(base, 'VERSION'), stable: join(base, version()) };
};

function hooksJson(stable) {
  const j = JSON.parse(rd('harness/grok/hooks/enforcer.json'));
  for (const [ev, groups] of Object.entries(j.hooks)) for (const g of groups) for (const h of g.hooks) h.timeout = TIMEOUTS[ev] ?? DEFAULT_TIMEOUT;
  j.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'node "__ENFORCER_ROOT__/hooks/grok/version-check.mjs"', timeout: 5 }] });
  // a Windows path carries backslashes: splice it in JSON-escaped, never raw
  const esc = JSON.stringify(stable).slice(1, -1);
  return JSON.stringify(j, null, 2).replaceAll('__ENFORCER_ROOT__', () => esc) + '\n';
}

export function plan(home = homedir()) {
  const p = paths(home);
  const cur = existsSync(p.cfg) ? readFileSync(p.cfg, 'utf8') : '';
  const merged = mergeMcp(cur, rd('harness/grok/config.toml.snippet'));
  return { p, merged, files: [
    { path: p.hooks, content: hooksJson(p.stable), note: `hooks -> ${p.stable}` },
    { path: p.cfg, content: merged.content, note: 'add [mcp_servers.enforcer]', skip: merged.status === 'conflict', addedSection: merged.status === 'added' },
    { path: p.agent, content: grokAgent(rd('agents/graph-worker.md')), note: 'agent: graph-worker' },
  ] };
}

const ask = (q) => new Promise((res) => { const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }); });
const stamp = () => new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);

export async function install({ dryRun = false, yes = false, home = homedir(), confirm = ask, out = (s) => process.stdout.write(s + '\n') } = {}) {
  const { p, merged, files } = plan(home);
  const changed = (f) => !existsSync(f.path) || readFileSync(f.path, 'utf8') !== f.content;
  if (merged.status === 'conflict') {
    out(`refusing to change ${p.cfg}: [mcp_servers.enforcer] exists and differs from what enforcer needs:\n${merged.diff}\nEdit it by hand (or remove the section) and rerun.`);
    return { ok: false, reason: 'conflict', diff: merged.diff };
  }
  out(`runtime -> ${p.stable}${existsSync(p.stable) ? ' (exists, refreshed)' : ''}`);
  for (const f of files) out(`${dryRun ? 'would write' : changed(f) ? 'will write' : 'unchanged'} ${f.path}  (${f.note})${!dryRun && changed(f) && existsSync(f.path) ? ' [backup]' : ''}`);
  out(`${dryRun ? 'would write' : 'will write'} ${shimPath(home)}  (enforcer shim)`);
  out(`${dryRun ? 'would write' : 'will write'} ${p.manifest}`);
  if (dryRun) return { ok: true, dryRun: true };
  if (!yes && !(await confirm('Proceed? [y/N] '))) { out('aborted; nothing written'); return { ok: false, reason: 'declined' }; }

  mkdirSync(p.stable, { recursive: true });
  for (const e of RUNTIME) cpSync(join(root, e), join(p.stable, e), { recursive: true, force: true,
    filter: (s) => !/(^|\/)(node_modules|\.git|test)(\/|$)/.test(s.slice(root.length)) });
  writeFileSync(p.versionFile, version() + '\n');
  const shim = installShim({ home, base: p.base, out });
  const prev = existsSync(p.manifest) ? assertSchema(JSON.parse(readFileSync(p.manifest, 'utf8')), p.manifest) : null;
  const written = [], backups = [];
  for (const f of files) {
    written.push(f.path);
    if (!changed(f)) continue;
    mkdirSync(dirname(f.path), { recursive: true });
    if (existsSync(f.path)) { const b = `${f.path}.enforcer-bak-${stamp()}`; copyFileSync(f.path, b); backups.push(b); out(`backup ${b}`); }
    writeFileSync(f.path, f.content);
    out(`wrote ${f.path}`);
  }
  const cfgAdded = files[1].addedSection || (prev?.configSectionAdded ?? false);
  mkdirSync(dirname(p.manifest), { recursive: true });
  const man = { version: version(), runtime: p.stable, versionFile: p.versionFile, files: [...written.filter((x) => x !== p.cfg), shim],
    config: p.cfg, configSectionAdded: cfgAdded };
  const text = JSON.stringify(stampSchema(man), null, 2) + '\n';
  if (!existsSync(p.manifest) || readFileSync(p.manifest, 'utf8') !== text) writeFileSync(p.manifest, text);
  return { ok: true, backups };
}

export async function uninstall({ dryRun = false, yes = false, home = homedir(), confirm = ask, out = (s) => process.stdout.write(s + '\n') } = {}) {
  const p = paths(home);
  if (!existsSync(p.manifest)) { out('no install manifest; nothing to remove'); return { ok: true, removed: [] }; }
  const man = assertSchema(JSON.parse(readFileSync(p.manifest, 'utf8')), p.manifest);
  const targets = [...man.files, man.runtime, man.versionFile];
  for (const t of targets) out(`${dryRun ? 'would remove' : 'will remove'} ${t}`);
  if (man.configSectionAdded && existsSync(man.config)) out(`${dryRun ? 'would remove' : 'will remove'} [mcp_servers.enforcer] from ${man.config}`);
  if (dryRun) return { ok: true, dryRun: true };
  if (!yes && !(await confirm('Proceed? [y/N] '))) { out('aborted; nothing removed'); return { ok: false, reason: 'declined' }; }
  const removed = [];
  for (const t of targets) if (existsSync(t)) { rmSync(t, { recursive: true, force: true }); removed.push(t); }
  if (man.configSectionAdded && existsSync(man.config)) {
    const cur = readFileSync(man.config, 'utf8'), next = removeMcp(cur);
    if (next !== cur) { copyFileSync(man.config, `${man.config}.enforcer-bak-${stamp()}`); writeFileSync(man.config, next); removed.push(man.config + ' [mcp_servers.enforcer]'); }
  }
  rmSync(p.manifest, { force: true }); removed.push(p.manifest);
  try { rmdirSync(p.base); } catch { /* not empty: not ours */ }
  out(`removed ${removed.length} item(s)`);
  return { ok: true, removed };
}
