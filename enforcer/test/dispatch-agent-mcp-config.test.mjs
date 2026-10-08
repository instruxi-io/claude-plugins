// `node --test test/dispatch-agent-mcp-config.test.mjs`: a worker dispatched with --agent gets its own strict MCP connection
// (a 0600 per-run config holding the agent key as a header), so the stored /mcp sign-in cannot claim as the operator. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCmd, writeAgentMcpConfig, mcpConfigPath, removeAgentMcpConfigs, spawnWorker } from '../src/dispatch/launch.mjs';
import { jsonLine, addSecret, redactFile } from '../src/dispatch/logs.mjs';

const KEY = 'ag_test0123456789abcdefSECRETvalue';
const URL = 'http://127.0.0.1:9/mcp';
// spawnWorker unrefs the child (the dispatcher keeps its own loop alive): hold the test's loop open until it exits.
const settle = async (p) => { const keep = setInterval(() => {}, 50); try { return await p.done; } finally { clearInterval(keep); } };
const tmp = () => mkdtempSync(join(tmpdir(), 'enf-mcpcfg-'));

test('launchCmd adds a strict mcp config only when an agent is set', () => {
  const cfg = join(tmp(), 'mcp-n1.json');
  const withAgent = launchCmd('p', 'opus', { agent: 'Bot', agentBin: 'claude' }, 'n1', { mcpConfig: cfg });
  const i = withAgent.indexOf('--mcp-config');
  assert.ok(i > 0, 'has --mcp-config');
  assert.equal(withAgent[i + 1], cfg);
  assert.ok(withAgent.includes('--strict-mcp-config'));
  const noAgent = launchCmd('p', 'opus', { agentBin: 'claude' }, 'n1', { mcpConfig: cfg });
  assert.ok(!noAgent.includes('--mcp-config') && !noAgent.includes('--strict-mcp-config'));
  const noFile = launchCmd('p', 'opus', { agent: 'Bot', agentBin: 'claude' }, 'n1', {});
  assert.ok(!noFile.includes('--mcp-config') && !noFile.includes('--strict-mcp-config'));
  const grok = launchCmd('p', 'grok-4', { agent: 'Bot', harness: 'grok' }, 'n1', { mcpConfig: cfg });
  assert.ok(!grok.includes('--mcp-config'));
});

test('the config file is mode 0600 and the key is not in argv', () => {
  const dir = tmp();
  const p = writeAgentMcpConfig(dir, 'node-a', URL, KEY);
  assert.equal(p, mcpConfigPath(dir, 'node-a'));
  assert.equal(p, join(dir, 'mcp-node-a.json'));
  if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600);
  const body = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(body, { mcpServers: { enforcer: { type: 'http', url: URL, headers: { 'X-API-Key': KEY } } } });
  const argv = launchCmd('p', 'opus', { agent: 'Bot', agentBin: 'claude' }, 'node-a', { mcpConfig: p });
  assert.ok(!argv.some((x) => String(x).includes(KEY)), 'key absent from argv');
  // rewriting (a relaunch of the same node) still yields a 0600 file
  writeAgentMcpConfig(dir, 'node-a', URL, KEY);
  if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test('the config file is removed when the worker exits', async () => {
  const dir = tmp();
  const cfg = writeAgentMcpConfig(dir, 'node-b', URL, KEY);
  const logPath = join(dir, 'node-b.1.jsonl');
  const p = spawnWorker([process.execPath, '-e', 'process.exit(0)'], { cwd: dir, logPath, env: process.env, cleanup: [cfg], secrets: [KEY] });
  await settle(p);
  assert.equal(existsSync(cfg), false);
  // dispatcher shutdown sweeps any config left behind
  writeAgentMcpConfig(dir, 'node-c', URL, KEY);
  writeFileSync(join(dir, 'other.json'), '{}');
  removeAgentMcpConfigs(dir);
  assert.equal(existsSync(mcpConfigPath(dir, 'node-c')), false);
  assert.equal(existsSync(join(dir, 'other.json')), true);
  rmSync(dir, { recursive: true, force: true });
});

test('the agent key is redacted from worker logs', async () => {
  const dir = tmp();
  const logPath = join(dir, 'node-d.1.jsonl');
  const script = `console.log(JSON.stringify({type:'user', text: ${JSON.stringify('cat said ' + KEY + ' done')}}))`;
  const p = spawnWorker([process.execPath, '-e', script], { cwd: dir, logPath, env: process.env, secrets: [KEY] });
  await settle(p);
  const text = readFileSync(logPath, 'utf8');
  assert.ok(!text.includes(KEY), 'worker stream redacted');
  assert.match(text, /\[redacted:secret\]/);
  // a bare key in a stream file, by the registered secret alone
  writeFileSync(logPath, `plain ${KEY}\n`);
  addSecret(KEY);
  assert.equal(redactFile(logPath), 1);
  assert.ok(!readFileSync(logPath, 'utf8').includes(KEY));
  // dispatcher.jsonl lines
  const line = jsonLine(`launch x key ${KEY}`, { fields: { note: KEY } });
  assert.ok(!line.includes(KEY), 'dispatcher.jsonl redacted');
  rmSync(dir, { recursive: true, force: true });
});
