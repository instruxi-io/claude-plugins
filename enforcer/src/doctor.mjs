// `enforcer doctor`: one line per check, `ok`/`fail`, exit non-zero on any fail.
import { defaultFetch } from '../lib/api/client.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, mkdirSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stateBase } from './state.mjs';
import { readCredentials, enforcerKey, DEFAULT_BASE_URL } from './credentials.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** python3 on PATH: {ok, detail}. A null status / error means it could not be spawned. */
export function python3Check(args = ['--version']) {
  const r = spawnSync('python3', args, { encoding: 'utf8', timeout: 10_000 });
  if (r.error || r.status === null) return { ok: false, detail: `python3 not found on PATH (${r.error?.code || 'cannot spawn'}); the graph hooks cannot run` };
  return { ok: r.status === 0, detail: (r.stdout || r.stderr || '').trim() || (r.status === 0 ? 'present' : `exit ${r.status}`) };
}

export function hookCommandsCheck(root = ROOT) {
  let doc;
  try { doc = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')); } catch (e) { return { ok: false, detail: `hooks.json unreadable: ${e.message}` }; }
  const missing = []; let n = 0;
  for (const groups of Object.values(doc.hooks || {})) for (const g of groups) for (const h of g.hooks || []) {
    for (const m of String(h.command || '').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)) {
      n++; if (!existsSync(join(root, m[1]))) missing.push(m[1]);
    }
  }
  return missing.length ? { ok: false, detail: `missing under the plugin root: ${[...new Set(missing)].join(', ')}` } : { ok: true, detail: `${n} script paths resolve` };
}

export async function runChecks({ fetchImpl = defaultFetch, network = true } = {}) {
  const rows = [];
  const add = (name, c) => rows.push({ name, ...c });
  const major = Number(process.versions.node.split('.')[0]);
  add('node version', { ok: major >= 18, detail: process.versions.node });
  const py = python3Check();
  add('python3 present', py);
  if (py.ok) {
    const f = python3Check(['-c', 'import fcntl']);
    add('fcntl importable', { ok: f.ok, detail: f.ok ? 'import fcntl ok' : 'python3 cannot import fcntl (Windows?)' });
  } else add('fcntl importable', { ok: false, detail: 'skipped: python3 absent' });
  try {
    const d = stateBase(); mkdirSync(d, { recursive: true }); accessSync(d, constants.W_OK);
    const mode = statSync(d).mode & 0o777;
    add('state dir writable, 0700', { ok: process.platform === 'win32' || mode === 0o700, detail: `${d} mode ${mode.toString(8)}` });
  } catch (e) { add('state dir writable, 0700', { ok: false, detail: e.message }); }
  const cred = readCredentials();
  add('credentials present', { ok: !!(enforcerKey() || cred?.enforcer?.oauth?.access_token), detail: enforcerKey() ? 'API key in environment' : cred?.enforcer?.oauth?.access_token ? 'browser sign-in' : 'none; run /enforcer:login' });
  if (network) {
    const base = String(process.env.ENFORCER_BASE_URL || cred?.enforcer?.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
    try {
      const r = await fetchImpl(`${base}/mcp`, { method: 'GET', signal: AbortSignal.timeout(5000) });
      add('MCP reachable', { ok: true, detail: `${base}/mcp answered HTTP ${r.status}` });
    } catch (e) { add('MCP reachable', { ok: false, detail: `${base}/mcp: ${e.cause?.code || e.message}` }); }
  }
  add('hooks.json commands resolve', hookCommandsCheck());
  return rows;
}

export async function doctor(opts) {
  const rows = await runChecks(opts);
  for (const r of rows) process.stdout.write(`${r.ok ? 'ok  ' : 'fail'}  ${r.name}: ${r.detail}\n`);
  const bad = rows.filter((r) => !r.ok).length;
  process.stdout.write(bad ? `${bad} check(s) failed\n` : 'all checks passed\n');
  return bad ? 1 : 0;
}
