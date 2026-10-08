import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the lint suite is part of npm test', () => {
  const src = readFileSync(join(ROOT, 'scripts', 'test.mjs'), 'utf8');
  assert.match(src, /'lint \(biome\)'/);
  assert.match(src, /'format check \(biome\)'/);
});

test('format check passes on the tree', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'biome.mjs'), 'format'], { encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});
