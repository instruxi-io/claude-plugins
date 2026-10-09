// Data minimization. Telemetry never exports prompt text or tool parameters,
// the settings file keeps its mode, the governor's files are private under a
// permissive umask, verify notices a deleted receipt file, a machine that never
// signed in makes no network call at session start, and the report labels a
// built-in rule by its code.
// `node --test lib/governor/test/data-protection.test.mjs`. No network, temp HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReport } from '../core/report-data.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const url = (p) => pathToFileURL(here(p)).href;
const ENFORCER = here('../../../bin/enforcer');
const TELEMETRY_BIN = here('../bin/telemetry.mjs');
const UMASK = 'data:text/javascript,process.umask(0o022)';
const POSIX = process.platform !== 'win32';
const mode = (p) => statSync(p).mode & 0o777;

// A machine of its own: temp HOME, signed out, not headless, not in a graph run.
function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'gov-data-protection-'));
  const config = join(home, '.config', 'enforcer');
  const gov = join(config, 'governor');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (/^(ENFORCER_|GRAPH_|JEV_HOOKS_|ANTHROPIC_|GOVERNOR_|CLAUDE_|OTEL_)/.test(k)) delete env[k];
  env.ENFORCER_HOME = join(home, '.enforcer');
  env.CLAUDE_CONFIG_DIR = join(home, 'cc');
  env.CLAUDE_SETTINGS_PATH = join(env.CLAUDE_CONFIG_DIR, 'settings.json');
  env.ENFORCER_STATE_DIR = join(home, 'state');
  return { home, config, gov, env, settings: env.CLAUDE_SETTINGS_PATH };
}
// Run an ES module body in a child under umask 022 with the machine's env.
const child = (m, body, extra = {}) => {
  const r = spawnSync(process.execPath, ['--import', UMASK, '--input-type=module', '-e', body], { env: { ...m.env, ...extra }, encoding: 'utf8', cwd: m.home });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
};
const telemetry = (m, cmd) => {
  const r = spawnSync(process.execPath, ['--import', UMASK, TELEMETRY_BIN, cmd], { env: m.env, encoding: 'utf8', cwd: m.home });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('telemetry on removes the prompt and tool detail env keys', () => {
  const m = fresh();
  mkdirSync(m.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(m.settings, JSON.stringify({ env: { OTEL_LOG_USER_PROMPTS: '1', OTEL_LOG_TOOL_DETAILS: '1', KEEP_ME: 'yes' }, theme: 'dark' }));

  // status warns while they are there
  const before = telemetry(m, 'status');
  assert.match(before, /Warning: OTEL_LOG_USER_PROMPTS and OTEL_LOG_TOOL_DETAILS are set/);

  const on = telemetry(m, 'on');
  assert.match(on, /Removed OTEL_LOG_USER_PROMPTS and OTEL_LOG_TOOL_DETAILS from /);
  assert.match(on, /Prompt text is not exported/);
  const s = JSON.parse(readFileSync(m.settings, 'utf8'));
  assert.equal(s.env.OTEL_LOG_USER_PROMPTS, undefined);
  assert.equal(s.env.OTEL_LOG_TOOL_DETAILS, undefined);
  assert.equal(s.env.KEEP_ME, 'yes', 'other env keys are kept');
  assert.equal(s.theme, 'dark');
  assert.equal(s.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');

  const after = telemetry(m, 'status');
  assert.doesNotMatch(after, /Warning/);
  assert.match(after, /telemetry: on/);
});

test('writing settings keeps the file mode', { skip: !POSIX && 'file modes are POSIX' }, () => {
  const m = fresh();
  mkdirSync(m.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(m.settings, JSON.stringify({ env: {} }));
  chmodSync(m.settings, 0o600);
  telemetry(m, 'on');
  assert.equal(mode(m.settings), 0o600, 'on keeps 0600');
  telemetry(m, 'off');
  assert.equal(mode(m.settings), 0o600, 'off keeps 0600');
  assert.equal(mode(m.settings + '.enforcer-backup'), 0o600, 'the backup is no wider than the file');

  // a file the user chose to make 0640 stays 0640
  chmodSync(m.settings, 0o640);
  telemetry(m, 'on');
  assert.equal(mode(m.settings), 0o640);

  // a file this creates is 0600, under umask 022
  const n = fresh();
  telemetry(n, 'on');
  assert.equal(mode(n.settings), 0o600);
});

test('governor files are 0600 and directories 0700 under umask 022', { skip: !POSIX && 'file modes are POSIX' }, () => {
  const m = fresh();
  // What an older version left behind: a world-readable dir and files.
  mkdirSync(m.gov, { recursive: true });
  chmodSync(m.config, 0o755);
  chmodSync(m.gov, 0o755);
  for (const f of ['cursor-old.json', 'identity.json']) {
    writeFileSync(join(m.gov, f), '{}');
    chmodSync(join(m.gov, f), 0o644);
  }

  // A real decision through the hook writes receipts, state and the lock.
  writeFileSync(join(m.gov, 'config.json'), JSON.stringify({ rulesOn: true }));
  chmodSync(join(m.gov, 'config.json'), 0o644);
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, session_id: 'dataprot01', cwd: m.home };
  const r = spawnSync(process.execPath, ['--import', UMASK, ENFORCER, 'governor', 'decide'], { env: m.env, input: JSON.stringify(ev), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(mode(m.config), 0o700, '~/.config/enforcer is 0700');
  assert.equal(mode(m.gov), 0o700, 'the governor dir is 0700');
  for (const f of ['cursor-old.json', 'identity.json', 'config.json']) assert.equal(mode(join(m.gov, f)), 0o600, `${f} was tightened on start`);

  // Every writer, in one child, under umask 022. The identity fetch is stubbed.
  child(
    m,
    `
    const store = await import(${JSON.stringify(url('../core/store.mjs'))});
    const { installId } = await import(${JSON.stringify(url('../core/ship.mjs'))});
    const { markFailure } = await import(${JSON.stringify(url('../core/outbox.mjs'))});
    const { recordHarnessCost } = await import(${JSON.stringify(url('../adapters/claude-code/meter.mjs'))});
    const { refreshIdentity } = await import(${JSON.stringify(url('../core/identity.mjs'))});
    store.saveConfig({ rulesOn: true });
    store.writeReceipt({ ts: new Date().toISOString(), verdict: 'allow', chained: false });
    installId();
    markFailure('test');
    recordHarnessCost('s1', { total_cost_usd: 1 });
    const r = await refreshIdentity({}, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: { email: 'a@b.c', account_id: 'acct' } }) }) });
    if (!r.ok) throw new Error('identity: ' + r.detail);
    `,
    { ENFORCER_API_KEY: 'ek_test_dataprotection' },
  );
  const files = readdirSync(m.gov).filter((f) => statSync(join(m.gov, f)).isFile());
  for (const f of ['receipts.jsonl', 'state.json', 'config.json', 'outbox.json', 'install.json', 'identity.json', 'cost-s1.json']) {
    assert.ok(files.includes(f), `${f} was written`);
  }
  for (const f of files) assert.equal(mode(join(m.gov, f)), 0o600, `${f} is 0600`);
  assert.equal(mode(m.gov), 0o700);
});

test('verify fails when the receipt file is missing but state has a head', () => {
  const m = fresh();
  mkdirSync(m.gov, { recursive: true });
  // A fresh install: nothing at all verifies.
  let v = spawnSync(process.execPath, [ENFORCER, 'governor', 'verify'], { env: m.env, encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /No decisions recorded yet/);

  // Receipts were written, then the file was deleted: state still names a head.
  writeFileSync(join(m.gov, 'state.json'), JSON.stringify({ prevHash: 'a'.repeat(64) }));
  v = spawnSync(process.execPath, [ENFORCER, 'governor', 'verify'], { env: m.env, encoding: 'utf8' });
  assert.equal(v.status, 1, v.stdout + v.stderr);
  assert.match(v.stdout, /does NOT check out/);
  assert.match(v.stdout, /receipts\.jsonl is missing/);
  assert.match(v.stdout, /only copy outside this machine/);
});

test('no network call is made without a credential', () => {
  const m = fresh();
  const probe = (extra) =>
    child(
      m,
      `
      let calls = 0;
      globalThis.fetch = async () => { calls++; throw new Error('offline'); };
      const { notices } = await import(${JSON.stringify(url('../../../src/graph/hooks/session.mjs'))});
      await notices();
      process.stdout.write('CALLS=' + calls);
      `,
      extra,
    );
  assert.equal(probe({}), 'CALLS=0', 'signed out: no fetch');
  // The control: with a credential the health fetch does happen.
  assert.notEqual(probe({ ENFORCER_API_KEY: 'ek_test_dataprotection' }), 'CALLS=0');
});

test('report labels built-in rules by their code', () => {
  const m = fresh();
  mkdirSync(m.gov, { recursive: true });
  writeFileSync(join(m.gov, 'config.json'), JSON.stringify({ rulesOn: true }));
  const ev = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, session_id: 'dataprot02', cwd: m.home };
  const r = spawnSync(process.execPath, [ENFORCER, 'governor', 'decide'], { env: m.env, input: JSON.stringify(ev), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(join(m.gov, 'receipts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const hit = lines.find((x) => x.verdict === 'deny' || x.verdict === 'ask');
  assert.ok(hit, 'the built-in rule decided: ' + JSON.stringify(lines));
  assert.equal(hit.decision.code, 'destructive_delete');
  assert.notEqual(hit.rule, 'fs.delete_tree', 'the receipt stores the human name, not the id');
  const rep = buildReport(m.gov);
  assert.equal(rep.decision_codes[`${hit.verdict}:destructive_delete`], 1, JSON.stringify(rep.decision_codes));
  assert.equal(rep.decision_codes[`${hit.verdict}:custom_rule`], undefined);
  assert.ok(existsSync(join(m.gov, 'receipts.jsonl')));
});
