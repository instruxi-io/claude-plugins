import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MANIFESTS } from '../scripts/release.mjs';

const SCRIPT = path.resolve('scripts/release.mjs');

function fixture({ changelog, fragments = {} }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-'));
  for (const m of MANIFESTS) {
    fs.mkdirSync(path.dirname(path.join(d, m.file)), { recursive: true });
    fs.copyFileSync(m.file, path.join(d, m.file));
  }
  fs.writeFileSync(path.join(d, 'CHANGELOG.md'), changelog);
  fs.mkdirSync(path.join(d, 'changes'));
  fs.writeFileSync(path.join(d, 'changes/README.md'), '# Change fragments\n');
  for (const [k, v] of Object.entries(fragments)) fs.writeFileSync(path.join(d, 'changes', k), v);
  return d;
}
const run = (d, ...args) => spawnSync('node', [SCRIPT, ...args], { cwd: d, encoding: 'utf8' });

test('bump folds fragments into a version section and deletes them', () => {
  const d = fixture({
    changelog: '# Changelog\n\n## Unreleased\n\n## 1.2.0\n\n- old\n',
    fragments: { 'b-two.md': 'second\n', 'a-one.md': '- first\n' },
  });
  const r = run(d, 'bump', '1.3.0');
  assert.equal(r.status, 0, r.stderr);
  const t = fs.readFileSync(path.join(d, 'CHANGELOG.md'), 'utf8');
  assert.match(t, /## Unreleased\n\n## 1\.3\.0\n\n- first\n- second\n\n## 1\.2\.0/);
  assert.deepEqual(fs.readdirSync(path.join(d, 'changes')), ['README.md']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'kit.json'), 'utf8')).version, '1.3.0');
});

test('bump refuses when there is nothing to release', () => {
  const d = fixture({ changelog: '# Changelog\n\n## Unreleased\n\n## 1.2.0\n\n- old\n' });
  const before = fs.readFileSync(path.join(d, 'kit.json'), 'utf8');
  const r = run(d, 'bump', '1.3.0');
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(path.join(d, 'kit.json'), 'utf8'), before);
  assert.match(fs.readFileSync(path.join(d, 'CHANGELOG.md'), 'utf8'), /^# Changelog\n\n## Unreleased\n\n## 1\.2\.0/);
});

test('notes prints the section for a version', () => {
  const d = fixture({ changelog: '# Changelog\n\n## Unreleased\n\n## 1.3.0\n\n- a\n- b\n\n## 1.2.0\n\n- old\n' });
  const r = run(d, 'notes', '1.3.0');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '- a\n- b');
});

test('check-changed still accepts a fragment', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  const sh = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  for (const m of MANIFESTS) {
    fs.mkdirSync(path.dirname(path.join(d, m.file)), { recursive: true });
    fs.copyFileSync(m.file, path.join(d, m.file));
  }
  fs.mkdirSync(path.join(d, 'changes'));
  sh('init', '-q', '-b', 'main');
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  sh('checkout', '-qb', 'pr');
  fs.writeFileSync(path.join(d, 'changes/x.md'), 'x\n');
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'frag');
  const v = JSON.parse(fs.readFileSync(path.join(d, 'kit.json'), 'utf8')).version;
  const r = run(d, 'check-changed', 'v' + v, 'main');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /changes\/x\.md/);
});
