// Docs must not name paths, versions or dependencies that no longer exist (docs-truth-pass-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = ['README.md', 'docs/CANONICAL_RELEASE.md', 'docs/RELEASE_CHECKLIST.md',
  ...readdirSync(join(ROOT, 'enforcer/docs')).flatMap((n) => n.endsWith('.md') ? [`enforcer/docs/${n}`] : []),
  ...readdirSync(join(ROOT, 'enforcer/docs/graph')).filter((n) => n.endsWith('.md')).map((n) => `enforcer/docs/graph/${n}`),
  'enforcer/skills/graph/SKILL.md'].filter((f) => existsSync(join(ROOT, f)));
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

function scan(patterns) {
  const hits = [];
  for (const f of docs) read(f).split('\n').forEach((line, i) => {
    for (const [re, why] of patterns) if (re.test(line)) hits.push(`${f}:${i + 1}: ${why}: ${line.trim().slice(0, 100)}`);
  });
  return hits;
}

test('no doc names a removed path', () => {
  assert.deepEqual(scan([
    [/hooks\/lib\.py/, 'hooks/lib.py'],
    [/(^|[\s`(])enforcer-graph\/(bin|hooks|test|skills|agents|\.claude-plugin)/, 'enforcer-graph/ directory'],
    [/enforcer hook\b/, '`enforcer hook` (the command is `enforcer event`)'],
    [/hooks\/(session_start|track_run|heartbeat|remember_on_compact|open_run_guard|capture_evidence|attach_evidence)\.py/, 'old python hook path'],
    [/\.claude\/graph\.json/, 'old project config path'],
  ]), []);
});

test('no doc names a stale version', () => {
  const v = JSON.parse(read('enforcer/plugin.json')).version;
  assert.deepEqual(scan([
    [/currently 0\.\d+\.\d+/, 'stale "currently" version'],
    [/\b0\.(17|23)\.0\b/, 'old plugin version'],
    [/name enforcer, version 1\.0\.0\b/, "layout block version"],
    [/enforcer 1\.0\.0;/, 'marketplace version'],
  ]), []);
  assert.match(read('docs/CANONICAL_RELEASE.md'), new RegExp(`version ${v.replace(/\./g, '\\.')}`));
});

test('no doc claims a plugin dependency', () => {
  assert.deepEqual(scan([
    [/\(\+ 1 dependency/, 'dependency install claim'],
    [/depends on\s+this one|"dependencies":\s*\[/, 'dependency claim'],
    [/Dependency "enforcer-graph/, 'dependency error text'],
    [/enforcer-graph@instruxi/, 'enforcer-graph@instruxi install/enable'],
  ]), []);
});

test('README alias table matches marketplace.json', () => {
  const mk = JSON.parse(read('.claude-plugin/marketplace.json')).plugins;
  const readme = read('README.md');
  for (const p of mk.filter((x) => typeof x.source === 'string' && x.source.startsWith('./aliases/'))) {
    const row = readme.split('\n').find((l) => l.startsWith(`| \`${p.name}\``));
    assert.ok(row, `README has a row for ${p.name}`);
    assert.ok(row.includes(p.source.replace('./', '')), `${p.name} row names ${p.source}`);
  }
});
