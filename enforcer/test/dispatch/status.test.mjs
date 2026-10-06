// `node --test test/dispatch/status.test.mjs`: dispatch status shows the failed criteria of a review item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { failedLines } from '../../src/dispatch-command.mjs';

test('status prints failed criteria with probabilities', () => {
  const n = { key: 'a', status: 'failed', verdict: { state: 'rejected', threshold: 0.8, failed: [{ criterion: '2. npm test exits 0', probability: 0.31 }, { criterion: '3. file exists', probability: 0.5 }] } };
  const out = failedLines(n).join('\n');
  assert.match(out, /threshold 0.8/);
  assert.match(out, /failed: 2\. npm test exits 0 \(probability 0\.31\)/);
  assert.match(out, /failed: 3\. file exists \(probability 0\.5\)/);
});

test('status prints nothing extra without failed[]', () => {
  assert.deepEqual(failedLines({ verdict: { state: 'rejected' } }), []);
});
