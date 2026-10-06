import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../enforcer/src/doctor.mjs';

test('win32 doctor prints the support statement', async () => {
  const rows = await runChecks({ network: false, platform: 'win32' });
  const r = rows.find((x) => x.name === 'windows support');
  assert.ok(r && r.ok);
  assert.match(r.detail, /MCP, files and the governor are supported/);
  assert.match(r.detail, /dispatch is POSIX only/);
  assert.match(r.detail, /no process groups/);
});

test('linux doctor omits the Windows statement', async () => {
  const rows = await runChecks({ network: false, platform: 'linux' });
  assert.ok(!rows.some((x) => x.name === 'windows support'));
});
