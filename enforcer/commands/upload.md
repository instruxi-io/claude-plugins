---
description: Upload a local file to your Enforcer workspace's storage (the bytes go straight to storage, not through the model)
argument-hint: <path> [--name <file_name>] [--dir <directory>] [--overwrite]
allowed-tools: "Bash(node:*), Bash(ENFORCER_ARGS=*)"
---
Upload the file and print the result verbatim. It uses the /enforcer:login sign-in.

!`ENFORCER_ARGS='upload $ARGUMENTS' node "${CLAUDE_PLUGIN_ROOT}/bin/files.mjs"`
