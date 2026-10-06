// pretest: the generated-API checks need the dev dependencies (openapi-typescript,
// openapi-fetch, typescript). Install them from the lockfile when missing, so CI
// and a fresh checkout need no separate install step.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!['openapi-typescript', 'openapi-fetch', 'typescript'].every((d) => existsSync(resolve(root, 'node_modules', d)))) {
  // On Windows npm is `npm.cmd`, which Node refuses to spawn without a shell since the
  // CVE-2024-27980 fix (spawnSync npm ENOENT without the suffix, EINVAL with it).
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}
