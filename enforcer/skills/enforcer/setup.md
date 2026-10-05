# setup

Set this project up for Enforcer - show the plan (graph allow rules, plugin commands, first policy rules) and apply it only after you say yes.

Arguments: `[rules] [--activate]`

Tools used: Read, Grep, Glob, mcp__plugin_enforcer_enforcer__enforcer_whoami, mcp__plugin_enforcer_enforcer__enforcer_setup_plan
Set this project up for Enforcer in two steps: **show the plan, then apply only what the person confirms.** Nothing is written before they answer.

Arguments: `$ARGUMENTS` (`rules` = only the policy rules part; `--activate` = they already asked for the new policy version to be switched on).

## 1. Make the plan (writes nothing)

1. Call `enforcer_whoami`. If it fails because nobody is signed in, stop and tell them to run `/enforcer:login` first.
2. Read this repository's route definitions (handlers, routers, OpenAPI files) and list what the code can do, one entry per route, as `{action, resource_type, where}` - a `POST /refunds` handler in `api/refunds.go:42` is `{action: "issue", resource_type: "payment", where: "api/refunds.go:42"}`. If the repository has no routes, use the single entry `{action: "read", resource_type: "graph", where: "(no routes found)"}` so the plan still returns the Claude Code setup, and say that no policy rules are proposed.
3. Call `enforcer_setup_plan` with those actions.

## 2. Show the plan

Show the person, in this order and without abbreviating:

- **Claude Code permissions** - every rule in `claude_code_graph_setup.permissions_allow`, as the exact JSON lines that would be added to `permissions.allow` in this project's `.claude/settings.json`, and which of them are already there (read the file if it exists). Say these let the graph worker loop (`graph_next_work`, `graph_heartbeat`, `graph_report`, ...) run without a prompt per call, and that resets, tiers, judging and sharing still ask.
- **Plugin commands** - `claude_code_graph_setup.plugin_commands`, as commands for THEM to run in their own shell. One install is enough now: `claude plugin install enforcer@instruxi` brings the graph worker hooks and the governor with it; no separate install is needed. Do not run these yourself: they change their Claude Code setup.
- **Policy rules** (unless there were no routes) - each `propose[].reads_as` sentence with its `where`, and the `reach` line (whose rules these become).

Then ask one question: **"Apply this? (yes / only the permissions / only the rules / no)"** and STOP. End your turn there and wait for their answer. Do not treat silence, a question back, or your own judgment as a yes.

## 3. Apply what they confirmed, and only that

- **yes / only the permissions**: add the missing `permissions_allow` rules to `.claude/settings.json` in this project (create the file if needed; keep every existing key and rule; never edit `~/.claude/settings.json` or any other settings file unless they named it). Show the resulting `permissions.allow` list.
- **yes / only the rules**: call `enforcer_setup_apply` with the `propose` entries they approved (drop any they struck out). It is a confirmed write, so Claude Code asks them once more - that is expected. Pass `activate: true` only if they said to switch it on now (or passed `--activate`).
- **no**, or anything else: apply nothing and say that nothing was changed.

Report what was applied and what was not, then: "Restart Claude Code (or run /reload-plugins) if you ran any plugin command."
