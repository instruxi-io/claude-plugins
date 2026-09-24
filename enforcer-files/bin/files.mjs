#!/usr/bin/env node
// Move file BYTES between this machine and an Enforcer workspace.
//
//   files.mjs upload <path> [--name <file_name>] [--dir <directory>] [--overwrite]
//   files.mjs download <file_id|path> [--out <path>]
//   files.mjs provider
//
// Finding, reading metadata and sharing go through the enforcer MCP server's
// files_* operations. The bytes do not: a JSON tool call cannot hold a file, and
// a file's contents have no business passing through the model. So these
// commands talk to enforcer-files directly, on the sign-in every Instruxi plugin
// shares (~/.enforcer/credentials.json, written by /enforcer:login).
//
// The tenant's storage provider decides the flow (GET /storage/provider):
//   presigned (S3)        ask for a short-lived URL, PUT the bytes straight to
//                         storage, then record the upload so it is listable;
//   proxy (GCS, Storj)    send the bytes to enforcer-files as a multipart form.
import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { authHeaders, baseUrl } from '../src/credentials.mjs';

const API = '/api/v1/files/storage';
// api.instruxi.dev sits behind Cloudflare, which refuses clients that do not
// name themselves (403, "error code: 1010"). Node's fetch sends "node", which
// passes today; naming the client keeps it that way.
export const USER_AGENT = 'enforcer-files-plugin/0.1.0';

const out = (s) => process.stdout.write(s + '\n');

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--name' || a === '--dir' || a === '--out') opts[a.slice(2)] = rest[++i];
    else opts._.push(a);
  }
  return { cmd, opts };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The storage key enforcer-files returns is the FULL key:
// <instance>/t/<tenant>/u/<account>/<path>. The API's object_key parameter is
// the path under the caller's own root, and the service prepends that root
// itself, so passing the full key back asks for <root>/<root>/<path> and 404s.
// Verified live 2026-09-24. Accept either spelling.
const OWN_ROOT = /^[^/]+\/t\/[^/]+\/u\/[0-9a-f-]{36}\//i;
/** A file is named by its id (a UUID) or by its path; a full storage key is trimmed to the path. */
export const fileRef = (ref) => (UUID.test(ref) ? { file_id: ref } : { object_key: ref.replace(OWN_ROOT, '') });

async function call(fetchImpl, base, path, { method = 'GET', query, body, headers = {} } = {}) {
  const url = new URL(base + API + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const auth = await authHeaders({ fetchImpl });
  if (!Object.keys(auth).length) throw new Error('not signed in to Enforcer. Run /enforcer:login first.');
  const res = await fetchImpl(url, { method, body, headers: { ...auth, 'User-Agent': USER_AGENT, ...headers } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || json?.success === false) {
    const why = json?.error === 'insufficient_scope'
      ? `your sign-in does not allow this (${json.message}). Sign in again with /enforcer:login after an admin widens the grant.`
      : (json?.message || json?.error || text.slice(0, 200) || `HTTP ${res.status}`);
    throw new Error(`${method} ${path} → ${res.status}: ${why}`);
  }
  return json;
}

export async function provider({ fetchImpl = fetch, base = baseUrl() } = {}) {
  const r = await call(fetchImpl, base, '/provider');
  const p = r?.data || r;
  if (!p?.configured) throw new Error('this workspace has no storage provider configured; an admin sets one up first.');
  return { provider: p.provider, mode: p.upload_mode };
}

export async function upload(path, opts = {}, { fetchImpl = fetch, base = baseUrl() } = {}) {
  const abs = resolve(path);
  const size = statSync(abs).size;
  const name = opts.name || basename(abs);
  const fileName = opts.dir ? `${opts.dir.replace(/\/+$/, '')}/${name}` : name;
  const { provider: prov, mode } = await provider({ fetchImpl, base });

  if (mode === 'presigned') {
    const pre = await call(fetchImpl, base, `/file/${prov}/presigned-upload-url`, { query: { file_name: fileName, overwrite: opts.overwrite ? 'true' : undefined } });
    const put = await fetchImpl(pre.data.url, { method: 'PUT', body: readFileSync(abs), headers: { 'Content-Type': 'application/octet-stream' } });
    if (!put.ok) throw new Error(`storage refused the upload: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
    const done = await call(fetchImpl, base, `/file/${prov}/presigned-upload-complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: fileName, overwrite: !!opts.overwrite }),
    });
    return { provider: prov, path: fileName, object_key: pre.data.object_key, bytes: size, file: done?.data };
  }

  const form = new FormData();
  form.set('file', new Blob([readFileSync(abs)]), name);
  form.set('file_name', name);
  if (opts.dir) form.set('directory', opts.dir);
  if (opts.overwrite) form.set('overwrite', 'true');
  const r = await call(fetchImpl, base, `/file/${prov}/upload`, { method: 'POST', body: form });
  return { provider: prov, path: fileName, bytes: size, file: r?.data };
}

export async function download(ref, opts = {}, { fetchImpl = fetch, base = baseUrl() } = {}) {
  const { provider: prov, mode } = await provider({ fetchImpl, base });
  let res;
  if (mode === 'presigned') {
    const pre = await call(fetchImpl, base, `/file/${prov}/presigned-url`, { query: fileRef(ref) });
    res = await fetchImpl(pre.data.url);
  } else {
    const url = new URL(base + API + `/file/${prov}/download`);
    for (const [k, v] of Object.entries(fileRef(ref))) url.searchParams.set(k, v);
    res = await fetchImpl(url, { headers: { ...(await authHeaders({ fetchImpl })), 'User-Agent': USER_AGENT } });
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const dest = resolve(opts.out || basename(ref));
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return { provider: prov, path: dest, bytes: statSync(dest).size };
}

async function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  if (cmd === 'provider') {
    const p = await provider();
    out(`Storage: ${p.provider} (${p.mode === 'presigned' ? 'uploads go straight to storage by presigned URL' : 'uploads pass through enforcer-files'}).`);
  } else if (cmd === 'upload' && opts._[0]) {
    const r = await upload(opts._[0], opts);
    out(`Uploaded ${r.bytes} bytes to ${r.provider} as ${r.path}.`);
    const id = r.file?.file_id || r.file?.id;
    out(`Download it with: /enforcer-files:download ${id || r.path}`);
  } else if (cmd === 'download' && opts._[0]) {
    const r = await download(opts._[0], opts);
    out(`Downloaded ${r.bytes} bytes from ${r.provider} to ${r.path}.`);
  } else {
    out('Usage: files.mjs upload <path> [--name <n>] [--dir <d>] [--overwrite] | download <file_id|path> [--out <path>] | provider');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => { out(`enforcer-files: ${e.message}`); process.exitCode = 1; });
}
