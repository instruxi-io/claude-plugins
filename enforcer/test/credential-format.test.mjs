// The governor and the plugin share ONE credentials module and one file shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cred-format-'));
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.ENFORCER_HOME = join(home, '.enforcer');
delete process.env.ENFORCER_API_KEY;

const plugin = await import('../src/credentials.mjs');
const governor = await import('../lib/governor/core/credentials.mjs');
const legacy = await import('../lib/governor/src/credentials.mjs');

test('governor and plugin export the same functions', () => {
  assert.deepEqual(Object.keys(governor).sort(), Object.keys(plugin).sort());
  for (const k of Object.keys(plugin)) assert.equal(governor[k], plugin[k], k);
  for (const k of Object.keys(plugin)) assert.equal(legacy[k], plugin[k], k);
});

test('governor and plugin read the same credential file', () => {
  const doc = { enforcer: { api_key: 'env3_' + 'x'.repeat(43) } };
  governor.saveCredentials(doc);
  assert.deepEqual(plugin.readCredentials(), doc);
  assert.equal(governor.SHARED_FILE(), plugin.SHARED_FILE());
  assert.deepEqual(JSON.parse(readFileSync(plugin.SHARED_FILE(), 'utf8')), doc);
});

test('refresh under the shared lock', async () => {
  assert.equal(governor.refreshLockPath(), plugin.refreshLockPath());
  const release = await governor.acquireRefreshLock();
  assert.equal(typeof release, 'function');
  await release();
  const again = await plugin.acquireRefreshLock();
  await again();
});
