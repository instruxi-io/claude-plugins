// Starting the shipper, apart from shipping itself (ship.mjs). A hook only ever kicks: a stat and,
// at most every `everyMs`, a detached spawn. Kept in its own module so a hook does not load the
// shipper's network code (http.mjs, the API client, the outbox reader) just to decide not to kick.
import { statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIR, privateDir, FILE_MODE } from './store.mjs';

const spawn = (...a) => process.getBuiltinModule('node:child_process').spawn(...a); // lazy: only the throttled kick spawns
const KICKED = () => join(DIR, '.ship.kicked');

// The shipper kick() starts when the adapter names none: the core's own, which
// travels with the core wherever it is installed. It used to be the plugin's
// bin/ship.mjs, reached by walking out of core/ -- see core/bin/ship.mjs.
export const SHIPPER = join(dirname(fileURLToPath(import.meta.url)), 'bin', 'ship.mjs');

/**
 * Start a detached shipper if one has not been started recently. Called from
 * hooks: it costs a stat and, at most every `everyMs`, a process spawn that the
 * hook does not wait for. `shipper` is the script to start.
 */
export function kick(everyMs = 30_000, shipper = SHIPPER) {
  try {
    if (Date.now() - statSync(KICKED()).mtimeMs < everyMs) return false;
  } catch {
    /* never kicked */
  }
  try {
    privateDir(DIR);
    writeFileSync(KICKED(), String(Date.now()), { mode: FILE_MODE });
    spawn(process.execPath, [shipper], { detached: true, stdio: 'ignore', env: process.env }).unref();
    return true;
  } catch {
    return false;
  }
}
