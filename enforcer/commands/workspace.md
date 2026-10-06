---
description: List the Enforcer workspaces you belong to, switch between them, or show the current one
argument-hint: "list | switch <name|code|tenant_id> | current"
allowed-tools: "Bash(node:*), Bash(ENFORCER_ARGS=*), mcp__plugin_enforcer_enforcer__enforcer_whoami"
---
Invoke the `enforcer` skill's `workspace` procedure (skills/enforcer/workspace.md) with the arguments the command line below carries.
!`ENFORCER_ARGS='$ARGUMENTS' node "${CLAUDE_PLUGIN_ROOT}/bin/enforcer-workspace.mjs"`
