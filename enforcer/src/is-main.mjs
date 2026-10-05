// True when `metaUrl` (an import.meta.url) is the script node was started with.
// Comparing against `file://${argv[1]}` breaks on percent-encoded paths
// (spaces, non-ASCII), Windows drive paths and symlinks.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
