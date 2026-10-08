// One run id joins the worker run, its PR, the judge's evidence and the governor receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiFetch } from '../lib/api/client.mjs';
import { Verdict } from '../lib/governor/core/verdict.mjs';
import { workerEnv } from '../src/dispatch/launch.mjs';
import { workerPrompt } from '../src/dispatch/summarize.mjs';
import { captureEvidence } from '../src/graph/hooks/capture.mjs';
import { saveRun } from '../src/graph/run.mjs';
import { loadEvidence, stripInternal, prFooter } from '../src/graph/evidence.mjs';
import { logHook } from '../src/graph/hooklog.mjs';
import { readFileSync } from 'node:fs';

const RUN = '75ca5f8b-236f-4ae9-82aa-688d9f49bbd5';

test('run id present in request header, receipt, PR body and evidence', async () => {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'corr-'));
  Object.assign(process.env, { ENFORCER_STATE_DIR: join(root, 'state'), HOME: root, GRAPH_RUN_ID: RUN, ENFORCER_DEBUG: '1' });
  try {
    // request header: X-Request-Id always, X-Enforcer-Run when a run is live
    let seen;
    await apiFetch(
      'http://x.invalid/a',
      {},
      {
        fetchImpl: async (u, init) => {
          seen = init.headers;
          return { ok: true, status: 200 };
        },
      },
    );
    assert.equal(seen['X-Enforcer-Run'], RUN);
    assert.ok(seen['X-Request-Id']);
    delete process.env.GRAPH_RUN_ID;
    await apiFetch(
      'http://x.invalid/a',
      {},
      {
        fetchImpl: async (u, init) => {
          seen = init.headers;
          return { ok: true, status: 200 };
        },
      },
    );
    assert.equal(seen['X-Enforcer-Run'], undefined, 'no run, no header');
    process.env.GRAPH_RUN_ID = RUN;

    // dispatcher: the lander's (and any known-run) worker env carries it
    assert.equal(workerEnv('g1', {}, { runId: RUN }).GRAPH_RUN_ID, RUN);

    // governor receipt
    const entry = Verdict.allow('ok').entry({ agent: 'a', tool: 'Bash', runId: RUN, graphId: 'g1' });
    assert.equal(entry.decision.run_id, RUN);
    assert.equal(entry.graph_id, 'g1');

    // PR body: the worker prompt asks for the footer, and the footer names the run
    assert.equal(prFooter(RUN), `Enforcer-Run: ${RUN}`);
    assert.match(workerPrompt('g1', { id: 'n1', key: 'k', title: 't' }, '/w', 'graph/k'), /Enforcer-Run: <run_id/);

    // evidence: captured under the held run, leaves with run_id
    saveRun('s1', { graph_id: 'g1', node_id: 'n1', run_id: RUN, key: 'k' });
    await captureEvidence({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: 'ok' },
    });
    const recs = loadEvidence('s1', RUN);
    assert.ok(recs.length > 0);
    for (const r of recs) assert.equal(stripInternal(r).run_id, RUN);

    // hook log line
    logHook({ hook: 'capture', event: 'PostToolUse', actor: 's1', outcome: 'ok', ms: 1, code: 0 }, { force: true });
    const { logPath } = await import('../src/graph/hooklog.mjs');
    assert.equal(JSON.parse(readFileSync(logPath(), 'utf8').trim().split('\n').at(-1)).run_id, RUN);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
