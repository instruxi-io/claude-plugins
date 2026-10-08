import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, uninstall } from '../src/grok-install.mjs';

const mk = () => mkdtempSync(join(tmpdir(), 'grok-opt-'));
const quiet = { out: () => {} };
const hooksOf = (h) => readFileSync(join(h, '.grok/hooks/enforcer.json'), 'utf8');
const manifest = (h) => JSON.parse(readFileSync(join(h, '.config/enforcer/grok/manifest.json'), 'utf8'));

test('graph-only install writes no governor hook', async () => {
  const home = mk();
  await install({ home, yes: true, options: { graphOnly: true }, ...quiet });
  const j = JSON.parse(hooksOf(home));
  const cmds = Object.values(j.hooks)
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command))
    .filter((c) => / event /.test(c));
  assert.ok(cmds.length > 0);
  for (const c of cmds) assert.match(c, / event [a-z-]+ --graph-only$/);
});

test('no-hooks install writes no hooks file', async () => {
  const home = mk();
  await install({ home, yes: true, options: { noHooks: true, noAgent: true }, ...quiet });
  assert.equal(existsSync(join(home, '.grok/hooks/enforcer.json')), false);
  assert.equal(existsSync(join(home, '.grok/agents/graph-worker.md')), false);
  assert.ok(existsSync(join(home, '.grok/config.toml')));
});

test('skills install copies three skills and uninstall removes only those', async () => {
  const home = mk();
  mkdirSync(join(home, '.grok/skills/mine'), { recursive: true });
  writeFileSync(join(home, '.grok/skills/mine/SKILL.md'), 'mine');
  await install({ home, yes: true, options: { skills: true }, ...quiet });
  for (const n of ['enforcer', 'files', 'graph']) assert.ok(existsSync(join(home, '.grok/skills', n, 'SKILL.md')), n);
  assert.equal(existsSync(join(home, '.grok/skills/governor')), false);
  await uninstall({ home, yes: true, ...quiet });
  for (const n of ['enforcer', 'files', 'graph']) assert.equal(existsSync(join(home, '.grok/skills', n)), false, n);
  assert.ok(existsSync(join(home, '.grok/skills/mine/SKILL.md')));
});

test('a plain reinstall reuses the recorded options', async () => {
  const home = mk();
  await install({ home, yes: true, options: { noHooks: true, skills: true }, ...quiet });
  await install({ home, yes: true, ...quiet });
  assert.equal(existsSync(join(home, '.grok/hooks/enforcer.json')), false);
  assert.ok(existsSync(join(home, '.grok/skills/graph/SKILL.md')));
  assert.deepEqual(manifest(home).options, { graphOnly: false, noHooks: true, noAgent: false, skills: true });
});

test('dry-run prints the options and writes nothing', async () => {
  const home = mk();
  const lines = [];
  await install({ home, dryRun: true, options: { graphOnly: true, skills: true }, out: (s) => lines.push(s) });
  assert.ok(lines.some((l) => l.includes('options: --graph-only --skills')));
  assert.equal(existsSync(join(home, '.grok')), false);
});
