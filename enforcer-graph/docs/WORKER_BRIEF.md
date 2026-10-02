# WORKER_BRIEF: claude-plugins / enforcer-graph

Read this and the repo CLAUDE.md first, then only the files your node names.
Scope here: the `enforcer-graph/` plugin (skill, hooks, agent, bin, tests).

## 1. Layout (where things live)

- `.claude-plugin/plugin.json`: name, `version` (currently 0.17.0). Only version source.
- `skills/graph/SKILL.md` (22 KB): the loop; "Writing a plan" (~line 263) is the node/brief format.
- `agents/graph-worker.md` (7 KB): one-node worker, maxTurns 80, reads CLAUDE.md + this brief.
- `hooks/hooks.json`: wiring. Scripts in `hooks/*.py`, shared code in `hooks/lib.py` (28 KB).
- `bin/land-pr.sh`: lands one PR, no model. `bin/graph-dispatch` (31 KB, python): keeps N headless workers busy.
- `test/run.sh`: every hook against `test/stub_graph.py` (local fake API). Also `check_skill.py`, `test_dispatch.py`, `test_attach_evidence.py`, `test_usage.py`.
- `settings.example.json`: allowlist forms. `README.md`: user docs.
- The sibling `enforcer/` plugin depends on this one (`"dependencies": ["enforcer-graph"]` in its plugin.json, #25), so the graph tools never load without these hooks. The dependency is unversioned.

### Hooks and matchers (hooks/hooks.json)

| Event | Matcher | Script |
|---|---|---|
| SessionStart | `startup\|resume\|compact` | session_start.py (prints frontier/running/failed; silent without `.claude/graph.json` or on 401) |
| PreToolUse | `mcp__(plugin_enforcer_enforcer\|enforcer\|enforcer-graph)__graph_(next_work\|report\|remember\|heartbeat)` | attach_evidence.py (replaces report evidence with captured records) |
| PostToolUse | same prefixes, `graph_(next_work\|report\|heartbeat)` | track_run.py (writes the run file) |
| PostToolUse | `.*` | capture_evidence.py (records your tool results), heartbeat.py (lease keepalive) |
| PreCompact | `manual\|auto` | remember_on_compact.py |
| Stop | none | open_run_guard.py (refuses to stop with a run open) |

## 2. Verify loop

```bash
bash enforcer-graph/test/run.sh > /tmp/r.log 2>&1; echo EXIT=$?; tail -5 /tmp/r.log
```
Last line must be `N passed, 0 failed` (109 on 0.17.0). No network, key, or Jev needed. Run only the python piece you touched, e.g. `python3 enforcer-graph/test/check_skill.py plan`.

Land: open the PR (body ends with the Claude Code line), then from your worktree
`~/apps/claude-plugins/enforcer-graph/bin/land-pr.sh <pr> --timeout 3000`.
Exit 0 merged (prints JSON + merge-base line); 2 CI red; 3 conflict (rebase, read both sides); 4 timeout; 5 usage/gh error.

### Version bump
Bump `.claude-plugin/plugin.json` version for any change to hooks, skill, agent or bin (behaviour installed users get). Docs-only and test-only changes need no bump. Do not edit `enforcer/`'s version for this.

## 3. Traps

- **Tool-name prefixes.** The graph tools load as `mcp__plugin_enforcer_enforcer__graph_*` (server declared by the `enforcer` plugin). Standalone servers give `mcp__enforcer__` or `mcp__enforcer-graph__`. Matchers and allowlists must name the form your session shows; unmatched, every call prompts a human.
- **Hooks fire only on `graph_*` tools.** Evidence capture, heartbeat and run tracking see `graph_next_work/report/heartbeat`. Anything routed through `enforcer_api_write` is invisible to them and waits for a human to confirm; never heartbeat or report that way.
- **Plugin must be enabled.** `claude plugin enable enforcer-graph@instruxi`. A disabled plugin = no hooks, and `graph_*` answers carry a `hooks_inactive` warning (no `X-Graph-Client`).
- **Headless (`claude -p`).** Hosted MCP write tools are marked `requiresUserInteraction` and are refused whatever `--allowedTools` says: `MCPTool requires permission.` graph-dispatch then says BLOCKED and exits 2. For headless pushes under the jev-hooks plugin set `JEV_HOOKS_HEADLESS` (that variable lives in jev-hooks, not this repo; it appears nowhere in these files).
- **Evidence is replaced by the hook.** Whatever you write in `graph_report` `evidence` is overwritten by captured tool results; run the evidence commands as the LAST commands before reporting.
- **Hooks fail open.** Python hooks swallow errors and print nothing; a test that expects output must assert it, silence is not a pass.
- `hooks/hooks.json` is JSON: a trailing comma disables every hook with no error. `README.md` "Files" has duplicated lines; do not copy that pattern.

## 4. Where to look for X

- A matcher or event: `hooks/hooks.json`. Run-file shape: `track_run.py`, `lib.py`.
- Evidence rules ("claimed PR is resolved, not trusted"): README sections of those names, then `attach_evidence.py`.
- Dispatcher selection/model/tier rules: docstring of `bin/graph-dispatch` (first 40 lines).
- Plan-writing rules a test asserts: SKILL.md "Writing a plan" and `test/check_skill.py`.
- Adding a hook test: append `check "name" 'cond'` lines in `test/run.sh` before the final `echo "$pass passed"`.

## 5. Never read whole

- `hooks/lib.py` (28 KB): grep the function, read a range.
- `bin/graph-dispatch` (31 KB): docstring plus the function you change.
- `test/run.sh` (37 KB): grep the check name; edit near the end.
- `skills/graph/SKILL.md` (22 KB) and `README.md` (20 KB): `grep -n '^#'`, then a range.
- `test/test_dispatch.py` (11 KB), `test/test_attach_evidence.py` (12 KB): only the case you change.
