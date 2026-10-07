import { realpathSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachEvidence, attachFiles, checkPr, overrideEntries, clientFor } from '../../src/graph/hooks/attach.mjs';
import { appendEvidence } from '../../src/graph/evidence.mjs';
import { saveRun } from '../../src/graph/run.mjs';
import { markAttested } from '../../src/graph/hooks/common.mjs';

const REPORT = 'mcp__plugin_enforcer_enforcer__graph_report';
const HEARTBEAT = 'mcp__plugin_enforcer_enforcer__graph_heartbeat';
const REMEMBER = 'mcp__plugin_enforcer_enforcer__graph_remember';
const NEXT = 'mcp__plugin_enforcer_enforcer__graph_next_work';

let n = 0;
function fresh(hints = [{ criterion: 'c1', kind: 'check' }, { criterion: 'c2', kind: 'file' }]) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'attach-'));
  process.env.ENFORCER_STATE_DIR = join(root, 'state');
  delete process.env.GRAPH_EVIDENCE_MODE;
  const sid = `s${++n}`;
  saveRun(sid, { run_id: 'r1', node_id: 'n1', graph_id: 'g1', claimed_at: '2026-01-01T00:00:00Z', acceptance_evidence: hints });
  return { root, sid };
}
const rep = (sid, extra = {}, tool = REPORT) => ({ session_id: sid, tool_name: tool, tool_input: { graph: 'g', node_id: 'n1', run_id: 'r1', status: 'succeeded', report: 'x', ...extra } });
const ui = (o) => o?.hookSpecificOutput?.updatedInput;
const big = 'x'.repeat(5000);

test('denied report uploads nothing', async () => {
  const { sid } = fresh();
  appendEvidence(sid, { kind: 'command', cmd: 'echo hi', exit: 0, output: 'hi', raw: big, _run: 'r1' });
  let uploads = 0;
  const out = await attachEvidence(rep(sid), { upload: async () => { uploads++; return null; } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /criterion 2/);
  assert.equal(uploads, 0);
});

test('override without a line index is refused', async () => {
  const { sid } = fresh();
  appendEvidence(sid, { kind: 'command', cmd: 'echo hi', exit: 0, output: 'hi', _run: 'r1' });
  for (const ov of [true, { reason: 'no line' }, { line: true, reason: 'r' }, [{ line: 2 }]]) {
    const out = await attachEvidence(rep(sid, { evidence_override: ov }), {});
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(ov));
  }
  assert.equal(overrideEntries({ reason: 'x' }), null);
});

test('override with a line and reason is let through and recorded', async () => {
  const { sid } = fresh();
  appendEvidence(sid, { kind: 'command', cmd: 'echo hi', exit: 0, output: 'hi', _run: 'r1' });
  const out = await attachEvidence(rep(sid, { evidence_override: { line: 2, reason: 'no file applies' } }), {});
  const a = ui(out);
  assert.deepEqual(a.data.overrides, [{ line: 2, reason: 'no file applies' }]);
  assert.equal(a.evidence_override, undefined);
});

test('PR URL is resolved, not trusted', async () => {
  const { sid } = fresh([]);
  appendEvidence(sid, { kind: 'command', cmd: 'echo hi', exit: 0, output: 'hi', _run: 'r1' });
  const url = 'https://github.com/o/r/pull/999999';
  const missing = await attachEvidence(rep(sid, { pr: url }), { gh: () => ({ status: 1, stderr: 'GraphQL: Could not resolve to a PullRequest\n' }) });
  const ev = ui(missing).evidence.find((e) => e.kind === 'artifact');
  assert.equal(ev.label, 'pull request NOT FOUND');
  const ok = checkPr(url, () => ({ status: 0, stdout: JSON.stringify({ state: 'MERGED', title: 'T', mergedAt: '2026-01-01', url }) }));
  assert.match(ok.output, /state=MERGED merged=2026-01-01/);
  assert.equal(checkPr('not a url', () => { throw new Error('no'); }), null);
  assert.equal(checkPr(url, () => null), null); // no gh: fail open
});

