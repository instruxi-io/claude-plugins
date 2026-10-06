// `node --test enforcer/test`: node 22 does not expand a directory argument, it runs `node enforcer/test`, which
// resolves to this file. Run every *.test.mjs under test/ as one inner `node --test` and register one outer test per inner
// result, so the outer runner counts every test and fails on any.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = [];
for (const d of ['', 'graph', 'dispatch']) {
  for (const f of readdirSync(join(here, d))) if (f.endsWith('.test.mjs')) files.push(join(here, d, f));
}
// the outer runner marks this process as its child; an inner `node --test` must not inherit that
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
const results = [];
for (const line of (r.stdout || '').split('\n')) {
  const m = /^\s*(not ok|ok) \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/.exec(line);
  if (m) results.push([m[1], m[2]]);
}
if (r.status !== 0 && !results.some(([st]) => st === 'not ok')) results.push(['not ok', 'inner node --test failed']);
if (r.status !== 0) process.stderr.write((r.stdout || '').split('\n').slice(-80).join('\n') + '\n');
// one outer test per inner result: the outer runner then counts, and fails on, each of them
for (const [st, name] of results) test(name, () => { assert.equal(st, 'ok'); });
