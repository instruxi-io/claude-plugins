// `node --test test/dispatch/salvage.test.mjs`: salvage, remediation, triage gate and landing completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePr, quoteBody, landWithHeartbeat } from '../../src/dispatch/salvage.mjs';
import { nextStep, clipWords, gateSpec, TITLE_MAX } from '../../src/dispatch/remediate.mjs';
import { acceptanceCommands, landAndComplete, landingEvidence, mayLaunch } from '../../src/dispatch/land-complete.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'salv-'));

test('existing PR is reused', () => {
  const calls = [];
  const run = (cmd) => {
    calls.push(cmd.slice(0, 3).join(' '));
    const k = cmd.slice(0, 2).join(' ');
    if (k === 'git rev-parse') return [0, 'graph/n1'];
    if (k === 'git status') return [0, ''];
    if (k === 'git rev-list') return [0, '2'];
    if (k === 'git push') return [0, ''];
    if (k === 'gh pr' && cmd[2] === 'list') return [0, '42'];
    return [1, 'unexpected ' + cmd.join(' ')];
  };
  const r = preparePr({ node: { key: 'n1', title: 't' }, path: tmp(), result: 'x', run });
  assert.deepEqual(r, { pr: '42', reused: true });
  assert.ok(!calls.some((c) => c.startsWith('gh pr create')));
});

test('auto-link markers are neutralised in the PR body', () => {
  const q = quoteBody('Fixes #12 and closes org/repo#3, ping @bob');
  assert.ok(!/Fixes #12/.test(q) && !/closes org/.test(q) && !q.includes('@bob'));
  assert.ok(q.startsWith('> '));
});

test('landing completion attaches acceptance command output', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'x.txt'), 'hi');
  const node = { data: { acceptance: ['ls x.txt prints the file', '`gh pr view 1` prints MERGED', 'prose only'] } };
  assert.deepEqual(acceptanceCommands(node), ['ls x.txt']);
  let posted;
  const body = await landAndComplete({
    pr: '7', url: 'https://github.com/o/r/pull/7', view: '{}', cmd: ['land-pr.sh', '7'], workerReport: 'done',
    land: async () => ({ rc: 0, out: 'merged' }), mergeCommit: async () => 'abc123',
    evidence: async () => landingEvidence(node, dir), complete: async (b) => { posted = b; },
  });
  assert.equal(posted, body);
  assert.equal(body.status, 'succeeded');
  const ev = body.evidence.find((e) => e.cmd === 'ls x.txt');
  assert.equal(ev.exit, 0);
  assert.equal(ev.output, 'x.txt');
  assert.match(body.data.report, /merge commit abc123/);
});

test('a failed landing completes failed with no acceptance evidence', async () => {
  const body = await landAndComplete({
    pr: '7', cmd: ['land-pr.sh', '7'], land: async () => ({ rc: 2, out: 'ci red' }),
    mergeCommit: async () => '', evidence: async () => assert.fail('not run'), complete: async () => {},
  });
  assert.equal(body.status, 'failed');
  assert.match(body.error, /CI failed/);
});

test('node mid-landing is not relaunched', () => {
  const landing = new Map([['n1', '7']]);
  assert.equal(mayLaunch({ key: 'n1' }, landing), false);
  assert.equal(mayLaunch({ key: 'n2' }, landing), true);
});

test('remediation once, then triage, then a person', () => {
  assert.equal(nextStep({ attempts: 1, maxAttempts: 2 }), 'remediate');
  assert.equal(nextStep({ attempts: 2, maxAttempts: 2 }), 'triage');
  assert.equal(nextStep({ attempts: 2, maxAttempts: 2, noTriage: true }), 'person');
  assert.equal(nextStep({ attempts: 2, maxAttempts: 2, triaged: true }), 'person');
});

test('triage gate title is truncated at a word boundary', () => {
  const decision = 'Should we ' + 'approve the production migration window '.repeat(10);
  const spec = gateSpec({ key: 'k' }, 'triage-k-1', { action: 'gate', reason: 'r', decision });
  assert.ok(spec.title.length <= TITLE_MAX);
  assert.ok(spec.title.endsWith('…'));
  assert.ok(decision.startsWith(spec.title.slice(0, -1) + ' '));
  assert.equal(clipWords('short title', 120), 'short title');
  assert.equal(spec.data.created_by, 'triage');
});

test('the lander is heartbeated while it runs', async () => {
  const dir = tmp();
  let beats = 0;
  const { rc } = await landWithHeartbeat({
    cmd: ['sh', '-c', 'sleep 0.35'], cwd: dir, logPath: join(dir, 'l.log'), everyMs: 50, heartbeat: async () => { beats++; },
  });
  assert.equal(rc, 0);
  assert.ok(beats >= 2, `beats=${beats}`);
});
