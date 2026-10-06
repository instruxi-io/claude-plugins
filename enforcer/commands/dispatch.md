---
description: Dispatch a plan - start, check on, or stop the background workers for an Enforcer graph
argument-hint: "<graph-id> | status [<graph-id>] | stop <graph-id>"
allowed-tools: "Bash(node:*)"
---
Run the command and print its output verbatim. `<graph-id>` starts the dispatcher in the background with defaults (3 workers, sonnet, salvage and triage on); `status` says what is running and what needs you; `stop` drains and exits.

!`node "${CLAUDE_PLUGIN_ROOT}/bin/enforcer" dispatch $ARGUMENTS`
