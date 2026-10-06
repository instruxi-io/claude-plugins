// The generated API types and clients under lib/api are committed, so they must
// match what `npm run gen:api` yields from the pinned specs (spec.lock.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, SERVICES } from '../lib/api/gen.mjs';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '../lib/api');

test('generated types match the lock (regenerate yields no diff)', async () => {
  const out = await generate();
  assert.deepEqual(Object.keys(out).sort(), [...SERVICES.map((n) => `${n}.d.ts`), 'index.mjs'].sort());
  for (const [f, body] of Object.entries(out)) {
    assert.equal(readFileSync(resolve(api, f), 'utf8') === body, true, `${f} is stale: run npm run gen:api and commit`);
  }
});

test('graph client has claim, complete, heartbeat, frontier, observations, review', async () => {
  const types = readFileSync(resolve(api, 'graph.d.ts'), 'utf8');
  for (const p of [
    '/graphs/{graphId}/frontier/claim',
    '/graphs/{graphId}/nodes/{nodeId}/runs/{runId}/complete',
    '/graphs/{graphId}/nodes/{nodeId}/runs/{runId}/heartbeat',
    '/graphs/{graphId}/frontier',
    '/graphs/{graphId}/nodes/{nodeId}/observations',
    '/graphs/{graphId}/review',
  ]) assert.ok(types.includes(`"${p}": {`), `graph.d.ts has ${p}`);
  const { graphClient, v3Client, filesClient, governanceClient } = await import('../lib/api/index.mjs');
  for (const make of [graphClient, v3Client, filesClient, governanceClient]) {
    const c = make({ baseUrl: 'http://127.0.0.1:1' });
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(typeof c[m], 'function', m);
  }
});
