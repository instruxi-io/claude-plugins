import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the type check is part of npm test', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'test.mjs'), 'utf8');
  assert.match(src, /'tsc \(plugin source\)'/);
  assert.match(src, /'tsconfig\.json'/);
});

test('the plugin source type-checks', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});
