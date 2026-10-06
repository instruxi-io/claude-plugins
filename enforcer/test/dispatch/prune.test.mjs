// `node --test test/dispatch/prune.test.mjs`: `enforcer dispatch prune` over real git worktrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pruneWorktrees } from '../../src/dispatch/prune.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture(keys) {
  const root = mkdtempSync(join(tmpdir(), 'prune-'));
  const src = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', src]);
  g(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const k of keys) {
    g(src, 'worktree', 'add', '-q', '-b', `graph/${k}`, join(root, `repo-${k}`));
    // a commit that is NOT an ancestor of main, as after a squash merge
    g(join(root, `repo-${k}`), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', k);
  }
  return { root, src };
}
const run = (root, o) => { let out = ''; const r = pruneWorktrees(root, { registry: {}, minAge: 0, out: (s) => { out += s; }, ...o }); return { r, out }; };
const merged = () => 'MERGED';

test('dry run lists merged worktrees and removes nothing', () => {
  const { root } = fixture(['a', 'b']);
  const { r, out } = run(root, { prState: merged });
  assert.equal(r.removed.length, 2);
  assert.match(out, /would remove .*repo-a/);
  assert.ok(existsSync(join(root, 'repo-a')) && existsSync(join(root, 'repo-b')));
});

test('--yes removes merged, keeps live and dirty', () => {
  const { root, src } = fixture(['gone', 'live', 'dirty', 'open']);
  writeFileSync(join(root, 'repo-dirty', 'x.txt'), 'x');
  g(join(root, 'repo-dirty'), 'add', 'x.txt');
  const { r } = run(root, { yes: true, liveKeys: new Set(['live']), prState: (b) => (b === 'graph/open' ? 'OPEN' : 'MERGED') });
  assert.deepEqual(r.removed.map(([p]) => p.split('/').pop()), ['repo-gone']);
  assert.ok(!existsSync(join(root, 'repo-gone')));
  for (const k of ['live', 'dirty', 'open']) assert.ok(existsSync(join(root, `repo-${k}`)), k);
  assert.ok(!g(src, 'branch', '--list', 'graph/gone').trim());
  assert.ok(g(src, 'branch', '--list', 'graph/live').trim());
});

test('a merged branch with a deleted remote ref is still pruned', () => {
  const { root, src } = fixture(['x']);
  const remote = mkdtempSync(join(tmpdir(), 'remote-'));
  execFileSync('git', ['init', '-q', '--bare', remote]);
  g(src, 'remote', 'add', 'origin', remote);
  g(src, 'push', '-q', 'origin', 'graph/x');
  g(src, 'push', '-q', 'origin', ':graph/x'); // the merge deleted the remote branch
  const { r } = run(root, { yes: true, prState: merged });
  assert.equal(r.removed.length, 1);
  assert.ok(!existsSync(join(root, 'repo-x')));
  assert.ok(!g(src, 'branch', '--list', 'graph/x').trim());
});

test('a checkout not named for a node is never touched', () => {
  const { root, src } = fixture([]);
  g(src, 'worktree', 'add', '-q', '-b', 'graph/odd', join(root, 'elsewhere'));
  run(root, { yes: true, prState: merged });
  assert.ok(existsSync(join(root, 'elsewhere')) && existsSync(src));
});
