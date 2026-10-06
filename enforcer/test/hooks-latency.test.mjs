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
const med = (f) => Array.from({ length: 15 }, f).sort((a, b) => a - b)[7];
const median = med(run);
// A slow host (a shared CI runner, a node without the compile cache) pays its own startup on top:
// the budget is 40 ms, or 20 ms over a bare `node -e 0` on this host when that is larger.
const bare = med(() => { const t = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0'], { env }); return Number(process.hrtime.bigint() - t) / 1e6; });
const budget = Math.max(40, bare + 20);
console.log(`PostToolUse (no graph context) median ${median.toFixed(1)} ms over 15 runs; bare node ${bare.toFixed(1)} ms; budget ${budget.toFixed(1)} ms`);
assert.ok(median < budget, `median ${median.toFixed(1)} ms must be < ${budget.toFixed(1)} ms`);
console.log('ok   hooks-latency');
