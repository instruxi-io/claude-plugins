// enforcer land / bin/land-pr.sh against a fake `gh` (a node script on PATH) driven by env vars.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
const GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), e = process.env, j = a.join(' ');
fs.appendFileSync(e.FAKE_LOG, 'gh ' + j + '\\n');
const out = (x) => { process.stdout.write(typeof x === 'string' ? x + '\\n' : JSON.stringify(x) + '\\n'); process.exit(0); };
const state = () => fs.readFileSync(e.FAKE_DIR + '/state', 'utf8').trim();
if (a[0] === 'pr' && a[1] === 'view') out({ number: 1, state: state(), mergeStateStatus: 'CLEAN', statusCheckRollup: JSON.parse(e.FAKE_ROLLUP), headRefOid: 'headsha', mergeCommit: { oid: 'mergesha' }, mergedAt: 't', baseRefName: 'main' });
if (a[0] === 'pr' && a[1] === 'merge') {
  if (e.FAKE_SQUASH === 'false' && j.includes('--squash')) { process.stderr.write('squash disallowed\\n'); process.exit(1); }
  fs.writeFileSync(e.FAKE_DIR + '/state', 'MERGED'); process.exit(0);
}
if (a[0] === 'repo' && a[1] === 'view') {
  if (j.includes('nameWithOwner')) out({ nameWithOwner: 'o/r' });
  out({ squashMergeAllowed: e.FAKE_SQUASH !== 'false', mergeCommitAllowed: true, rebaseMergeAllowed: true });
}
if (a[0] === 'run' && a[1] === 'view') out({ jobs: [{ steps: new Array(Number(e.FAKE_STEPS || 5)).fill({}) }] });
if (a[0] === 'run' && a[1] === 'list') out(JSON.parse(e.FAKE_RUNS));
if (a[0] === 'api' && a[1] === 'repos/o/r/compare/main...mergesha') out(e.FAKE_COMPARE);
process.exit(1);
`;
const OK = '[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]';
const RUNS_OK = '[{"status":"completed","conclusion":"success","name":"ci","createdAt":"2026-01-01"}]';

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'land-test-'));
  mkdirSync(join(tmp, 'bin')); mkdirSync(join(tmp, 'cwd'));
  writeFileSync(join(tmp, 'bin', 'gh'), GH.replace('#!/usr/bin/env node', `#!${process.execPath}`)); chmodSync(join(tmp, 'bin', 'gh'), 0o755);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function land(args, { state = 'OPEN', cmd = [process.execPath, join(root, 'bin', 'enforcer'), 'land'], ...env } = {}) {
  writeFileSync(join(tmp, 'state'), state); writeFileSync(join(tmp, 'log'), '');
  const t = Date.now();
  const r = spawnSync(cmd[0], [...cmd.slice(1), ...args], {
    cwd: join(tmp, 'cwd'), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${join(tmp, 'bin')}:${process.env.PATH}`, FAKE_DIR: tmp, FAKE_LOG: join(tmp, 'log'), LAND_PR_POLL: '1',
      FAKE_ROLLUP: OK, FAKE_SQUASH: 'true', FAKE_COMPARE: 'identical', FAKE_RUNS: RUNS_OK, ...env },
  });
  return { rc: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t, log: readFileSync(join(tmp, 'log'), 'utf8') };
}

test('CLOSED exits 5 within one poll', () => {
  const r = land(['1', '-R', 'o/r', '--timeout', '100'], { state: 'CLOSED' });
  assert.equal(r.rc, 5); assert.ok(r.ms < 5000);
});
test('-R verifies via the compare API from an unrelated cwd', () => {
  const r = land(['1', '-R', 'o/r', '--timeout', '30']);
  assert.equal(r.rc, 0, r.err); assert.match(r.out, /compare\/main\.\.\.mergesha -> identical/);
});
test('CANCELLED superseded check is tolerated', () => {
  const r = land(['1', '-R', 'o/r', '--timeout', '30'], {
    FAKE_ROLLUP: '[{"name":"ci","status":"COMPLETED","conclusion":"CANCELLED"},{"name":"ci2","status":"COMPLETED","conclusion":"SUCCESS"}]'
  });
  assert.equal(r.rc, 0, r.err);
});
test('squash disallowed falls back to merge', () => {
  const r = land(['1', '-R', 'o/r', '--timeout', '30'], { FAKE_SQUASH: 'false' });
  assert.equal(r.rc, 0, r.err); assert.match(r.log, /pr merge 1 -R o\/r --merge/);
});
const CANC = '[{"name":"ci","status":"COMPLETED","conclusion":"CANCELLED"}]';
const CANC_RUNS = '[{"status":"completed","conclusion":"cancelled","name":"ci","createdAt":"2026-01-01","databaseId":42}]';
test('zero-step cancelled check exits 7', () => {
  const r = land(['1', '-R', 'o/r', '--timeout', '30'], { FAKE_ROLLUP: CANC, FAKE_RUNS: CANC_RUNS, FAKE_STEPS: '0' });
  assert.equal(r.rc, 7); assert.match(r.err, /CI unavailable/);
});
test('cancelled check with steps run is a real failure (exit 2)', () => {
  const r = land(['1', '-R', 'o/r', '--timeout', '30'], { FAKE_ROLLUP: CANC, FAKE_RUNS: CANC_RUNS, FAKE_STEPS: '3' });
  assert.equal(r.rc, 2);
});
test('--timeout with no value exits 2 with usage', () => {
  const r = land(['1', '--timeout']);
  assert.equal(r.rc, 2); assert.match(r.err, /usage/);
});
test('shim execs enforcer land', () => {
  const sh = readFileSync(join(root, 'bin', 'land-pr.sh'), 'utf8');
  assert.match(sh, /exec node "\$\(dirname "\$0"\)\/enforcer" land "\$@"/);
  const r = land(['1', '-R', 'o/r', '--timeout', '30'], { cmd: ['bash', join(root, 'bin', 'land-pr.sh')] });
  assert.equal(r.rc, 0, r.err); assert.match(r.out, /compare\/main\.\.\.mergesha -> identical/);
});
