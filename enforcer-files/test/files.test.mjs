// The upload and download commands against a stub of enforcer-files and of the
// storage behind a presigned URL. Both provider flows, a scope refusal, and a
// machine that is not signed in.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'files-plugin-'));
process.env.HOME = home; process.env.ENFORCER_HOME = join(home, '.enforcer'); process.env.GOVERNOR_HOME = join(home, '.g');
delete process.env.ENFORCER_API_KEY;

const { upload, download, provider, parseArgs, fileRef, USER_AGENT } = await import('../bin/files.mjs');

let pass = 0;
const ok = async (label, fn) => { await fn(); pass++; console.log('  ok  ' + label); };

// --- the stub: enforcer-files + the bucket a presigned URL points at
const state = { mode: 'presigned', provider: 's3', stored: {}, refuse: false, log: [] };
const srv = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const u = new URL(req.url, 'http://x');
  const base = `http://127.0.0.1:${srv.address().port}`;
  const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  state.log.push({ m: req.method, p: u.pathname, ua: req.headers['user-agent'], key: req.headers['x-api-key'] });

  if (u.pathname.startsWith('/bucket/')) { // the presigned target: no enforcer credential
    const k = decodeURIComponent(u.pathname.slice('/bucket/'.length));
    if (req.method === 'PUT') { state.stored[k] = body; return json(200, {}); }
    if (req.method === 'GET') { res.writeHead(200); return res.end(state.stored[k] || ''); }
  }
  if (!req.headers['x-api-key']) return json(401, { success: false, error: 'unauthorized' });
  const P = '/api/v1/files/storage';
  if (u.pathname === `${P}/provider`) return json(200, { provider: state.provider, configured: true, upload_mode: state.mode });
  if (state.refuse) return json(403, { success: false, error: 'insufficient_scope', message: 'this operation requires enforcer:files-files.write' });
  if (u.pathname === `${P}/file/s3/presigned-upload-url`) {
    const k = 'u1/' + u.searchParams.get('file_name');
    return json(200, { success: true, data: { url: `${base}/bucket/${encodeURIComponent(k)}`, object_key: k, expires_in: 900 } });
  }
  if (u.pathname === `${P}/file/s3/presigned-upload-complete`) {
    const b = JSON.parse(body.toString());
    return json(200, { success: true, data: { file_id: '11111111-2222-3333-4444-555555555555', file_name: b.file_name } });
  }
  if (u.pathname === `${P}/file/s3/presigned-url`) {
    const k = u.searchParams.get('object_key') || 'u1/by-id.txt';
    return json(200, { success: true, data: { url: `${base}/bucket/${encodeURIComponent(k)}` } });
  }
  if (u.pathname === `${P}/file/gcs/upload` && req.method === 'POST') {
    state.lastMultipart = body.toString('latin1');
    return json(200, { success: true, data: { file_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } });
  }
  if (u.pathname === `${P}/file/gcs/download`) { res.writeHead(200); return res.end(Buffer.from('gcs bytes')); }
  json(404, { success: false, error: 'not_found' });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const src = join(home, 'report.pdf');
writeFileSync(src, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]));

await ok('arguments: flags and the file', () => {
  const { cmd, opts } = parseArgs(['upload', 'a b.txt', '--dir', 'docs', '--overwrite']);
  assert.deepEqual([cmd, opts._[0], opts.dir, opts.overwrite], ['upload', 'a b.txt', 'docs', true]);
  assert.deepEqual(fileRef('11111111-2222-3333-4444-555555555555'), { file_id: '11111111-2222-3333-4444-555555555555' });
  assert.deepEqual(fileRef('u1/docs/a.txt'), { object_key: 'u1/docs/a.txt' });
});

await ok('not signed in: says so, calls nothing that needs a credential', async () => {
  await assert.rejects(provider({ base }), /not signed in to Enforcer/);
});

process.env.ENFORCER_API_KEY = 'env3_' + 'k'.repeat(43);

await ok('presigned (S3): the bytes go straight to storage, then the upload is recorded', async () => {
  state.log = [];
  const r = await upload(src, { dir: 'docs' }, { base });
  assert.equal(r.object_key, 'u1/docs/report.pdf');
  assert.deepEqual([...state.stored['u1/docs/report.pdf']], [...readFileSync(src)], 'exact bytes, binary-safe');
  const put = state.log.find((l) => l.m === 'PUT');
  assert.equal(put.key, undefined, 'no Enforcer credential is sent to the storage URL');
  assert.ok(state.log.some((l) => l.p.endsWith('/presigned-upload-complete')), 'recorded so it is listable');
  assert.equal(r.file.file_id, '11111111-2222-3333-4444-555555555555');
});

await ok('presigned (S3): download by object key writes the exact bytes', async () => {
  const dest = join(home, 'out.pdf');
  const r = await download('u1/docs/report.pdf', { out: dest }, { base });
  assert.deepEqual([...readFileSync(dest)], [...readFileSync(src)]);
  assert.equal(r.bytes, readFileSync(src).length);
});

await ok('every enforcer-files call names the client (Cloudflare refuses anonymous agents)', () => {
  const api = state.log.filter((l) => l.p.startsWith('/api/'));
  assert.ok(api.length && api.every((l) => l.ua === USER_AGENT), JSON.stringify(api.map((l) => l.ua)));
});

await ok('proxy (GCS): the file goes to enforcer-files as multipart, with its name and directory', async () => {
  Object.assign(state, { mode: 'proxy', provider: 'gcs' });
  const r = await upload(src, { dir: 'docs' }, { base });
  assert.equal(r.provider, 'gcs');
  assert.match(state.lastMultipart, /name="file"; filename="report\.pdf"/);
  assert.match(state.lastMultipart, /name="directory"\r\n\r\ndocs/);
  assert.ok(state.lastMultipart.includes(readFileSync(src).toString('latin1')), 'the bytes are in the form');
});

await ok('proxy (GCS): download streams from enforcer-files', async () => {
  const dest = join(home, 'g.txt');
  await download('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { out: dest }, { base });
  assert.equal(readFileSync(dest, 'utf8'), 'gcs bytes');
});

await ok('a scope refusal says what is missing and how to fix it, not "HTTP 403"', async () => {
  Object.assign(state, { mode: 'presigned', provider: 's3', refuse: true });
  await assert.rejects(upload(src, {}, { base }), /does not allow this.*enforcer:files-files\.write.*\/enforcer:login/s);
});

srv.close();
console.log(`\n  ${pass} passed`);
