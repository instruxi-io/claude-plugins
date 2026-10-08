// The rule: only src/config.mjs reads the API base URL variable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = ['ENFORCER', 'BASE', 'URL'].join('_');

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'test') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|cjs)$/.test(f) && !/\.test\./.test(f)) out.push(p);
  }
  return out;
}

test('only config.mjs reads ENFORCER_BASE_URL', () => {
  const skip = [join(ROOT, 'src', 'config.mjs'), join(ROOT, 'lib', 'api') + '/'];
  const bad = [];
  for (const d of ['src', 'lib', 'hooks', 'bin']) {
    for (const p of walk(join(ROOT, d))) {
      if (p === skip[0] || p.startsWith(skip[1])) continue;
      if (readFileSync(p, 'utf8').includes(NAME)) bad.push(relative(ROOT, p));
    }
  }
  assert.deepEqual(bad, []);
});

test('precedence is flag, environment, saved sign-in, default', () => {
  const env = { [NAME]: 'https://env.example' };
  const saved = { enforcer: { base_url: 'https://saved.example' } };
  assert.equal(resolveConfig({ flag: 'https://flag.example', env, saved }).source, 'flag');
  assert.equal(resolveConfig({ env, saved }).baseUrl, 'https://env.example');
  assert.equal(resolveConfig({ env: {}, saved }).baseUrl, 'https://saved.example');
  assert.equal(resolveConfig({ env: {}, saved: null }).source, 'default');
});
