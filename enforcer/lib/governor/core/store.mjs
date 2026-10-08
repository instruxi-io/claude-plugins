// Local state for the governor. No daemon, no socket, no port.
//
// v1 ran an HTTP daemon on :4000 so hooks could share state. That bought one
// thing (state in memory) and cost several: a process to manage, a port to
// collide, "is it running?" as a user-facing question, and an unauthenticated
// local API that any web page could reach. v2 keeps state in files instead.
// Nothing listens, so none of that exists.
//
// The price is a lock. Hooks are separate processes and Claude Code runs tool
// calls in parallel, so the receipt chain has the same ordering problem the
// daemon solved with a promise queue: hashes are computed in decision order,
// so the lines have to LAND in decision order. Here that is an exclusive
// lockfile held across read-decide-append.
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  readSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { makeState } from './policy.mjs';
import { migrateDir } from './migrate.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE || '.';
// Governor records live under ~/.config/enforcer/governor. Before 2.10 they were
// in ~/.enforcer-governor; the first run moves them (receipt chain intact) and
// leaves MOVED_TO behind. GOVERNOR_HOME, when set, is used as given.
export const CONFIG_HOME = process.env.ENFORCER_CONFIG_HOME || join(HOME, '.config', 'enforcer');
export const LEGACY_DIR = join(HOME, '.enforcer-governor');
export const DIR = process.env.GOVERNOR_HOME || join(CONFIG_HOME, 'governor');
if (!process.env.GOVERNOR_HOME) migrateDir(LEGACY_DIR, DIR);
export const RECEIPTS = join(DIR, 'receipts.jsonl');
const STATE = join(DIR, 'state.json');
const CONFIG = join(DIR, 'config.json');
const LOCK = join(DIR, '.lock');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const readJSON = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};

// ── The lock ────────────────────────────────────────────────────────────────
// `wx` fails if the file exists, and that failure is atomic on every platform
// we care about -- which is the whole mechanism. The lock file carries its
// owner's pid and a token. A lock is stale only when that pid is dead (a live
// holder is waited on, never broken by age), and release() removes the file
// only when the token is still ours, so a late release can never delete the
// lock a later process now holds.
const WAIT_MS = 2000;
const UNREADABLE_MS = 5000; // a lock with no readable owner: its writer died between open and write
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let myToken = null;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const lockOwner = () => {
  try {
    const [pid, token] = readFileSync(LOCK, 'utf8').trim().split(':');
    return Number.isInteger(+pid) && +pid > 0 && token ? { pid: +pid, token } : null;
  } catch {
    return undefined;
  } // vanished
};
// Remove the lock only if it is still the one we judged stale.
const breakStale = (seen) => {
  const now = lockOwner();
  if (now === undefined) return;
  if ((seen && now && now.token === seen.token) || (!seen && !now)) {
    try {
      unlinkSync(LOCK);
    } catch {}
  }
};

function acquire() {
  const deadline = Date.now() + WAIT_MS;
  const token = randomBytes(8).toString('hex');
  for (;;) {
    try {
      const fd = openSync(LOCK, 'wx');
      try {
        writeSync(fd, `${process.pid}:${token}`);
      } finally {
        closeSync(fd);
      }
      myToken = token;
      return true;
    } catch {}
    // The deadline is checked before anything below can `continue` past it, so
    // an unreachable directory fails open instead of spinning forever.
    if (Date.now() > deadline) return false;
    try {
      const owner = lockOwner();
      if (owner && !alive(owner.pid)) {
        breakStale(owner);
        continue;
      }
      if (owner === null && Date.now() - statSync(LOCK).mtimeMs > UNREADABLE_MS) {
        breakStale(null);
        continue;
      }
    } catch {} // vanished between the calls: retry after a beat
    sleep(15);
  }
}
const release = () => {
  const owner = lockOwner();
  if (owner && owner.token === myToken) {
    try {
      unlinkSync(LOCK);
    } catch {}
  }
  myToken = null;
};

// Run fn holding the lock. Returns { ok, value }. Never throws: a governor that
// crashes the hook is worse than one that fails to record.
export function withLock(fn) {
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {}
  if (!acquire()) return { ok: false, value: undefined };
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false, value: undefined };
  } finally {
    release();
  }
}

