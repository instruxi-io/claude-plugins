import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../hooks/grok/shim.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const ok = (m) => console.log('  ok  ' + m);

let ev = normalize({ tool_name: 'run_terminal_command', tool_input: '{"command":"ls"}', tool_response: '{"exit_code":0}' });
assert.deepEqual(ev.tool_input, { command: 'ls' }); assert.deepEqual(ev.tool_response, { exit_code: 0 });
ev = normalize(JSON.parse(readFileSync(join(root, 'harness/grok/fixtures/post-tool-use.json'), 'utf8')));
assert.equal(ev.tool_input.command, 'echo hello-from-grok');
ok('string toolInput is parsed');

for (const t of ['write_file', 'create_file', 'delete_file', 'edit_file', 'apply_patch']) {
  ev = normalize({ tool_name: t, tool_input: JSON.stringify({ path: '/x/y.txt' }) });
  assert.match(ev.tool_name, /^(Write|Edit)$/); assert.equal(ev.tool_input.file_path, '/x/y.txt');
}
assert.equal(normalize({ tool_name: 'write_file', tool_input: {} }).tool_name, 'Write');
ok('write_file maps to Write with path');

const home = mkdtempSync(join(tmpdir(), 'grok-shim1-'));
const probe = join(home, 'p.mjs');
writeFileSync(probe, "process.stdout.write(process.env.ENFORCER_HARNESS||'')");
const r = spawnSync(process.execPath, [join(root, 'hooks/grok/shim.mjs'), 'hook', 'x'], { input: '{}', encoding: 'utf8',
  env: { ...process.env, HOME: home, ENFORCER_HOME: home, GOVERNOR_HOME: join(home, 'g'), ENFORCER_HARNESS: '' } });
assert.match(readFileSync(join(root, 'hooks/grok/shim.mjs'), 'utf8'), /ENFORCER_HARNESS = 'grok'/);
ok('harness is grok');
