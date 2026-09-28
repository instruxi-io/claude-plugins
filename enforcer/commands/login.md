---
description: Sign this machine in to Enforcer, once, for the Enforcer MCP server and every Instruxi plugin
argument-hint: [<WORKSPACE-CODE>] [--scope "<scopes>"] | api-key <key> | scopes | status | logout
allowed-tools: Bash(node:*)
---
Sign in to Enforcer and print the result verbatim. With no argument this opens a browser sign-in and waits for it to finish. With a workspace code (e.g. `ACME-1234-ABCD`, or `ENFORCER_TENANT_CODE` in settings) the sign-in page skips asking for it. By default the sign-in asks for every scope the server offers; `--scope "enforcer:read policy:self"` asks for only those (each must be offered, or it refuses before opening the browser), and `scopes` lists what is offered.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/login.mjs" $ARGUMENTS`