// policy.mjs owns the chain (record() hashes against state.prevHash), so this
// only has to carry that state across processes. `chain` is the in-memory tail
// and is deliberately not persisted: the FILE is the record, and verify()
// walks it. chainStart is set to the recovered head so an in-memory check
// starts from the oldest link this process actually knows about.
// The head of the receipt file: the hash of its last hashed line, read from the
// tail so a long record costs one small read. null when there is none.
export function receiptHead(file = RECEIPTS) {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 1 << 16);
    const fd = openSync(file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const lines = text.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (typeof e.hash === 'string') return e.hash;
      } catch {}
    }
  } catch {}
  return null;
}

export function loadState() {
  const s = makeState();
  const saved = readJSON(STATE, null);
  if (saved) {
    for (const k of ['agents', 'periods', 'burn', 'spawns', 'clients', 'unmapped', 'prevHash']) {
      if (saved[k] !== undefined) s[k] = saved[k];
    }
  }
  // The file is the record. A crash between the receipt and the state write, or
  // a state file that is gone or half-written, leaves state behind the chain:
  // continue from the chain's own head so the next receipt extends it.
  const head = receiptHead();
  if (head && head !== s.prevHash) s.prevHash = head;
  s.chainStart = s.prevHash;
  return s;
}

// tmp + fsync + rename: a reader sees the old state or the new one, never half.
export function saveState(s) {
  const { chain, ...rest } = s; // never persist the tail
  const tmp = STATE + '.' + process.pid + '.tmp';
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(rest));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, STATE);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}
export const loadConfig = () => readJSON(CONFIG, {});
export const saveConfig = (c) => {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CONFIG, JSON.stringify(c, null, 2));
  } catch {}
};

// Write the line record() already hashed. Caller holds the lock, so lines land
// in decision order -- twelve agents deciding at once was enough to interleave
// concurrent appends and break a chain that was perfectly correct in memory.
export function writeReceipt(entry, hash) {
  // A line with no hash must say so (`chained: false`, the blind path): verify()
  // accepts those as recorded-but-unchained and rejects any other hashless line.
  try {
    appendFileSync(RECEIPTS, JSON.stringify(hash ? { ...entry, hash } : entry) + '\n');
    return true;
  } catch {
    return false;
  }
}

// Append the receipt, then (only if the append landed) advance the chain head
// and persist the state. A failed append -- disk full -- leaves the head where
// it was, so the next receipt extends the last line that really exists.
export function commit(state, entry, hash, before = state.prevHash) {
  if (!writeReceipt(entry, hash)) {
    state.prevHash = before;
    return false;
  }
  state.prevHash = hash;
  saveState(state);
  return true;
}

// Walk the file, not memory: the file is the record. Names the first line
// that does not add up, so an edit or a deletion anywhere is named -- and
// still counts every line, so "line 3 of N" says how much of the record
// sits after the break.
export function verify(file = RECEIPTS, { state } = /** @type {any} */ ({})) {
  if (!existsSync(file)) return { ok: true, receipts: 0, brokeAt: 0 };
  let prev = 'genesis',
    n = 0,
    legacy = 0,
    brokeAt = 0,
    hashed = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    n++;
    if (brokeAt) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      brokeAt = n;
      continue;
    }
    const { hash, ...body } = e;
    // Lines from before the chain existed may open the file; once a hashed line
    // has been seen, a line without one is a stripped hash, not history.
    if (!hash) {
      if (e.chained === false) {
        legacy++;
        continue;
      } // the blind path's own, declared as such: unverifiable, not tampering
      if (hashed) {
        brokeAt = n;
        continue;
      }
      legacy++;
      continue;
    }
    hashed = true;
    if (sha256(prev + JSON.stringify(body)) !== hash) {
      brokeAt = n;
      continue;
    }
    prev = hash;
  }
  if (brokeAt) return { ok: false, receipts: n, brokeAt };
  // The head must be the one state last recorded: a truncated tail still chains
  // line by line, and only the head shows that lines are missing.
  const st = state ?? (file === RECEIPTS ? readJSON(STATE, null) : null);
  if (st && typeof st.prevHash === 'string' && hashed && st.prevHash !== prev) {
    return { ok: false, receipts: n, brokeAt: n, headMismatch: true, head: prev };
  }
  return { ok: true, receipts: n, brokeAt: 0, unverifiable: legacy || undefined, head: prev };
}
