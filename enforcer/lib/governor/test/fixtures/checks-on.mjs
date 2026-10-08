// Decisioning is off by default (core/policy.mjs DEFAULTS). Suites that test the
// checks themselves turn them on explicitly, with this config, rather than
// relying on the defaults.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHECKS_ON = Object.freeze({ budgetOn: true, rulesOn: true, policyOn: true });

/** Write a config.json turning the checks on into a governor home (GOVERNOR_HOME). */
export function writeChecksOn(dir, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...CHECKS_ON, ...extra }, null, 2));
}
