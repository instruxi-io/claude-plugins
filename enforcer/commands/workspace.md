---
description: List the Enforcer workspaces you belong to, switch between them, or show the current one
argument-hint: list | switch <name|code|tenant_id> | current
allowed-tools: Bash(node:*), mcp__plugin_enforcer_enforcer__enforcer_whoami
---
Run the command and print the result verbatim. After a `switch`, also call `enforcer_whoami` and show the workspace it reports, so the person sees the MCP server now acts there.

`switch` only moves between workspaces you already belong to. If it says you are not a member, use `/enforcer:login <WORKSPACE-CODE>` or accept an invite instead.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/enforcer-workspace.mjs" $ARGUMENTS`
