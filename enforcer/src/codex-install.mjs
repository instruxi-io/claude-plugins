// `enforcer harness install codex`: copy the runtime to ~/.config/enforcer/codex/<version> and put the shim on PATH.
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installShim, shimPath } from './shim.mjs';
import { assertSchema, stamp } from './schema.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const RUNTIME = ['bin', 'hooks', 'lib', 'src', 'agents', 'harness', 'package.json', 'plugin.json'];
const version = () => JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).version;

export function install({ dryRun = false, home = homedir(), out = (s) => process.stdout.write(s + '\n') } = {}) {
  const base = join(home, '.config', 'enforcer', 'codex'),
    stable = join(base, version());
  out(`${dryRun ? 'would write' : 'writing'} runtime -> ${stable}`);
  if (dryRun) {
    out(`would write ${shimPath(home)}`);
    return { ok: true, dryRun: true };
  }
  const manifestPath = join(base, 'manifest.json');
  const shimExisted = existsSync(shimPath(home));
  mkdirSync(stable, { recursive: true });
  for (const e of RUNTIME)
    cpSync(join(root, e), join(stable, e), {
      recursive: true,
      force: true,
      filter: (s) => !/(^|\/)(node_modules|\.git|test)(\/|$)/.test(s.slice(root.length)),
    });
  writeFileSync(join(base, 'VERSION'), version() + '\n');
  installShim({ home, base, out });
  const prev = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  if (prev) assertSchema(prev, manifestPath);
  const ownsShim = prev ? !!prev.shim : !shimExisted;
  writeFileSync(
    manifestPath,
    JSON.stringify(stamp({ version: version(), runtime: stable, files: [join(base, 'VERSION')], shim: ownsShim ? shimPath(home) : null }), null, 2) + '\n',
  );
  return { ok: true };
}
export function uninstall({ dryRun = false, home = homedir(), out = (s) => process.stdout.write(s + '\n') } = {}) {
  const base = join(home, '.config', 'enforcer', 'codex'),
    manifestPath = join(base, 'manifest.json');
  if (!existsSync(manifestPath)) {
    out('no codex install manifest; nothing to remove');
    return { ok: true, removed: [] };
  }
  const man = assertSchema(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  const grokStillUses = existsSync(join(home, '.config', 'enforcer', 'grok', 'manifest.json'));
  const targets = [man.runtime, ...(man.files || []), ...(man.shim && !grokStillUses ? [man.shim] : [])];
  const removed = [];
  for (const t of targets) {
    out(`${dryRun ? 'would remove' : 'removing'} ${t}`);
    if (!dryRun && existsSync(t)) {
      rmSync(t, { recursive: true, force: true });
      removed.push(t);
    }
  }
  if (!dryRun) {
    rmSync(manifestPath, { force: true });
    try {
      rmdirSync(base);
    } catch {
      /* holds files that are not ours */
    }
  }
  if (man.shim && grokStillUses) out(`left ${man.shim}: grok still uses it`);
  return { ok: true, removed };
}
