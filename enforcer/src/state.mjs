// Where session state (graph runs, captured evidence) lives:
//   $ENFORCER_STATE_DIR, else the directory the harness hands the plugin,
//   else ~/.config/enforcer/sessions/<harness>   (harness: $ENFORCER_HARNESS, default claude)
// The graph hooks (src/graph/*) use the same path.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { migrateDir } from '../lib/governor/core/migrate.mjs';
import { pluginDataEnv, legacyStateDir } from '../hooks/claude/paths.mjs';

const home = () => process.env.HOME || process.env.USERPROFILE || homedir();
export const configHome = () => process.env.ENFORCER_CONFIG_HOME || join(home(), '.config', 'enforcer');

export function stateBase() {
  const explicit = process.env.ENFORCER_STATE_DIR || pluginDataEnv();
  if (explicit) { migrateDir(legacyStateDir(), explicit); return explicit; }
  const d = join(configHome(), 'sessions', process.env.ENFORCER_HARNESS || 'claude');
  migrateDir(legacyStateDir(), d);
  return d;
}
