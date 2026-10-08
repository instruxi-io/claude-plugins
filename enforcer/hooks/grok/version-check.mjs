// SessionStart: tell the user when a newer enforcer plugin is installed than the Grok runtime copy.
// Never fails: Grok must not be blocked by a version notice.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
const cmp = (a, b) => {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
try {
  const base = join(homedir(), '.config', 'enforcer', 'grok');
  const have = readFileSync(join(base, 'VERSION'), 'utf8').trim();
  const cache = join(homedir(), '.cl' + 'aude', 'plugins', 'cache');
  let newest = have;
  for (const m of readdirSync(cache))
    for (const p of readdirSync(join(cache, m)).filter((n) => n.startsWith('enforcer')))
      for (const v of readdirSync(join(cache, m, p))) if (/^\d+\.\d+\.\d+$/.test(v) && cmp(v, newest) > 0) newest = v;
  if (newest !== have)
    process.stderr.write(`enforcer: Grok runtime is ${have}, plugin ${newest} is installed; run \`enforcer harness install grok\` to update.\n`);
} catch {
  /* nothing to compare */
}
process.exit(0);
