# enforcer-graph plugin for Claude Code

A skill that teaches the claim / work / heartbeat / report loop, and seven hooks
that keep a session honest while it holds a node of a plan — including the two
that make the evidence in a report something the model did not author.

**No hook calls Jev, an LLM, or any model. No Jev key is needed.** Hooks are
plain HTTP to the enforcer-graph API with the same credential the MCP server
uses: the Enforcer sign-in, or a key.
Judgment (verification, dedupe, contradiction) happens server-side, on the
tenant's opt-in, and reaches this plugin only as fields in the tool results.

## Install

From the Instruxi marketplace, with the `enforcer` plugin that carries the MCP
server and the sign-in:

```bash
claude plugin marketplace add instruxi-io/claude-plugins
claude plugin install enforcer@instruxi
claude plugin install enforcer-graph@instruxi
```

Then sign in once, in Claude Code: `/enforcer:login`. That one OAuth sign-in
is what the MCP server and these hooks both use (`~/.enforcer/credentials.json`,
refreshed by whichever reads it when the token is close to expiry). It grants the
work loop (claim, heartbeat, report, remember) and plan authoring (import,
templates, nodes, edges); deletes and sharing stay with a person.

From a checkout of this repo instead: `claude --plugin-dir ./enforcer-graph`.

**CI and containers** can skip the sign-in and use a scoped key: set
`GRAPH_API_KEY` (or `ENFORCER_API_KEY`), and add the server with it:

```bash
claude mcp add --transport http enforcer-graph https://api.instruxi.dev/mcp \
  --header "X-API-Key: $GRAPH_API_KEY"
```

Portable skill install (any harness that reads SKILL.md):

```bash
npx skills add instruxi-io/claude-plugins --skill graph
```

## Configure

`.claude/graph.json` in the project (found by walking up from the cwd):

```json
{ "graph_id": "<uuid>" }
```

`base_url` defaults to the origin you signed in to; `api_key_env` names a key
variable if you use one. Environment overrides: `GRAPH_ID`, `GRAPH_BASE_URL`,
`GRAPH_API_KEY`. A key wins over the sign-in when both are present. With no
graph id, or no credential at all, every hook exits silently.

**Allow-list the five tools** or the loop is not autonomous: every graph write
tool carries `requiresUserInteraction`, so Claude Code asks before each
`graph_next_work` / `graph_report` / `graph_heartbeat` / `graph_remember`
unless they are allowed. The tool names depend on which server carries them
(`mcp__plugin_enforcer_enforcer__…` from the `enforcer` plugin, or
`mcp__enforcer-graph__…` for a key-based entry); the example lists both. Copy `settings.example.json` into
`.claude/settings.json` (project) or merge its `permissions.allow` list into
yours.

### A fact gets the recent record, not the whole run

`graph_remember` now goes through the same attach hook as `graph_report`, but
with a narrower window. Everything captured during a run supports the run's
report; only what just happened plausibly supports "the default lease is 300
seconds", so a fact carries the **most recent 3** records.

That heuristic is allowed to be rough because over-attaching is safe by
construction: the judge asks whether the record SHOWS the claim, so an
irrelevant record yields `asserted`, never a false `grounded`. Measured — a
false claim against a record that disproves it scored **0.01**. Attaching the
wrong thing costs a missed grounding, never a wrong one.

The server then classifies the fact: `grounded` (a record shows it),
`asserted` (checkable but nothing does — a lead, not a measurement),
`decision` (a choice or intention, never penalised for lacking evidence it
could not have). A contradiction where one side has a record says which to
believe.

### A claimed pull request is resolved, not trusted

A `pr` on `graph_report` was the one externally checkable claim that nothing
checked: a URL for a pull request that does not exist was stored and shown as a
result (measured against production with `.../pull/999999`). `gh` already holds
credentials the graph service does not and must not, so the attach hook resolves
the claim locally and records what `gh` says as evidence — a real title and
state, or the fact that it is not there.

It does not refuse: an unresolvable PR is itself a finding, and the judge should
see it. Measured live: a NOT FOUND record rejects the criterion at 0.02; a real
merged PR verifies at 0.95 **when the captured `gh pr create` command is in the
record too** — the resolved state alone shows a PR exists, not that it is for
this change. The two compose, because `gh pr create` is a Bash call the capture
hook already records.

Bounded and fails open: no `gh`, no network, a private repo or a timeout all
leave the report exactly as the model wrote it.

## Hooks

