# graph-dispatch flag reference

Moved from README.md. For the one-command front door see "Dispatch a plan" there.

## bin/graph-dispatch: keep N workers busy, with no model in the loop

```bash
GRAPH_AUTH_HELPER='node ~/.claude/plugins/cache/instruxi/enforcer/0.4.0/bin/enforcer-headers.mjs' \
  enforcer/bin/graph-dispatch --graph <id> [--workers 3] [--repo-root ~/apps] [--dry-run]
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
  repo), then `claude -p` with `--agent enforcer:graph-worker`, `--model`,
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
- **Drain**: `touch <state>/STOP` (default state `~/.config/enforcer/dispatch/<graph>`):
  no new launches, running workers finish, exit 0. `--max-attempts` (2) bounds
  launches per node per session.
- **Waits on verdicts.** A node in `verifying` (tenant gate: judges voting, or
  an escalation waiting for a person) holds its dependents back. While one
  exists and unfinished work remains, the dispatcher keeps polling at
  `--interval` instead of exiting "nothing runnable", and logs
  `waiting on verdict for <keys>` once per 10 minutes. It exits only when
  nothing is runnable, running or verifying. `--exit-when-idle` restores the
  old exit.
- **Auth**: `GRAPH_AUTH_HELPER` (any command printing JSON headers; default the
  newest cached `enforcer-headers.mjs`) or `GRAPH_API_KEY`; base
  `GRAPH_BASE_URL`. Process exit code, by value:
  - 0 everything done, or drained by the stop file;
  - 1 auth failure, API error at startup, or 404 (wrong workspace or graph id);
  - 2 blocked (below);
  - 3 another dispatcher holds the graph lease (or it was lost);
  - 4 harness usage limit with `--on-limit exit`;
  - 5 usage error (bad arguments);
  - 6 finished, but failed or denied nodes remain.
  A stale stop file is removed at startup; `pids.json` is written atomically and removed on exit.

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

Salvage runs only for a node whose claim card carries the `deliver-via-github-pr` skill. The card's `skills` entries are the api's attached-skill rows, `{"position", "config", "skill": {"slug", ...}}` — the slug is nested under `skill` (0.27.1; before it the dispatcher read only a flat `slug`/`key`/`name`, saw no skill on any node, and skipped every salvage).

Salvage opens the PR against the node's resolved base (see below, as the worktree step does), counting commits ahead of `origin/<base>` and passing the base to the PR create step.

### The start-from ref per repo (`bases`, `repo-bases.json`)

A repo may not work off origin's default branch (`enforcer-v3-portal` works off `staging`). The dispatcher resolves a node's base in this order and never guesses past it:

1. the node's `data.base`;
2. the graph's `node_defaults.bases`, e.g. `{"bases": {"enforcer-v3-portal": "staging"}}` (keyed by `data.repo`);
3. the registry `~/.config/enforcer/dispatch/repo-bases.json` (or `$ENFORCER_CONFIG_HOME/dispatch/repo-bases.json`, or `--repo-bases FILE`), e.g. `{"enforcer-v3-portal": "staging"}`;
4. origin's default branch (`origin/HEAD`).

The worktree, the commits-ahead count and the PR base all use the resolved base, and the launch line logs `base=<ref>`. A declared base (steps 1 to 3) that does not exist on origin is refused with `refuse <key>: base origin/<b> (from <source>) does not exist on origin`; the node is not launched.

### Pruning worktrees safely (`graph-dispatch prune`)

`graph-dispatch prune [--repo-root DIR] [--yes]` looks at every `<repo>-<key>` worktree (branch `graph/<key>`) under the repo root. It removes one only when (a) its tree is clean and (b) its branch head is an ancestor of origin's default branch (or the repo's registered base), or its PR is MERGED (`gh`). Everything else is kept and listed under `Review N branches` with the reason: `uncommitted changes`, `unmerged commits` or `open PR`. Without `--yes` it is a dry run and prints `would remove ...`.

### Per-repo worktree setup (`.worktreeinclude`, `.worktreeshare`)

A fresh worktree has no `.env` and no `node_modules`. When the dispatcher creates or reuses a worktree it reads two optional files at the root of the main checkout (`<repo-root>/<data.repo>/`), applies them and logs `worktree-setup <key>: copied N, linked M` (with a `; skip <path> (reason)` note for each entry it passed over). Both files list one path per line; blank lines and `#` comments are ignored.

- `.worktreeinclude`: files to COPY from the main checkout, e.g. `.env`, `.vscode/settings.json`. Only existing, gitignored files inside the repo are copied. A path git tracks is never copied (the worktree already has it), and a missing path is skipped.
- `.worktreeshare`: directories to SYMLINK from the main checkout, e.g. `node_modules`, `.cache`, or a sibling such as `../protos`. A sibling (`../x`) is linked only when the worktree sits beside the checkout.

An entry already present in the worktree is left alone, so a re-claimed node is not touched twice. `--dry-run` logs the counts without copying or linking.
