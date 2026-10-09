// `node --test test/dispatch-merge-pid-path.test.mjs`: a merge node lands only this graph's own pull requests, a stale pids.json
// kills nothing it cannot prove is ours, and node keys and repos are validated by every function that makes a path of them.
// Stub processes and temp dirs only: no claude, no gh, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Dispatcher, defaultArgs, mergeAllowList } from '../src/dispatch/run.mjs';
import { mergeRefusal } from '../src/dispatch/select.mjs';
import { spawnWorker, killGroup, pidAliveGroup, procNonce, mcpConfigPath, NONCE_ENV } from '../src/dispatch/launch.mjs';
import { worktreeFor } from '../src/dispatch/worktree.mjs';
import { unsafeIdent } from '../src/dispatch/ident.mjs';
import { unsafeIdent as triageUnsafeIdent } from '../src/dispatch/triage.mjs';

const WIN = process.platform === 'win32';
const tmp = () => mkdtempSync(join(tmpdir(), 'dmpp-'));
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const script = (dir, name, body) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
class FakeAPI {
  constructor() {
    this.claims = [];
  }
  async claim(g, id) {
    this.claims.push(id);
    return { run_id: 'run-' + id };
  }
}
const mkArgs = (state, o = {}) => defaultArgs({ graph: 'g', stateDir: state, stopFile: join(state, 'STOP'), repoRoot: join(state, 'none'), ...o });
const mergeNode = (data, key = 'merge-feat') => ({ id: 'id-' + key, key, type: 'merge', status: 'ready', title: key, data });
const view = (url, headRefName, isCrossRepository = false) => ({ url, headRefName, isCrossRepository });

/** Run launchMerge against a stubbed gh view; returns what was said and claimed. */
async function landAttempt(node, pr, o = {}) {
  const state = tmp();
  const api = new FakeAPI();
  const lines = [];
  const d = new Dispatcher(api, mkArgs(state, { prView: () => pr, ...o }), (s) => lines.push(s));
  d.graphKeys = new Set(o.graphKeys || [node.key]);
  const { mergeTarget } = await import('../src/dispatch/select.mjs');
  await d.launchMerge(node, mergeTarget(node), '');
  return { lines, claims: api.claims, workers: d.workers.size };
}