| Event | Script | What it does |
|---|---|---|
| SessionStart (startup, resume, compact) | `session_start.py` | Prints plan status: counts, frontier, running, failed, and whether THIS session still holds a run. Two HTTP GETs. |
| PostToolUse on `graph_next_work` / `graph_report` / `graph_heartbeat` | `track_run.py` | Records the run this session holds in `${CLAUDE_PLUGIN_DATA}/runs/<session_id>.json` from the tool result; clears it on report or when a heartbeat says `reclaimed` / `finished`. No HTTP. |
| PostToolUse on every tool | `capture_evidence.py` | While a run is held, appends what the tool actually did to `${CLAUDE_PLUGIN_DATA}/evidence/<session_id>.jsonl`: `Bash` as `{kind:"command", cmd, exit, output}` (output clipped to 4000 chars), `Edit`/`Write`/`MultiEdit` as `{kind:"file", path, excerpt}`. `Read`/`Grep`/`Glob` are not captured. No HTTP. |
| PreToolUse on `graph_report` | `attach_evidence.py` | Reads the capture, caps it at the 20 items the server accepts (failing commands first, then the most recent commands, then file changes) and merges it into the tool's arguments as `evidence` via `hookSpecificOutput.updatedInput`. Anything the model wrote in `evidence` is replaced. No HTTP. |
| PostToolUse on every tool | `heartbeat.py` | Every 10th tool call, if a run is held, one HTTP heartbeat (1.5s timeout, 3s hook timeout). Silent on `ok`. On `cancel_requested`, `reclaimed` or `finished` it says so in one line to you and to the model, and forgets a run that is no longer ours. |
| PreCompact (manual, auto) | `remember_on_compact.py` | If a run is held, writes one progress observation (the last assistant message) on the node, so the state of the work survives in the graph, not only in the summary. |
| Stop | `open_run_guard.py` | If a run is held and the final message does not say it was reported or deliberately left open, sends the session back once with the reason. `stop_hook_active` prevents a second block. |

## Evidence the model did not author

Verification used to judge prose, and prose can be invented: a fabricated
report with invented file paths, line numbers and test names has scored full
marks. Evidence the model writes about itself does not fix that — a fabricator
fabricates that too. So `capture_evidence.py` records tool results as they come
back, and `attach_evidence.py` attaches them at report time. The model is not
in that path.

`updatedInput` **does** apply to MCP tool calls. The published hooks reference
says only "`updatedInput` - Modified tool input (PreToolUse only)" and never
mentions MCP either way, so this was read out of the shipped binary
(Claude Code 2.1.278): the PreToolUse result path validates the rewrite with
`n.inputSchema.safeParse(...)` and explicitly drops `unrecognized_keys` issues,
so an argument the tool's schema does not declare does not deny the call;
`if (Ee.updatedInput && Ee.permissionBehavior === undefined)` carries the
rewrite with no permission decision attached; and the enclosing telemetry is
MCP-aware (`isMcp`, `mcpServerType`, `mcpInfo`). `updatedInput` **replaces**
the argument object rather than merging into it, which is why the hook echoes
every argument back.

One surface does not apply it: a hook run through the remote/sandboxed tool
path turns a rewrite into `permissionBehavior: "ask"` rather than applying it.
Set `GRAPH_EVIDENCE_MODE=context` there and the hook hands the capture to the
model as text to pass on verbatim instead — **a weaker guarantee**, because the
model is back in the path and could edit it.

What the guarantee is and is not:

- Captured evidence always replaces whatever the model wrote in `evidence`.
- If nothing was captured — a run with no command and no edit, or a data
  directory the hook could not write — the hook stays silent and the call goes
  through untouched. It fails open, which means a session that runs no tools
  can still hand the server a self-written report; the server's answer to that
  is to score it `unsupported`.
- The capture is a local file. It is honest about a model that invents, not
  hardened against a user who edits `${CLAUDE_PLUGIN_DATA}` by hand.

Every hook fails open: no config, no key, API down, or malformed input means
exit 0 and no output. The graph is a coordination service; it must never be
the reason a session stalls.

## Files

```
enforcer-graph/
  .claude-plugin/plugin.json
  skills/graph/SKILL.md
  hooks/hooks.json  hooks/lib.py
  hooks/{session_start,track_run,heartbeat,remember_on_compact,open_run_guard}.py
  hooks/{capture_evidence,attach_evidence}.py
  settings.example.json
  test/run.sh  test/stub_graph.py     # every hook against a local stub of the API
```

```bash
bash enforcer-graph/test/run.sh
```

A five-minute demo (two sessions, one killed, the lease reclaimed) lives with the
service, in enforcer-graph's `docs/PLUGIN_DEMO.md` (Instruxi staff).
