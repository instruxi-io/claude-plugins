// `enforcer harness install codex`: copy the runtime to ~/.config/enforcer/codex/<version> and put the shim on PATH.
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installShim, shimPath } from './shim.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const RUNTIME = ['bin', 'hooks', 'lib', 'src', 'agents', 'harness', 'package.json', 'plugin.json'];
const version = () => JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).version;

export function install({ dryRun = false, home = homedir(), out = (s) => process.stdout.write(s + '\n') } = {}) {
  const base = join(home, '.config', 'enforcer', 'codex'), stable = join(base, version());
  out(`${dryRun ? 'would write' : 'writing'} runtime -> ${stable}`);
  if (dryRun) { out(`would write ${shimPath(home)}`); return { ok: true, dryRun: true }; }
  mkdirSync(stable, { recursive: true });
  for (const e of RUNTIME) cpSync(join(root, e), join(stable, e), { recursive: true, force: true,
    filter: (s) => !/(^|\/)(node_modules|\.git|test)(\/|$)/.test(s.slice(root.length)) });
  writeFileSync(join(base, 'VERSION'), version() + '\n');
  installShim({ home, base, out });
  return { ok: true };
}
export function uninstall({ home = homedir(), out = (s) => process.stdout.write(s + '\n') } = {}) {
  const base = join(home, '.config', 'enforcer', 'codex');
  if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  out(`removed ${base} (the shim ${shimPath(home)} is left if grok still uses it)`);
  return { ok: true };
}
