// Run Biome from the repo root (where biome.json lives) through node, not node_modules/.bin: on Windows the .bin entry is a .cmd shim.
// Usage: node scripts/biome.mjs lint|format [--write]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENFORCER = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ENFORCER, '..');
const BIOME = join(ENFORCER, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const r = spawnSync(process.execPath, [BIOME, ...process.argv.slice(2), '.'], { cwd: REPO, stdio: 'inherit' });
process.exit(r.status ?? 1);
