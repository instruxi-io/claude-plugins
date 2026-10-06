// The node gate (bin/enforcer graphContextLive) keys by actor and never gates graph_* handlers.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin/enforcer');
const base = mkdtempSync(join(tmpdir(), 'hooks-gate-'));
const data = join(base, 'data');
const cwd = mkdtempSync(join(tmpdir(), 'nocfg-')); // no .enforcer above it (tmpdir)
const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
delete env.GRAPH_ID; delete env.ENFORCER_STATE_DIR;
const hook = (event, handler, ev) => spawnSync(process.execPath, [cli, 'hook', event, handler], { input: JSON.stringify(ev), env, encoding: 'utf8' });

// subagent: run under sha256(agent_id), no project config
const aid = 'agent-xyz';
const key = createHash('sha256').update(`agent_id:${aid}`).digest('hex').slice(0, 32);
mkdirSync(join(data, 'runs'), { recursive: true });
writeFileSync(join(data, 'runs', `${key}.json`), JSON.stringify({ run_id: 'r1', node_id: 'n', graph_id: 'g' }));
const r = hook('post-tool-use', 'capture-evidence', { session_id: 's1', agent_id: aid, cwd, tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: { stdout: 'hi' } });
assert.equal(r.status, 0, r.stderr);
assert.ok(existsSync(join(data, 'evidence', `${key}.jsonl`)), 'capture_evidence ran for the subagent');
console.log('ok - subagent PostToolUse in a worktree cwd with no config reaches capture_evidence');

// first claim, no prior state: track-run runs and writes the run file
const card = { state: 'claimed', graph_id: 'g', node: { node_id: 'n2', key: 'k' }, run: { run_id: 'r2' } };
const t = hook('post-tool-use', 'track-run', { session_id: 's2', cwd, tool_name: 'mcp__plugin_enforcer_enforcer__graph_next_work', tool_input: {}, tool_response: card });
assert.equal(t.status, 0, t.stderr);
assert.ok(existsSync(join(data, 'runs', 's2.json')), 'track-run wrote the run file');
const p = hook('pre-tool-use', 'attach-evidence', { session_id: 's3', cwd, tool_name: 'mcp__plugin_enforcer_enforcer__graph_next_work', tool_input: {} });
assert.equal(p.status, 0);
console.log('ok - graph_next_work PreToolUse runs track-run with no prior state');
