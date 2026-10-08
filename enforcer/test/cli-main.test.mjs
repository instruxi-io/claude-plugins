import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'cli main '));
const dest = join(tmp, 'a b', 'enforcer');
cpSync(pkg, dest, { recursive: true, filter: (s) => !s.includes('node_modules') });
try {
  const home = join(tmp, 'home');
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') };
  for (const [bin, args] of [
    ['login.mjs', ['status']],
    ['enforcer-workspace.mjs', ['status']],
    ['files.mjs', []],
  ]) {
    const r = spawnSync(process.execPath, [join(dest, 'bin', bin), ...args], { env, encoding: 'utf8' });
    assert.ok((r.stdout + r.stderr).trim().length > 0, `${bin} printed nothing from a path with a space`);
    if (bin === 'login.mjs') console.log('ok - login.mjs status runs from a path with a space');
    else console.log(`ok - ${bin} produces output from a path with a space`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