test('a merge node for another repo is refused', async () => {
  const n = mergeNode({ repo: 'claude-plugins', pr: 'https://github.com/evil/payroll/pull/9' });
  const pr = view('https://github.com/evil/payroll/pull/9', 'graph/merge-feat');
  assert.match(mergeRefusal(n, pr), /in evil\/payroll, not this node's data\.repo \(claude-plugins\)/);
  // no data.repo at all: nothing to compare with, so refused
  assert.match(mergeRefusal(mergeNode({ pr: 'evil/payroll#9' }), pr), /not this node's data\.repo \(none\)/);
  // the operator's allow list is the only other way in
  assert.equal(mergeRefusal(n, pr, { allow: ['evil/payroll'] }), '');
  assert.equal(mergeRefusal(n, view('https://github.com/instruxi-io/claude-plugins/pull/3', 'graph/merge-feat')), '');
  // an unreadable PR is refused, never landed blind
  assert.match(mergeRefusal(n, null), /cannot read the pull request/);
  // the dispatcher refuses before it claims or spawns anything
  const r = await landAttempt(n, pr);
  assert.deepEqual(r.claims, [], 'nothing was claimed');
  assert.equal(r.workers, 0, 'no lander was spawned');
  assert.ok(
    r.lines.some((l) => /REFUSE merge-feat: will not land evil\/payroll#9: the pull request is in evil\/payroll/.test(l)),
    r.lines.join('\n'),
  );
  assert.deepEqual(mergeAllowList(['a/b']), ['a/b']);
  assert.throws(() => mergeAllowList(['not a slug']), /is not owner\/repo/);
  const f = join(tmp(), 'allow');
  writeFileSync(f, '# repos\nevil/payroll\n\nx/y # trailing\n');
  assert.deepEqual(mergeAllowList([], f), ['evil/payroll', 'x/y']);
});

test('a merge node whose PR head is not graph/key is refused', async () => {
  const n = mergeNode({ repo: 'claude-plugins', pr: 'instruxi-io/claude-plugins#5' });
  const url = 'https://github.com/instruxi-io/claude-plugins/pull/5';
  const keys = new Set(['merge-feat', 'feat']);
  assert.match(mergeRefusal(n, view(url, 'main'), { graphKeys: keys }), /head is "main", not graph\/merge-feat/);
  assert.match(mergeRefusal(n, view(url, 'feature/x'), { graphKeys: keys }), /head is "feature\/x"/);
  assert.match(mergeRefusal(n, view(url, 'graph/someone-elses-node'), { graphKeys: keys }), /not graph\/merge-feat or graph\/<a key in this graph>/);
  assert.match(mergeRefusal(n, view(url, 'graph/merge-feat', true), { graphKeys: keys }), /on a fork/);
  assert.equal(mergeRefusal(n, view(url, 'graph/merge-feat'), { graphKeys: keys }), '');
  assert.equal(mergeRefusal(n, view(url, 'graph/feat'), { graphKeys: keys }), '', 'a merge node may land the PR of a node in its own graph');
  const r = await landAttempt(n, view(url, 'feature/x'));
  assert.deepEqual(r.claims, []);
  assert.equal(r.workers, 0);
  assert.ok(r.lines.some((l) => /REFUSE merge-feat: will not land instruxi-io\/claude-plugins#5: the pull request's head is "feature\/x"/.test(l)));
});

test('a stale pids.json does not kill an unrelated group', { skip: WIN && 'process groups are POSIX' }, async () => {
  const state = tmp();
  // an unrelated session leader, like a login shell or a tmux session: its own group, no launch nonce
  const other = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  other.unref();
  await sleepMs(150);
  assert.ok(pidAliveGroup(other.pid), 'the bystander leads its own group');
  const write = (meta) =>
    writeFileSync(join(state, 'pids.json'), JSON.stringify({ dispatcher: 2147483000, host: hostname(), workers: { x: other.pid }, ...(meta ? { meta } : {}) }));
  try {
    // an old-format file (no start time, no nonce), a forged nonce, and a wrong start time: none of them kill
    for (const meta of [null, { x: { start: 'proc:1', nonce: 'forged' } }, { x: { start: 'proc:1' } }]) {
      write(meta);
      const lines = [];
      const d = new Dispatcher(new FakeAPI(), mkArgs(state), (s) => lines.push(s));
      assert.deepEqual(await d.reapOrphans(), [], 'nothing reaped');
      await sleepMs(100);
      assert.ok(pidAlive(other.pid) && pidAliveGroup(other.pid), 'the unrelated group is still running');
      assert.ok(
        lines.some((l) => new RegExp(`not reaping x pid ${other.pid} from pids.json: .+; left running`).test(l)),
        lines.join('\n'),
      );
    }
  } finally {
    try {
      process.kill(-other.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  // a worker the dispatcher really launched is still reaped, when the platform lets its nonce be read
  const p = spawnWorker([script(state, 'orphan', 'sleep 60')], { cwd: state, logPath: join(state, 'o.log') });
  await sleepMs(150);
  writeFileSync(
    join(state, 'pids.json'),
    JSON.stringify({ dispatcher: 2147483000, host: hostname(), workers: { w: p.pid }, meta: { w: { start: p.start, nonce: p.nonce } } }),
  );
  const d = new Dispatcher(new FakeAPI(), mkArgs(state), () => {});
  const hold = setInterval(() => {}, 50);
  try {
    if (procNonce(p.pid) === p.nonce) {
      assert.deepEqual(await d.reapOrphans(), ['w']);
      await p.done;
      assert.ok(!pidAliveGroup(p.pid));
    } else {
      assert.deepEqual(await d.reapOrphans(), [], 'unverifiable: left alone');
      await killGroup(p, 200);
    }
  } finally {
    clearInterval(hold);
  }
  assert.ok(!existsSync(join(state, 'pids.json')));
});

test('a worker child that left the group with setsid is killed by its launch nonce', {
  skip: (!existsSync('/proc/self/environ') || spawnSync('setsid', ['true']).status !== 0) && 'needs /proc and setsid (Linux)',
}, async () => {
  const dir = tmp();
  const pidFile = join(dir, 'escaped.pid');
  const sh = script(dir, 'escaper', `setsid sleep 60 &\necho $! > ${JSON.stringify(pidFile).slice(1, -1)}\nwhile true; do sleep 1; done`);
  const p = spawnWorker([sh], { cwd: dir, logPath: join(dir, 'log') });
  const end = Date.now() + 5000;
  while (!existsSync(pidFile) && Date.now() < end) await sleepMs(20);
  await sleepMs(100);
  const escaped = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(pidAlive(escaped), 'the setsid child runs');
  assert.ok(readFileSync(`/proc/${escaped}/environ`, 'utf8').includes(`${NONCE_ENV}=${p.nonce}`), 'it carries the nonce');
  await killGroup(p, 200);
  const e2 = Date.now() + 3000;
  while (pidAlive(escaped) && Date.now() < e2) {
    // a killed child of an exited parent is reaped by init; a zombie still answers kill(0) for a moment
    const st = (() => {
      try {
        return readFileSync(`/proc/${escaped}/stat`, 'utf8');
      } catch {
        return '';
      }
    })();
    if (/\) Z /.test(st)) break;
    await sleepMs(50);
  }
  const st = existsSync(`/proc/${escaped}/stat`) ? readFileSync(`/proc/${escaped}/stat`, 'utf8') : '';
  assert.ok(!st || /\) Z /.test(st), 'the escaped child was killed');
});

test('worktreeFor rejects a hostile key and repo', () => {
  const root = tmp();
  const state = tmp();
  for (const key of ['/../proj', '..', '.', '../../../x', 'a/b', 'a\\b', '', 'a b']) {
    assert.throws(() => worktreeFor({ key, data: {} }, root, state, { dry: true }), /node key .* does not match/, `key ${key}`);
    assert.throws(() => mcpConfigPath(state, key), /node key .* does not match/, `mcp key ${key}`);
  }
  for (const repo of ['..', '../proj', '/etc', 'a/b'])
    assert.throws(() => worktreeFor({ key: 'ok', data: { repo } }, root, state, { dry: true }), /data\.repo .* does not match/, `repo ${repo}`);
  // a safe key still works, and stays under the state dir
  const [path, branch] = worktreeFor({ key: 'fine-key_1.2', data: {} }, root, state, { dry: true });
  assert.equal(resolve(path), resolve(join(state, 'work', 'fine-key_1.2')));
  assert.equal(branch, null);
  assert.equal(resolve(mcpConfigPath(state, 'k')), resolve(join(state, 'mcp-k.json')));
  // one validator, shared
  assert.equal(triageUnsafeIdent, unsafeIdent);
  assert.match(unsafeIdent({ key: 'ok', data: { repo: '..' } }), /data\.repo/);
});
