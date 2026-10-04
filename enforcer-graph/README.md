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

One install. The `enforcer` plugin (the MCP server and the sign-in) depends on
this one, so installing it installs and enables these hooks too:

```bash
claude plugin marketplace add instruxi-io/claude-plugins
claude plugin install enforcer@instruxi    # ✔ ... (+ 1 dependency: enforcer-graph)
```

Then, in Claude Code: `/enforcer:login`, then `/enforcer:setup` (shows the
allow rules for the worker loop and the plugin commands, applies only on your
yes).

**Existing installs** keep working: an `enforcer-graph` you installed yourself
satisfies the dependency as it is. Update with
`claude plugin update enforcer@instruxi` and then `claude plugin install
enforcer@instruxi` once more (or `/reload-plugins`), which installs the
dependency when it is new: `plugin update` alone does not, and `enforcer` then
fails to load with `Dependency "enforcer-graph@instruxi" is not installed — run
claude plugin install enforcer-graph@instruxi` (bash test/upgrade-install.sh
shows each step); session start says so once when an installed copy is older
than the marketplace's, and says `claude plugin install enforcer@instruxi`
when enforcer-graph is installed without it. If enforcer-graph is DISABLED,
`enforcer` now fails to load (`Dependency "enforcer-graph@instruxi" is
disabled`) instead of serving the graph tools with no hooks behind them; fix
with `claude plugin enable enforcer-graph@instruxi`. A Claude Code too old for
plugin dependencies installs the two separately, as before.

### The client attestation

Every `graph_next_work`, `graph_heartbeat` and `graph_report` the model makes
is rewritten by the PreToolUse hook to carry
`client: "enforcer-graph-plugin/<version>; hooks=on"` (the version is read from
this plugin's manifest), and the hooks' own HTTP heartbeat sends the same string
as `X-Graph-Client`. The MCP server forwards the argument as that header and
the graph records it on the run; a run without it gets the `hooks_inactive`
warning. A `client` the model wrote is replaced, never trusted. In
`GRAPH_EVIDENCE_MODE=context` (a surface that does not apply rewrites) nothing
is stamped.

### The allowlist is checked against the server

`settings.example.json`, the graph-worker agent's `tools:`, `/enforcer:setup`'s
`allowed-tools` and the hook matchers are checked in CI against the MCP
server's published tool manifest (`node test/check-allowlist.mjs` at the repo
root), so a renamed tool fails the build instead of silently turning every
allow rule into a prompt. That one OAuth sign-in
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

**Full command output beyond the clip** (optional). Evidence clips each
command's output to 4000 characters, keeping both ends. Set `files_base_url`
(env `GRAPH_FILES_BASE_URL`) to your enforcer-files base, including its
`/api/v1/files` prefix, for example `https://api.instruxi.dev/api/v1/files`.
The attach hook then uploads any longer output to **your** enforcer-files
storage under **your** credential, using the provider that
`GET /storage/provider` reports, and the evidence item carries `file` (the
file id) and `file_bytes`. The graph judges the clip as before and tells the
judge that the whole output is stored. It never downloads the file while it
judges. The uploads are ordinary files in your storage, named
`graph-evidence/<timestamp>-<id>.log`, and follow that service's retention
and visibility. If the setting is unset, no upload is attempted. If an upload
fails or runs past the hook's 10-second budget, the item stays as it was
(clipped, no file) and the report still goes through. The whole output is
kept in the capture file only when it is longer than the clip.

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

## The graph-worker agent

`agents/graph-worker.md` is the worker protocol as a plugin subagent
(`enforcer-graph:graph-worker`). Hand it a graph id, a node id or key, and
optionally a brief in its prompt; it claims that node with `graph_next_work`
(`node` parameter, MCP 0.9.5+), heartbeats, does the work, lands its own PR with
`bin/land-pr.sh` and reports with captured evidence. It never claims, heartbeats
or reports through `enforcer_api_write`, which bypasses every hook and asks a
human to confirm each call. On a server without the `node` parameter it falls
back to a plain `graph_next_work` and works whatever node it gets.

