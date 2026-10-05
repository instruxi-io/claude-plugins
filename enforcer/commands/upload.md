---
description: Upload a local file to your Enforcer workspace's storage (the bytes go straight to storage, not through the model)
argument-hint: <path> [--name <file_name>] [--dir <directory>] [--overwrite]
allowed-tools: Bash(node:*)
---
Upload the file and print the result verbatim. It uses the /enforcer:login sign-in.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/files.mjs" upload $ARGUMENTS`
