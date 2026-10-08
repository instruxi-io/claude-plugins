#!/usr/bin/env node
// `enforcer governor report [--since 24h|7d|30d] [--json] [--verbose]`
import { DIR } from './store.mjs';
import { buildReport, formatReport } from './report-data.mjs';

const args = process.argv.slice(3);
let since = '24h',
  json = false,
  verbose = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') since = args[++i];
  else if (args[i].startsWith('--since=')) since = args[i].slice(8);
  else if (args[i] === '--json') json = true;
  else if (args[i] === '--verbose') verbose = true;
  else {
    process.stderr.write('usage: enforcer governor report [--since 24h|7d|30d] [--json] [--verbose]\n');
    process.exit(1);
  }
}
try {
  const rep = buildReport(DIR, { since, verbose });
  console.log(json ? JSON.stringify(rep) : formatReport(rep));
} catch (e) {
  process.stderr.write(e.message + '\n');
  process.exit(1);
}
