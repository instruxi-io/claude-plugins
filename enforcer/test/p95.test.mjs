import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertP95, p95 } from './p95.mjs';

test('p95 picks the 95th percentile', () => {
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
});
test('a fast function is inside a host-relative budget over 30 runs', () => {
  assertP95(() => JSON.parse('{"a":[1,2,3]}'), { units: 5 });
});
test('a slow function exceeds it', () => {
  assert.throws(() => assertP95(() => { const t = Date.now(); while (Date.now() - t < 20); }, { units: 0.01, runs: 5 }), /exceeds budget/);
});
