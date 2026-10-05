---
description: Sign this machine in to Enforcer, once, for the Enforcer MCP server and every Instruxi plugin
argument-hint: [<WORKSPACE-CODE>] [--for work|plan|admin] [--scope "<scopes>"] | api-key <key> | scopes | status | logout
allowed-tools: Bash(node:*)
---
Invoke the `enforcer` skill's `login` procedure (skills/enforcer/login.md) with: $ARGUMENTS
!`node "${CLAUDE_PLUGIN_ROOT}/bin/login.mjs" $ARGUMENTS`
