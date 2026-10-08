// Timing assertions: p95 over N runs against a budget relative to this host (a calibration loop), never an absolute ms.
import { performance } from 'node:perf_hooks';

export function p95(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

// ms of a fixed CPU loop on this host: a slow runner gets a proportionally larger budget
export function hostUnit() {
  const t = performance.now();
  let x = 0;
  for (let i = 0; i < 2e6; i++) x += i % 7;
  return Math.max(performance.now() - t, 0.1) + (x < 0 ? 1 : 0);
}

export function timeRuns(fn, runs = 30) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return out;
}

// assert p95 of `runs` calls of fn is under `units` host units
export function assertP95(fn, { units, runs = 30 }) {
  const got = p95(timeRuns(fn, runs));
  const budget = units * hostUnit();
  if (got > budget) throw new Error(`p95 ${got.toFixed(2)}ms exceeds budget ${budget.toFixed(2)}ms (${units} host units)`);
  return { got, budget };
}
