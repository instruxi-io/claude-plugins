---
description: Download a file from your Enforcer workspace to this machine, by file_id or by the path it was uploaded as
argument-hint: <file_id|path> [--out <path>]
allowed-tools: Bash(node:*), Bash(ENFORCER_ARGS=*)
---
Download the file and print the result verbatim. It uses the /enforcer:login sign-in.

!`ENFORCER_ARGS='download $ARGUMENTS' node "${CLAUDE_PLUGIN_ROOT}/bin/files.mjs"`