test('usage is attached from the transcript', async () => {
  const { root, sid } = fresh();
  const tp = join(root, 't.jsonl');
  const line = (id, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'm1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, content: [] } });
  writeFileSync(tp, [line('a', '2025-12-31T00:00:00Z'), line('b', '2026-01-02T00:00:00Z'), line('b', '2026-01-02T00:00:01Z')].join('\n'));
  appendEvidence(sid, { kind: 'command', cmd: 'cat f', exit: 0, output: 'o', _run: 'r1' });
  const out = await attachEvidence({ ...rep(sid), transcript_path: tp }, {});
  const a = ui(out);
  assert.equal(a.data.usage.model, 'm1');
  assert.equal(a.data.usage.messages, 1); // only since the claim, deduped by message id
  assert.equal(a.usage.input_tokens, 10);
  assert.equal(a.usage.model, 'm1');
  // a heartbeat gets the typed field only
  const hb = await attachEvidence({ session_id: sid, tool_name: HEARTBEAT, transcript_path: tp, tool_input: { graph: 'g' } }, {});
  assert.equal(ui(hb).usage.input_tokens, 10);
  assert.equal(ui(hb).data, undefined);
});

test('client is hooks=on only once a capture marker exists', async () => {
  const { sid } = fresh();
  const before = await attachEvidence({ session_id: sid, tool_name: NEXT, tool_input: { graph: 'g', client: 'made-up' } }, {});
  assert.match(ui(before).client, /hooks=off:no-capture-yet$/);
  markAttested(sid);
  const after = await attachEvidence({ session_id: sid, tool_name: NEXT, tool_input: { graph: 'g', client: 'made-up' } }, {});
  assert.match(ui(after).client, /; hooks=on$/);
  assert.equal(clientFor({ session_id: sid }), ui(after).client);
  assert.equal(await attachEvidence({ session_id: sid, tool_name: REMEMBER, tool_input: {} }, {}), null);
});

test('upload sets file id and always drops raw', async () => {
  const items = [{ kind: 'command', raw: big }, { kind: 'command', raw: 'short' }];
  process.env.GRAPH_FILES_BASE_URL = 'http://files.test';
  try {
    await attachFiles(items, {}, async () => '11111111-2222-3333-4444-555555555555');
  } finally { delete process.env.GRAPH_FILES_BASE_URL; }
  assert.equal(items[0].file, '11111111-2222-3333-4444-555555555555');
  assert.equal(items[0].file_bytes, 5000);
  assert.equal(items[0].raw, undefined);
  assert.equal(items[1].file, undefined);
  assert.equal(items[1].raw, undefined);
});

test('garbage input is silent; context mode hands evidence over', async () => {
  assert.equal(await attachEvidence(null, {}), null);
  assert.equal(await attachEvidence({ tool_name: 5 }, {}), null);
  const { sid } = fresh([]);
  appendEvidence(sid, { kind: 'command', cmd: 'echo hi', exit: 0, output: 'hi', _run: 'r1' });
  process.env.GRAPH_EVIDENCE_MODE = 'context';
  try {
    const out = await attachEvidence(rep(sid), {});
    assert.match(out.hookSpecificOutput.additionalContext, /VERBATIM/);
    assert.equal(out.hookSpecificOutput.updatedInput, undefined);
  } finally { delete process.env.GRAPH_EVIDENCE_MODE; }
});

function freshAcc(acceptance) {
  const { root, sid } = fresh([]);
  saveRun(sid, { run_id: 'r1', node_id: 'n1', graph_id: 'g1', key: 'k', claimed_at: '2026-01-01T00:00:00Z', acceptance_evidence: [], acceptance });
  const cwd = join(root, 'wt'); mkdirSync(cwd); writeFileSync(join(cwd, 'f.txt'), 'hello\n');
  return { sid, cwd };
}

test('report attaches the output of each acceptance command', async () => {
  const { sid, cwd } = freshAcc(['ls f.txt prints the file', 'cat f.txt prints "hello"', 'ls missing.txt prints the file']);
  appendEvidence(sid, { kind: 'command', cmd: 'echo hi', exit: 0, output: 'hi', _run: 'r1' });
  const out = await attachEvidence({ ...rep(sid), cwd }, {});
  const ev = ui(out).evidence;
  assert.equal(ev[0].exit !== 0, true); // failing first
  const ls = ev.find((e) => e.cmd === 'ls f.txt');
  assert.match(ls.output, /f\.txt/);
  assert.equal(ls.exit, 0);
  assert.match(ev.find((e) => e.cmd === 'cat f.txt').output, /hello/);
  assert.ok(ev.some((e) => e.cmd === 'echo hi'));
  assert.ok(ev.length <= 20);
});

test('a timed-out acceptance command is a record with exit 124', async () => {
  const { sid, cwd } = freshAcc(['node -e "setTimeout(()=>{},5000)" prints nothing']);
  const out = await attachEvidence({ ...rep(sid), cwd }, { acceptanceTimeoutMs: 300 });
  const rec = ui(out).evidence.find((e) => (e.cmd || '').startsWith('node -e'));
  assert.equal(rec.exit, 124);
});

test('a write command in an acceptance line is skipped with a note', async () => {
  const { sid, cwd } = freshAcc(['rm f.txt prints nothing', 'echo x > g.txt prints nothing', 'git push prints done']);
  const out = await attachEvidence({ ...rep(sid), cwd }, {});
  const ev = ui(out).evidence;
  assert.equal(ev.filter((e) => e.kind === 'note').length, 2);
  assert.match(ev.find((e) => e.kind === 'note').text, /was not run/);
  assert.ok(!ev.some((e) => e.kind === 'command'));
  assert.equal(existsSync(join(cwd, 'f.txt')), true);
  assert.equal(existsSync(join(cwd, 'g.txt')), false);
});

test('no acceptance or no worktree attaches nothing extra', async () => {
  const { sid } = freshAcc([]);
  assert.equal(ui(await attachEvidence({ ...rep(sid), cwd: '/nonexistent-x' }, {})).evidence, undefined);
});
