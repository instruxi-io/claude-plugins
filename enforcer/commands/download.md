---
description: Download a file from your Enforcer workspace to this machine, by file_id or by the path it was uploaded as
argument-hint: <file_id|path> [--out <path>]
allowed-tools: Bash(node:*)
---
Download the file and print the result verbatim. It uses the /enforcer:login sign-in.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/files.mjs" download $ARGUMENTS`
