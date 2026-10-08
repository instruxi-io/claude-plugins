// Session state for the graph hooks: private dirs/files, actor key. Reuses
// src/state.mjs (stateBase) and the governor's migrateDir; nothing duplicated.
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync, statSync, readdirSync, openSync, fchmodSync, closeSync, writeSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateBase } from '../state.mjs';
export { stateBase };
export { migrateDir } from '../../lib/governor/core/migrate.mjs';

// mkdir -p that cannot spin: Node's recursive mkdir loops forever on an unwritable tree such as /proc/nonexistent/x.
function mkdirp(d) {
  try {
    mkdirSync(d, { mode: 0o700 });
  } catch (e) {
    if (e.code === 'EEXIST') return;
    const up = dirname(d);
    if (e.code !== 'ENOENT' || up === d) throw e;
    mkdirp(up);
    mkdirSync(d, { mode: 0o700 });
  }
}

export function privateDir(d) {
  mkdirp(d);
  try {
    if ((statSync(d).mode & 0o777) !== 0o700) chmodSync(d, 0o700);
  } catch {}
  return d;
}

/** Write a file created 0600 (an existing one is tightened). flag 'w' or 'a'. */
export function privateWrite(path, data, flag = 'w') {
  const fd = openSync(path, flag === 'a' ? 'a' : 'w', 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
    } catch {}
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export function dataDir() {
  const d = join(stateBase(), 'runs');
  privateDir(dirname(d));
  privateDir(d);
  return d;
}

export function evidenceDir() {
  const d = join(stateBase(), 'evidence');
  privateDir(dirname(d));
  privateDir(d);
  return d;
}

export function tightenState() {
  try {
    privateDir(dirname(dataDir()));
    for (const sub of ['runs', 'evidence']) {
      const d = join(stateBase(), sub);
      if (!existsSync(d)) continue;
      privateDir(d);
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isFile()) chmodSync(f, 0o600);
      }
    }
  } catch {}
}

/** The identity a run and its evidence belong to: the subagent's id (hashed) when present, else the session. */
export function actorKey(inp) {
  inp = inp || {};
  if (inp.agent_id) return createHash('sha256').update(`agent_id:${inp.agent_id}`).digest('hex').slice(0, 32);
  return inp.session_id || 'unknown';
}
