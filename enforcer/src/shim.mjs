// ~/.local/bin/enforcer: a PATH shim to the stable runtime copy, so a model whose cwd is not the plugin root can run `enforcer login`.
import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

export const shimPath = (home = homedir()) => join(home, '.local', 'bin', 'enforcer');
// The shim reads the VERSION file, so a plugin update that installs a new runtime needs no new shim.
export function shimContent(base) {
  return `#!/bin/sh\n# written by \`enforcer harness install\`\nv=$(cat "${base}/VERSION" 2>/dev/null) || { echo "enforcer: no runtime at ${base}; run: enforcer harness install" >&2; exit 1; }\nexec node "${base}/$v/bin/enforcer" "$@"\n`;
}
export function installShim(
  { home = homedir(), base, out = (s) => process.stdout.write(s + '\n'), pathEnv = process.env.PATH || '' } = /** @type {any} */ ({}),
) {
  const p = shimPath(home);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(p, shimContent(base));
  chmodSync(p, 0o755);
  out(`wrote ${p}  (shim to ${base})`);
  if (!pathEnv.split(delimiter).includes(join(home, '.local', 'bin'))) out(`add to your shell profile:  export PATH="$HOME/.local/bin:$PATH"`);
  return p;
}
export const shimExists = (home = homedir()) => existsSync(shimPath(home));
