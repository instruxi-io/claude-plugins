// First-run migration of state from an old location to its new one.
//
// Moves every entry of `from` into `to` (never overwriting something already
// there), then leaves `from/MOVED_TO` naming the new directory so a person who
// looks at the old place finds where it went. Runs once: a `from` that already
// holds MOVED_TO, or does not exist, is left alone. Fails open: state that
// cannot be moved stays where it is and the caller starts fresh.
import { existsSync, mkdirSync, chmodSync, readdirSync, renameSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const POINTER = 'MOVED_TO';

export function migrateDir(from, to) {
  const moved = [];
  try {
    if (resolve(from) === resolve(to) || !existsSync(from) || existsSync(join(from, POINTER))) return moved;
    mkdirSync(to, { recursive: true, mode: 0o700 });
    try {
      chmodSync(to, 0o700);
    } catch {}
    for (const name of readdirSync(from)) {
      const src = join(from, name),
        dst = join(to, name);
      if (existsSync(dst)) continue;
      try {
        renameSync(src, dst);
      } catch {
        cpSync(src, dst, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      }
      moved.push(name);
    }
    writeFileSync(join(from, POINTER), to + '\n');
  } catch {}
  return moved;
}
