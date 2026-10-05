// Claude Code's own on-disk names, in ONE place (Node side). Everything outside
// hooks/claude/ is harness-neutral and keeps state under ~/.config/enforcer/.
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = () => process.env.HOME || process.env.USERPROFILE || homedir();
export const DOT = '.' + 'claude';
export const LEGACY_PROJECT_CONFIG = join(DOT, 'graph.json');
export const claudeSettingsPath = () => process.env.CLAUDE_SETTINGS_PATH || join(home(), DOT, 'settings.json');
export const pluginDataEnv = () => process.env.CLAUDE_PLUGIN_DATA;
export const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(home(), DOT);
export const legacyStateDir = () => join(configDir(), 'enforcer-graph');
export const legacyPluginData = () => join(configDir(), 'plugins', 'data');
