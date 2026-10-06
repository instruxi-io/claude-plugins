// The per-actor run file (runs/<key>.json), 0600.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, evidenceDir, privateWrite } from './state.mjs';

export const runPath = (sid) => join(dataDir(), `${sid || 'unknown'}.json`);

export function loadRun(sid) {
  try { return JSON.parse(readFileSync(runPath(sid), 'utf8')); } catch { return null; }
}

export function saveRun(sid, run) { privateWrite(runPath(sid), JSON.stringify(run)); }

export function clearRun(sid) {
  for (const s of ['.json', '.count']) { try { rmSync(join(dataDir(), `${sid || 'unknown'}${s}`)); } catch {} }
  try { rmSync(join(evidenceDir(), `${sid || 'unknown'}.jsonl`)); } catch {}
}
