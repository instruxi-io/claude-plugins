// The graph's context pack: one immutable file per graph, fetched once per hash into the state dir and injected byte-identical.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { http } from './http.mjs';
import { stateBase, privateDir, privateWrite } from './state.mjs';
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

export const FETCH_TIMEOUT_MS = 3000;
const SHA = /^[0-9a-f]{64}$/i;

/** ENFORCER_CONTEXT_PACK=0 (set by `enforcer dispatch run --context off`) turns the injection off. */
export const contextEnabled = (env = process.env) => !/^(0|off|false)$/i.test(String(env.ENFORCER_CONTEXT_PACK ?? '1').trim());

/** The first line of the injected text; the file bytes follow it unchanged. */
export const packHeader = (sha) => `enforcer-graph context pack ${String(sha).slice(0, 12)}\n`;

const cachePath = (sha) => join(stateBase(), 'context', `${String(sha).toLowerCase()}.md`);

/** Default download: the existing files download path (bin/files.mjs), bounded by a 3 s timeout. */
export async function downloadPack(ref, dest) {
  const mod = '../../bin/files.mjs'; // a variable specifier: bin/files.mjs is its own program, not part of the typechecked source graph
  const { download } = await import(mod);
  const fetchImpl = (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  await download(ref, { out: dest, force: true }, { fetchImpl });
}

/**
 * The text to inject, or null (no graph, switched off, no pack, or a failure). Never throws; a failure prints one stderr notice.
 * `post(cfg, 'GET', path)` returns the parsed body or null; `fetchFile(ref, dest)` writes the file to dest.
 */
export async function contextPackText(cfg, { post = http, fetchFile = downloadPack, env = process.env, warn = (m) => process.stderr.write(m + '\n') } = {}) {
  try {
    if (!cfg || !contextEnabled(env)) return null;
    // api-used: reads data.pack.sha256,data.pack.file_id
    const body = await post(cfg, 'GET', `/graphs/${cfg.graph_id}/context`, undefined, { timeoutMs: FETCH_TIMEOUT_MS });
    const d = isObj(body) && isObj(body.data) ? body.data : body;
    const pack = isObj(d) ? d.pack : null;
    if (!isObj(pack) || !SHA.test(String(pack.sha256 || ''))) return null;
    const sha = String(pack.sha256).toLowerCase();
    const p = cachePath(sha);
    if (!existsSync(p)) {
      const ref = pack.file_id || pack.path;
      if (!ref) return null;
      privateDir(join(stateBase(), 'context'));
      const tmp = `${p}.part-${process.pid}`;
      try {
        await fetchFile(String(ref), tmp);
        const bytes = readFileSync(tmp);
        if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('sha256 does not match the graph row');
        privateWrite(p, bytes);
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    return packHeader(sha) + readFileSync(p, 'utf8');
  } catch (e) {
    try {
      warn(`enforcer-graph: context pack not injected (${String(e?.message || e).slice(0, 120)})`);
    } catch {}
    return null;
  }
}
