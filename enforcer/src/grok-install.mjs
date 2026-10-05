// `enforcer harness install grok`: hooks into ~/.grok/hooks, the MCP section into
// ~/.grok/config.toml (idempotent, backed up first), the worker agent into ~/.grok/agents.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const rd = (p) => readFileSync(join(root, p), 'utf8');

// Grok agent from the Claude source: same body, frontmatter reduced to what Grok reads.
export function grokAgent(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const get = (k) => (m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || '';
  return `---\nname: ${get('name')}\ndescription: ${get('description')}\n---\n${m[2]}`;
}

export function mergeMcp(toml, snippet) {
  const body = snippet.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim() + '\n';
  const re = /^\[mcp_servers\.enforcer\]\n(?:(?!\[).*\n?)*/m;
  if (re.test(toml)) return toml.replace(re, body + (toml.match(re)[0].endsWith('\n\n') ? '\n' : ''));
  return toml + (toml && !toml.endsWith('\n\n') ? (toml.endsWith('\n') ? '\n' : '\n\n') : '') + body;
}

export function plan(home = homedir()) {
  const g = join(home, '.grok');
  const hooks = rd('harness/grok/hooks/enforcer.json').replaceAll('__ENFORCER_ROOT__', root);
  const cfg = join(g, 'config.toml');
  const cur = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
  return [
    { path: join(g, 'hooks', 'enforcer.json'), content: hooks, note: 'hooks: governor + graph worker (shim.mjs)' },
    { path: cfg, content: mergeMcp(cur, rd('harness/grok/config.toml.snippet')), note: 'merge [mcp_servers.enforcer]', backup: existsSync(cfg) },
    { path: join(g, 'agents', 'graph-worker.md'), content: grokAgent(rd('agents/graph-worker.md')), note: 'agent: graph-worker' },
  ];
}

export function install({ dryRun = false, home = homedir(), out = (s) => process.stdout.write(s + '\n') } = {}) {
  for (const f of plan(home)) {
    const same = existsSync(f.path) && readFileSync(f.path, 'utf8') === f.content;
    out(`${dryRun ? 'would write' : same ? 'unchanged' : 'write'} ${f.path}  (${f.note})`);
    if (dryRun || same) continue;
    mkdirSync(dirname(f.path), { recursive: true });
    if (f.backup) copyFileSync(f.path, `${f.path}.enforcer-bak`);
    writeFileSync(f.path, f.content);
  }
}
