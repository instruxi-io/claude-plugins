#!/usr/bin/env node
// Fetch each deployed server's swagger document into a directory the contract test reads (CONTRACT_SPEC_DIR).
//   node scripts/fetch-live-specs.mjs <outdir>
// The URL of a service is <CONTRACT_BASE_URL | https://api.instruxi.dev>/api/v1/<service>/swagger/doc.json,
// overridable per service with CONTRACT_URL_GRAPH, CONTRACT_URL_ENFORCER, CONTRACT_URL_FILES, CONTRACT_URL_GOVERNANCE.
// Files are named like the pinned specs (graph, v3, files, governance). Any service that does not answer fails the run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: fetch-live-specs.mjs <outdir>'); process.exit(2); }
const base = (process.env.CONTRACT_BASE_URL || 'https://api.instruxi.dev').replace(/\/+$/, '');
const SERVICES = { graph: 'graph', enforcer: 'v3', files: 'files', governance: 'governance' };
mkdirSync(out, { recursive: true });
let failed = 0;
for (const [service, name] of Object.entries(SERVICES)) {
  const url = process.env[`CONTRACT_URL_${service.toUpperCase()}`] || `${base}/api/v1/${service}/swagger/doc.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    if (!doc.paths) throw new Error('no `paths`: not a swagger document');
    writeFileSync(join(out, `${name}.json`), JSON.stringify(doc));
    console.log(`ok   ${service}: ${url} (${Object.keys(doc.paths).length} paths)`);
  } catch (e) { failed++; console.error(`FAIL ${service}: ${url}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
