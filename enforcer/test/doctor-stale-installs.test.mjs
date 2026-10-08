import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleProjectInstalls, runChecks } from '../src/doctor.mjs';

const setup = (plugins) => {
  const h = mkdtempSync(join(tmpdir(), 'stale-')); mkdirSync(join(h, '.' + 'claude/plugins'), { recursive: true });
  const f = join(h, '.' + 'claude/plugins/installed_plugins.json');
  writeFileSync(f, JSON.stringify({ version: 2, plugins })); return { h, f };
};

test('doctor lists project installs whose directory is gone', async () => {
  const { h } = setup({ 'enforcer@instruxi': [{ scope: 'project', projectPath: join(tmpdir(), 'no-such-wt-xyz'), version: '1.0.5' }] });
  const s = staleProjectInstalls(h);
  assert.equal(s.length, 1); assert.equal(s[0].version, '1.0.5');
  const rows = await runChecks({ network: false, home: h });
  assert.ok(rows.some((r) => r.name === 'stale project installs' && /1 found/.test(r.detail) && /claude plugin uninstall enforcer@instruxi --scope project/.test(r.detail)));
});

test('doctor does not list an install whose directory exists', async () => {
  const live = mkdtempSync(join(tmpdir(), 'live-'));
  const { h } = setup({ 'enforcer@instruxi': [{ scope: 'project', projectPath: live, version: '1.2.0' }, { scope: 'user', version: '1.0.0' }], 'other@x': [{ scope: 'project', projectPath: join(live, 'gone'), version: '1' }] });
  assert.deepEqual(staleProjectInstalls(h), []);
  const rows = await runChecks({ network: false, home: h });
  assert.ok(!rows.some((r) => r.name.startsWith('stale project install')));
});

test('doctor never writes the registry', async () => {
  const { h, f } = setup({ 'enforcer@instruxi': [{ scope: 'project', projectPath: join(tmpdir(), 'gone-abc'), version: '1.0.5' }] });
  const before = readFileSync(f, 'utf8');
  await runChecks({ network: false, home: h });
  assert.equal(readFileSync(f, 'utf8'), before);
});

test('doctor handles a missing registry', async () => {
  const h = mkdtempSync(join(tmpdir(), 'none-'));
  assert.deepEqual(staleProjectInstalls(h), []);
  const rows = await runChecks({ network: false, home: h });
  assert.ok(!rows.some((r) => r.name.startsWith('stale project install')));
});