Frontmatter: `model: sonnet` (a coordinator overrides it per node tier through
the Agent tool's `model`), a `tools` allowlist naming the graph tools under all
three server prefixes, and `maxTurns: 150`. Claude Code supports `maxTurns` for
plugin agents (the output is marked partial when the cap is hit). Plugin agents
ignore `hooks`, `mcpServers` and `permissionMode`, so none are set: the hooks
come from the plugin's `hooks/hooks.json`.

## bin/graph-dispatch: keep N workers busy, with no model in the loop

```bash
GRAPH_AUTH_HELPER='node ~/.claude/plugins/cache/instruxi/enforcer/0.4.0/bin/enforcer-headers.mjs' \
  enforcer-graph/bin/graph-dispatch --graph <id> [--workers 3] [--repo-root ~/apps] [--dry-run]
```

A python loop (stdlib only) that reads the frontier every `--interval` seconds
and, for each ready node, up to `--workers` at once:

- **One dispatcher per graph.** The running dispatcher holds a lease,
  `data.dispatcher {owner, host, pid, until}` on the graph's `dispatcher-lease`
  node, renewed each pass. A second `graph-dispatch` on the same graph exits (3)
  with a message unless `--takeover`. Graph and GitHub calls retry transient
  network errors (DNS blips, resets, 429/502/503/504) with backoff, 4 tries, and
  a pass that still fails is skipped, never fatal. A failed node is triaged only
  once its last run ended `--triage-grace` minutes ago (default 10) and it is
  still failed when the triage launches. Worker pids are recorded in
  `<state-dir>/pids.json`.
- **Agent nodes** (`--types`, default `task,bug,chore,merge,scout,milestone,ops`; `release`
  and `gate` stay with a person): a git worktree of `data.repo` at
  `<repo-root>/<repo>-<key>` on `graph/<key>` (off `data.base` or origin's
  default branch; reused on a re-claim; a scratch dir when the node has no
  repo), then `claude -p` with `--agent enforcer-graph:graph-worker`, `--model`,
  `--plugin-dir` for this plugin AND the cached `enforcer` plugin (so the hooks
  and the MCP server load whatever `enabledPlugins` says; an inline plugin
  replaces an installed copy of the same name), `--allowedTools` naming the five
  graph tools under all three prefixes, `--permission-prompts none` (anything
  that would prompt is denied, so a worker never hangs), `--output-format
  stream-json --verbose` to `<state>/logs/<key>.<attempt>.jsonl`, and
  `GRAPH_ID` in its environment. The worker claims, heartbeats and reports
  itself, so its own hooks capture its evidence.
- **Model**: `data.model` (or the claim card's `model`) wins; a tier set by a
  person (`tier_source: user`) beats `--model`; otherwise `--model` caps it;
  otherwise `mechanical`/`standard` -> sonnet, `deep` -> opus, default sonnet.
- **Turn cap**: `data.max_turns`, when set, is passed as `claude --max-turns`
  (accepted and enforced by Claude Code 2.1.288 though not in `--help`; the run
  ends `error_max_turns`). The dispatcher also counts assistant turns in the
  stream and stops a worker past `--max-turns` (150) or `data.max_turns`,
  whichever is larger; `--max-budget-usd` is passed through. A worker that
  claimed and exited without reporting has its run failed with the log path,
  so the node is claimable at once rather than after its lease.
- **Warm workers**: every launch names its session (`--session-id`). A worker
  that reports its node cleanly leaves its session warm for its
  `(data.repo, model)`; the next node there resumes it (`--resume <id>`, which
  finds the session from any cwd, so the new worktree is fine) with a "NEW
  NODE" prompt, and such nodes are scheduled first. The launch line says
  `mode=cold` or `mode=resume`; the done line carries `cache_read`,
  `cache_creation` and `output` tokens from the result event. A resume that
  does not start (no init event, e.g. `No conversation found with session ID`)
  is logged and the node is started cold at once, spending no attempt. A
  session is retired after `--warm-max-nodes` (5) nodes or `--warm-max-age`
  (120) minutes from its first launch; `--no-warm` starts everything cold.
  Each plugin directory is passed once (`--plugin-dir`, deduplicated by path).
- **Merge nodes** naming a PR (`data.pr`: a number, URL or `owner/repo#N`; or
  `data.branch`) get no agent and no slot: the dispatcher claims the run, runs
  `bin/land-pr.sh`, heartbeats while it waits, and completes the run with
  land-pr's verbatim output as `{kind: command, cmd, exit, output}` evidence:
  exit 0 succeeded, 2/3/4/5 failed with that output. One land per repo at a time.
- **Contested resources**: never two workers, ours or a live run elsewhere, on
  one `data.resources` value. A lapsed lease frees its resources and its node
  is re-dispatched (the server lists it as `looking_for_work`).
- **Drain**: `touch <state>/STOP` (default state `~/.cache/graph-dispatch/<graph>`):
  no new launches, running workers finish, exit 0. `--max-attempts` (2) bounds
  launches per node per session.
- **Auth**: `GRAPH_AUTH_HELPER` (any command printing JSON headers; default the
  newest cached `enforcer-headers.mjs`) or `GRAPH_API_KEY`; base
  `GRAPH_BASE_URL`. Exit 0 done or drained, 1 auth/API, 2 blocked (below), 5 usage.

### Headless workers: the graph tools are refused in `claude -p` (2026-10-02)

The hosted MCP server marks every write tool, the work loop included,
`_meta["anthropic/requiresUserInteraction"]` (enforcer-v3-mcp `src/tools.ts`,
`toolDefs`). Claude Code 2.1.287 refuses such a tool in `claude -p` **whatever
the allowlist says**: `--allowedTools`, `permissions.allow` in `--settings`,
`--permission-mode dontAsk` and `bypassPermissions` all end in
`MCPTool requires permission.`, and a `--permission-prompt-tool` is refused
with `MCP tool requires user interaction; not supported via
--permission-prompt-tool`. An MCP write tool WITHOUT that flag runs headless
when it is in `--allowedTools`, and is denied when it is not. So headless
workers need the server to drop the flag for `graph_next_work`,
`graph_heartbeat`, `graph_report` and `graph_remember` (the allowlist then
gates them as it does any MCP tool). Until it does, the dispatcher sees the
first denied graph tool, says `BLOCKED`, launches nothing more and exits 2
once the running workers finish. Merge nodes are unaffected (no MCP).

The MCP server can also come up `needs-auth` in a fresh `claude -p` (seen
intermittently on 2026-10-02). Such a worker never reaches the graph; it does
not spend an attempt, and three in a row stop the dispatcher.

## What a denial means to the dispatcher

The dispatcher reads the governor's decision records (from the governor log and the worker's stream-json denials) and branches on the machine `code`, not on log text:

| code | dispatcher action |
|---|---|
| `push_needs_approval_surface` | salvage: push, open the PR and land it, as the worker could not |
| `destructive_*` | never salvaged; the node goes to triage |
| `graph_run_not_open` | remediation launch, with the code in the prompt |
| any other deny/ask code | logged; neither salvaged nor relaunched |

When several codes are present the order is destructive, then `graph_run_not_open`, then the push. Only when a worker left no record (an older plugin or governor) does the dispatcher fall back to the old text match on the denial message.

## The plugin must be ENABLED, and the allowlist must name the tools as they load

Both failed together on the agents-platform build, so no hook ran at all:

- `"enforcer-graph@instruxi": false` was set in `~/.claude/settings.json` for the
  whole build. A disabled plugin contributes no hooks: no lease keepalive, no
  evidence capture, no usage stamp, no Stop guard. Check with
  `claude plugin list`; fix with `claude plugin enable enforcer-graph@instruxi`.
- The permission allowlist named `mcp__enforcer-graph__graph_*`, but the tools
  load as `mcp__plugin_enforcer_enforcer__graph_*` (the server is declared by the
  `enforcer` plugin; a session's tool list shows
  `mcp__plugin_enforcer_enforcer__graph_heartbeat`, `...__graph_report`,
  `...__graph_next_work`). Unmatched, every call prompts the human, and workers
  routed around the prompts through `enforcer_api_write`.

`settings.example.json` now lists all three forms: `mcp__plugin_enforcer_enforcer__`
(the plugin's server), `mcp__enforcer__` and `mcp__enforcer-graph__` (a
standalone server added with `claude mcp add`). Keep the one your session shows.

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

Working on this plugin (agents and humans): start from [docs/WORKER_BRIEF.md](docs/WORKER_BRIEF.md).

```
enforcer-graph/
  .claude-plugin/plugin.json
  skills/graph/SKILL.md
  agents/graph-worker.md
  hooks/hooks.json  hooks/lib.py
  hooks/{session_start,track_run,heartbeat,remember_on_compact,open_run_guard}.py
  hooks/{capture_evidence,attach_evidence}.py
  bin/land-pr.sh  bin/graph-dispatch   # land one PR; keep N headless workers busy
  bin/land-pr.sh  bin/graph-dispatch   # land one PR; keep N headless workers busy
  settings.example.json
  test/run.sh  test/stub_graph.py     # every hook against a local stub of the API
  test/test_dispatch.py               # graph-dispatch against a fake API and a fake claude
  test/test_dispatch.py               # graph-dispatch against a fake API and a fake claude
```

```bash
bash enforcer-graph/test/run.sh
```

A five-minute demo (two sessions, one killed, the lease reclaimed) lives with the
service, in enforcer-graph's `docs/PLUGIN_DEMO.md` (Instruxi staff).
