---
description: Sign this machine in to Enforcer, once, for the Enforcer MCP server and every Instruxi plugin
argument-hint: [<WORKSPACE-CODE>] [--for work|plan|admin] [--scope "<scopes>"] | api-key <file>|- | scopes | status | logout
allowed-tools: Bash(node:*), Bash(ENFORCER_ARGS=*)
---
Invoke the `enforcer` skill's `login` procedure (skills/enforcer/login.md) with the arguments the command line below carries. `api-key` takes a file path or `-` (stdin), never the key itself: an argument lands in the transcript.
!`ENFORCER_ARGS='$ARGUMENTS' node "${CLAUDE_PLUGIN_ROOT}/bin/login.mjs"`
