// A REAL headless `claude -p` worker, plugin hooks on, against a stub graph server.
// Skipped unless ENFORCER_REAL_CLAUDE=1 and ANTHROPIC_API_KEY are both set (it spends real money, capped at $0.50).
// Which workflow step should run it: the nightly step 'a real claude -p worker' (.github/workflows/nightly.yml) should run this
// file with ENFORCER_REAL_CLAUDE=1 and ANTHROPIC_API_KEY set; today it only runs run.test.mjs. A person edits the workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNodeStub } from './stub-graph-server.mjs';
import { launchCmd, PLUGIN_DIR } from '../../src/dispatch/launch.mjs';

const enabled = process.env.ENFORCER_REAL_CLAUDE === '1' && !!process.env.ANTHROPIC_API_KEY;
const reason = 'set ENFORCER_REAL_CLAUDE=1 and ANTHROPIC_API_KEY to run a real claude -p worker (spends up to $0.50)';

test('real worker end to end', { skip: enabled ? false : reason, timeout: 600_000 }, async () => {
  const work = mkdtempSync(join(realpathSync(tmpdir()), 'real-worker-'));
  const tree = join(work, 'worktree');
  const home = join(work, 'home');
  mkdirSync(tree, { recursive: true });
  mkdirSync(home, { recursive: true });
  const node = { node_id: 'n1', key: 'hello-file', title: 'Create hello.txt', description: 'Create a file hello.txt in the current directory containing the word hello.', acceptance: ['hello.txt exists and contains hello'] };
  const stub = await startNodeStub({ node });
  mkdirSync(join(tree, '.enforcer'), { recursive: true });
  writeFileSync(join(tree, '.enforcer', 'graph.json'), JSON.stringify({ graph_id: 'g1', base_url: stub.url, api_key_env: 'GRAPH_API_KEY' }) + '\n');
  try {
    const prompt = `Graph g1, node n1 (key hello-file). Claim it with graph_next_work and work it per your instructions. Your worktree is ${tree}.`;
    const cmd = launchCmd(prompt, 'sonnet', { maxBudgetUsd: 0.5, pluginDir: [PLUGIN_DIR] }, node.key, { maxTurns: 12 });
    assert.ok(cmd.includes('--max-budget-usd') && cmd.includes('--max-turns'));
    const env = { ...process.env, HOME: process.env.HOME, GRAPH_API_KEY: 'stub-key', ENFORCER_BASE_URL: stub.url, GRAPH_ID: 'g1' };
    const out = await new Promise((resolve) => {
      const c = spawn(cmd[0], cmd.slice(1), { cwd: tree, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      c.stdout.on('data', (d) => { o += d; });
      c.stderr.on('data', (d) => { o += d; });
      c.on('close', () => resolve(o));
    });
    const tail = out.slice(-2000);
    assert.ok(stub.claims >= 1, `node was claimed\n${tail}`);
    assert.ok(stub.heartbeats >= 1, 'at least one heartbeat arrived');
    assert.ok(stub.reports.some((r) => Array.isArray(r.evidence) && r.evidence.length > 0), 'the report carried evidence');
    assert.ok(stub.completed, 'the run was completed');
    assert.ok(existsSync(join(tree, 'hello.txt')) && /hello/.test(readFileSync(join(tree, 'hello.txt'), 'utf8')), 'hello.txt exists');
  } finally {
    await stub.close();
    rmSync(work, { recursive: true, force: true });
  }
});
