#!/usr/bin/env bash
# One install, from nothing: a throwaway CLAUDE_CONFIG_DIR with only this
# marketplace added, `claude plugin install enforcer@instruxi`, and then the
# graph hooks fired from the INSTALLED copy exactly as hooks.json declares them.
# Never touches ~/.claude. Needs the `claude` CLI; no sign-in, no model session
# (a session would need credentials the throwaway config does not have).
#
#   bash test/clean-install.sh [marketplace-source]   default: this checkout
set -euo pipefail
SRC="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
export CLAUDE_CONFIG_DIR="$(mktemp -d /tmp/cc-clean-install-XXXX)"
trap 'rm -rf "$CLAUDE_CONFIG_DIR"' EXIT
echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"
echo "\$ claude plugin marketplace add $SRC"; claude plugin marketplace add "$SRC" 2>&1 | tail -1
echo "\$ claude plugin install enforcer@instruxi"; claude plugin install enforcer@instruxi 2>&1 | tail -1
echo "\$ claude plugin list"; claude plugin list 2>&1
echo "\$ claude plugin details enforcer@instruxi | grep MCP"; claude plugin details enforcer@instruxi 2>&1 | grep "MCP servers"
echo "\$ claude plugin details enforcer@instruxi | grep Hooks"; claude plugin details enforcer@instruxi 2>&1 | grep "Hooks"

# Fire the installed copy's PreToolUse hook on a graph_next_work call, as the
# harness would: matcher from hooks.json, command with CLAUDE_PLUGIN_ROOT set.
node --input-type=module - <<'EOF'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const cfg = process.env.CLAUDE_CONFIG_DIR;
const inst = JSON.parse(readFileSync(join(cfg, 'plugins', 'installed_plugins.json'), 'utf8')).plugins;
const root = inst['enforcer@instruxi'][0].installPath;
const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
const tool = 'mcp__plugin_enforcer_enforcer__graph_next_work';
for (const g of hooks.PreToolUse) {
  const m = g.matcher;
  if (m && m !== '*' && !new RegExp(`^(?:${m})$`).test(tool)) continue;
  for (const h of g.hooks) {
    const cmd = h.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root, GRAPH_ID: 'g1', CLAUDE_PLUGIN_DATA: join(cfg, 'plugins', 'data', 'enforcer-instruxi') };
    const stdin = JSON.stringify({ session_id: 'clean-install', hook_event_name: 'PreToolUse', tool_name: tool,
      tool_input: { graph: 'g1', runner: 'clean-install' }, cwd: '/tmp' });
    const out = spawnSync(cmd, { shell: true, input: stdin, encoding: 'utf8', env });
    console.log(`hook fired: PreToolUse ${tool} -> ${cmd.split('/').pop()} exit=${out.status}`);
    if (out.stdout.trim()) {
      const ui = JSON.parse(out.stdout).hookSpecificOutput?.updatedInput;
      if (ui !== undefined) console.log('updatedInput:', JSON.stringify(ui));
    }
  }
}
EOF
