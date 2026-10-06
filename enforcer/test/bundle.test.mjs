// `node --test test/bundle.test.mjs`: the support bundle lists every section and carries no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'tok_SECRETACCESSVALUE123456';
const REFRESH = 'refresh_SECRETREFRESH987654';
const GH = 'ghp_' + 'A'.repeat(30);

function build() {
  const d = mkdtempSync(join(tmpdir(), 'bundle-'));
  const home = join(d, 'home'), state = join(d, 'state');
  mkdirSync(join(home, '.enforcer'), { recursive: true });
  mkdirSync(join(state, 'logs'), { recursive: true });
  writeFileSync(join(home, '.enforcer', 'credentials.json'), JSON.stringify({ enforcer: { base_url: 'https://saved.example',
    oauth: { access_token: TOKEN, refresh_token: REFRESH, scope: 'graph:read', expires_at: '2030-01-01T00:00:00Z', client_id: 'c1' } } }));
  writeFileSync(join(state, 'logs', 'w1.jsonl'), `line one\nexport GITHUB_TOKEN=${GH}\nAuthorization: Bearer ${TOKEN}\nplain ${REFRESH}\n`);
  const env = { ...process.env, HOME: home, ENFORCER_HOME: join(home, '.enforcer'), ENFORCER_STATE_DIR: state, ENFORCER_CONFIG_HOME: join(home, 'cfg'), ENFORCER_BASE_URL: '', ENFORCER_API_KEY: '' };
  const r = spawnSync(process.execPath, [join(ROOT, 'bin/enforcer'), 'doctor', '--bundle'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const path = r.stdout.split('\n')[0];
  const x = join(d, 'x'); mkdirSync(x);
  assert.equal(spawnSync('tar', ['-xzf', path, '-C', x]).status, 0);
  const files = {};
  const dir = join(x, 'enforcer-bundle');
  for (const n of spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) files[n] = spawnSync('cat', [join(dir, n)], { encoding: 'utf8' }).stdout;
  return { r, path, files };
}

test('bundle lists every section', () => {
  const { r, files } = build();
  assert.match(r.stdout, /\.tar\.gz\n\d+ bytes/);
  for (const f of ['plugin.json', 'environment.json', 'config.json', 'credentials.json', 'doctor.json', 'hooks-log.txt', 'dispatcher-logs.txt', 'processes.json', 'receipts.json', 'outbox.json', 'plugin-list.txt', 'worker-streams.txt', 'MANIFEST.json']) assert.ok(f in files, f);
  assert.match(files['credentials.json'], /graph:read/);
  assert.match(files['credentials.json'], /2030-01-01/);
  assert.match(files['config.json'], /saved credentials/);
});

test('bundle contains no token or key value', () => {
  const { files } = build();
  const all = Object.values(files).join('\n');
  for (const s of [TOKEN, REFRESH, GH]) assert.ok(!all.includes(s), `leaked ${s}`);
});

test('redaction applied to worker streams', () => {
  const { files } = build();
  assert.match(files['worker-streams.txt'], /line one/);
  assert.match(files['worker-streams.txt'], /\[redacted:/);
  assert.ok(!files['worker-streams.txt'].includes(GH));
});
