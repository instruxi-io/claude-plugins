// Validates plugin.json against the vendored Agent Plugins 1.0 schema (draft 2020-12 subset the
// schema uses: type, const, required, properties, additionalProperties, items, minLength,
// maxLength, pattern) and checks every version string in the package is identical.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { DOT } from '../hooks/claude/paths.mjs';
const rd = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('./fixtures/agent-plugins-1.0.0.plugin.schema.json', import.meta.url), 'utf8'));

function validate(s, v, path = '$') {
  const errs = [];
  if (s.type) {
    const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    if (t !== s.type) return [`${path}: expected ${s.type}, got ${t}`];
  }
  if ('const' in s && v !== s.const) errs.push(`${path}: must equal ${s.const}`);
  if (typeof v === 'string') {
    if (s.minLength && v.length < s.minLength) errs.push(`${path}: too short`);
    if (s.maxLength && v.length > s.maxLength) errs.push(`${path}: too long`);
    if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${path}: pattern ${s.pattern}`);
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...validate(s.items, x, `${path}[${i}]`)));
  if (s.type === 'object') {
    for (const r of s.required ?? []) if (!(r in v)) errs.push(`${path}: missing ${r}`);
    for (const [k, x] of Object.entries(v)) {
      const sub = s.properties?.[k];
      if (sub) errs.push(...validate(sub, x, `${path}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${path}: unexpected property ${k}`);
      else if (typeof s.additionalProperties === 'object') errs.push(...validate(s.additionalProperties, x, `${path}.${k}`));
    }
  }
  return errs;
}

const plugin = rd('plugin.json');
assert.deepEqual(validate(schema, plugin), []);
console.log('ok   plugin.json validates against the vendored Agent Plugins 1.0.0 schema');
assert.ok(validate(schema, { name: 'x' }).length > 0); assert.ok(validate(schema, { ...plugin, bogus: 1 }).length > 0);
console.log('ok   the validator rejects a missing $schema and an unknown property');

const versions = { 'plugin.json': plugin.version, [`${DOT}-plugin/plugin.json`]: rd(`${DOT}-plugin/plugin.json`).version, 'package.json': rd('package.json').version };
const market = rd(`../${DOT}-plugin/marketplace.json`).plugins.find((p) => p.name === 'enforcer');
if (market.version) versions['marketplace.json'] = market.version;
assert.equal(new Set(Object.values(versions)).size, 1, `versions differ: ${JSON.stringify(versions)}`);
console.log(`ok   one version everywhere: ${plugin.version} (${Object.keys(versions).join(', ')})`);

const mcp = rd('mcp.json').mcpServers.enforcer;
assert.equal(mcp.type, 'streamable-http'); assert.equal(mcp.url, 'https://api.instruxi.dev/mcp');
console.log('ok   mcp.json is streamable-http at api.instruxi.dev/mcp');
assert.ok(existsSync(new URL('../.mcp.json', import.meta.url)) && existsSync(new URL('../skills/enforcer/SKILL.md', import.meta.url)));
for (const c of readdirSync(new URL('../commands/', import.meta.url))) {
  const b = readFileSync(new URL(`../commands/${c}`, import.meta.url), 'utf8');
  assert.ok(b.split('\n').length <= 9, `${c} is not thin`);
}
console.log('ok   Claude fallback present; commands are thin wrappers');
const root = (f) => new URL(`../../${f}`, import.meta.url);
const mkt = JSON.parse(readFileSync(root(`${DOT}-plugin/marketplace.json`), 'utf8'));
for (const n of ['enforcer-graph', 'enforcer-files']) {
  const src = mkt.plugins.find((p) => p.name === n).source;
  assert.equal(src, `./aliases/${n}`);
  const dir = `${src.replace('./', '')}`;
  assert.ok(!existsSync(root(`${dir}/.mcp.json`)) && !existsSync(root(`${dir}/mcp.json`)));
  const hooks = JSON.parse(readFileSync(root(`${dir}/hooks/hooks.json`), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart']);
  const cmds = hooks.SessionStart.flatMap((g) => g.hooks);
  assert.equal(cmds.length, 1);
  assert.match(cmds[0].command, /this alias is now part of enforcer; uninstall it/);
}
// installing enforcer plus both aliases registers exactly one real hooks.json
const withHooks = ['enforcer', 'enforcer-graph', 'enforcer-files'].filter((n) => {
  const src = mkt.plugins.find((p) => p.name === n).source.replace('./', '');
  const f = root(`${src}/hooks/hooks.json`);
  return existsSync(f) && Object.values(JSON.parse(readFileSync(f, 'utf8')).hooks).flat().some((g) => g.hooks.some((h) => h.type === 'command' && !/this alias is now part/.test(h.command)));
});
assert.deepEqual(withHooks, ['enforcer']);
console.log('ok   aliases carry no hooks and no mcp');
const kit = JSON.parse(readFileSync(root('kit.json'), 'utf8'));
assert.deepEqual(kit.plugins.map((p) => p.id).sort(), ['enforcer@instruxi', 'jev-hooks@instruxi']);
assert.deepEqual(kit.plugins.filter((p) => p.default).map((p) => p.id), ['enforcer@instruxi']);
console.log('ok   kit defaults: only enforcer and jev-hooks are selectable, only enforcer default');

console.log('\nOK');
