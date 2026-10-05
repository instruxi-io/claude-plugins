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
python3 - <<'EOF'
import json, os, re, subprocess
cfg = os.environ["CLAUDE_CONFIG_DIR"]
inst = json.load(open(os.path.join(cfg, "plugins", "installed_plugins.json")))["plugins"]
root = inst["enforcer@instruxi"][0]["installPath"]
hooks = json.load(open(os.path.join(root, "hooks", "hooks.json")))["hooks"]
tool = "mcp__plugin_enforcer_enforcer__graph_next_work"
for g in hooks["PreToolUse"]:
    if not re.fullmatch(g["matcher"], tool):
        continue
    for h in g["hooks"]:
        cmd = h["command"].replace("${CLAUDE_PLUGIN_ROOT}", root)
        env = {**os.environ, "CLAUDE_PLUGIN_ROOT": root, "GRAPH_ID": "g1", "CLAUDE_PLUGIN_DATA": os.path.join(cfg, "plugins", "data", "enforcer-instruxi")}
        stdin = json.dumps({"session_id": "clean-install", "hook_event_name": "PreToolUse", "tool_name": tool,
                            "tool_input": {"graph": "g1", "runner": "clean-install"}, "cwd": "/tmp"})
        out = subprocess.run(cmd, shell=True, input=stdin, capture_output=True, text=True, env=env)
        print(f"hook fired: PreToolUse {tool} -> {cmd.split('/')[-1]} exit={out.returncode}")
        print("updatedInput:", json.dumps(json.loads(out.stdout)["hookSpecificOutput"]["updatedInput"]))
EOF
