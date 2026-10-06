// A PostToolUse with no graph context is the hot path: one node process, no python.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const cli = fileURLToPath(new URL('../bin/enforcer', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'hooks-latency-'));
const cwd = mkdtempSync(join(tmpdir(), 'nocfg-')); // no .enforcer above it
const env = { ...process.env, CLAUDE_PLUGIN_DATA: join(base, 'data'), HOME: base, CLAUDE_CONFIG_DIR: join(base, 'cc') };
delete env.GRAPH_ID; delete env.ENFORCER_STATE_DIR;
const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'lat-1', cwd, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } });
const run = () => { const t = process.hrtime.bigint(); const r = spawnSync(process.execPath, [cli, 'event', 'post-tool-use'], { input, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return Number(process.hrtime.bigint() - t) / 1e6; };
run(); run(); // warm the file cache
const ms = Array.from({ length: 15 }, run).sort((a, b) => a - b);
const median = ms[7];
console.log(`PostToolUse (no graph context) median ${median.toFixed(1)} ms over 15 runs (min ${ms[0].toFixed(1)}, max ${ms[14].toFixed(1)})`);
assert.ok(median < 40, `median ${median.toFixed(1)} ms must be < 40 ms`);
console.log('ok   hooks-latency');
