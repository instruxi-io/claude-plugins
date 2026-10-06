# Changelog

## Unreleased

## 1.1.0

One runtime (the Python graph code is gone), generated API clients, a contract test against the server spec, and operations tooling.

- Supply chain: jev-hooks marketplace entry pinned by sha, workflow actions sha-pinned, Dependabot for actions and npm, `npm run sbom` (CycloneDX), ruleset check in the release checklist.

- enforcer-governor catalog entry is now an inert alias stub (aliases/enforcer-governor), so it no longer double-fires beside enforcer.

- - One shared Node API client (lib/api/client.mjs): timeouts, retry with jitter and Retry-After, X-Graph-Client/X-Request-Id on every call, typed ApiError; all Node callers routed through it.
- - Generated TypeScript types and openapi-fetch clients under lib/api from the pinned specs (npm run gen:api), with a staleness test and tsc in npm test.
- - The MCP tool manifest lives in the spec lock: check-allowlist reads it (with a per-profile view), the vendored fixture and the soft MCP_MANIFEST_TOKEN step are gone, and tool-result shape tests cover graph_next_work and graph_heartbeat.
- - Spec lock: pinned OpenAPI specs and the MCP manifest for every server the plugin calls, with a sync script and a test that fails on drift (#135).
- A checked-in manifest of every API call the plugin makes (test/contract/used.json, from scripts/extract-api-usage.mjs) and a contract test of it against the pinned specs on every run and against the deployed and main specs nightly (contract-nightly); the two audit drifts are recorded as known drift.
- CI runs on Ubuntu, macOS and Windows with a per-suite runner (skips with reasons, quarantine list, JUnit), p95 timing helper, and a nightly real-harness smoke job.
- - One config resolver (src/config.mjs, docs/CONFIG.md): base URL precedence flag > ENFORCER_BASE_URL > saved sign-in > default across hooks, login, doctor and the dispatcher; named errors for malformed env vars; docs/SELF_HOSTED.md recipe.
- - One run id joins the worker run, its PR, the judge's evidence and the governor receipts: X-Enforcer-Run on API calls, GRAPH_RUN_ID in worker env, graph_id on receipts, run_id on evidence items and hook log lines, and an Enforcer-Run footer on PR bodies.
- - Exit code 6's failed/denied list is recomputed from current graph status (failed or needs_review), not the session's denial memory; exit 0 when none remain.
- - `graph-dispatch prune` now removes a merged node's worktree even after the lander deleted its remote branch (PR found by head sha) and lists every directory with a classification instead of skipping silently.
- - The dispatcher logs JSONL (ts, level, event, key, run, fields) to dispatcher.jsonl beside the human dispatcher.log; worker streams are 0600, redacted on exit, and pruned on start past 14 days or 2 GB.
- Docs truth pass 2: graph README, WORKER_BRIEF, CANONICAL_RELEASE and README alias table match the current layout (lib/graph, src/graph, `enforcer event`, no plugin dependency); test/docs-truth.test.mjs guards removed paths and versions.
- - One error mapping (src/errors.mjs) from server machine codes to user and model messages: each code is announced once per session and logged locally, and the server's warnings[] (hooks_inactive, client_outdated) are surfaced once.
- Added `enforcer evidence run <graph>:<node>`: runs a node's acceptance lines (Go test flags, placeholders, cd prefix, one retry on collision, PR lines skipped) and prints evidence items; the dispatcher's landing completion, plan check and the graph skill use it.
- - test: the governor-denial dispatcher test no longer shadows the module it tests.
- - Governor: the headless-worker rules are one named profile (`lib/governor/profiles/headless-worker.mjs`: allow, deny, loop, spend, untrusted framing) that `core/worker.mjs` evaluates; the dispatcher sets `ENFORCER_PROFILE=headless-worker`; one adversarial test replays the 2026-10-06 incidents and the injection fixtures.
- - Governor: a headless worker may delete a tree inside its own worktree (`rm -rf dist`); deletes outside it, of the worktree itself or of .git keep the ask.
- - Governor: graph_heartbeat and graph_plan_status no longer count toward the loop detector; the dispatcher no longer treats a governor-issued denial of a graph tool as the harness refusing headless work (#148).
- ENFORCER_DEBUG=1 appends one JSON line per hook run to hooks.log.jsonl (rotated at 10 MB, two generations, 0600); the third failure of a hook in a session adds a one-line systemMessage naming the hook and the log (hook-debug-log).
- Design for a tenant-scoped hosted dispatcher (credential, sandbox, repo access, logs and metrics, container-safe lease, server API) in enforcer/docs/HOSTED_DISPATCHER.md; proposal only, for gate review.
- - Node text is untrusted: the worker prompt fences it as data, the headless governor profile denies edits to .github/, release/deploy scripts and secret files (release nodes excepted), headless tree deletes inside the worker's own worktree are allowed, and workers default to --max-budget-usd 5.
- - land-pr waits for every workflow run on the head sha to complete, not only the check runs already registered; #148 had merged with its test job still queued.
- - governor: loop-exempt.test.mjs runs under the isolating preload (fixes main CI after #148).
- Test temp dirs are realpath'd so the files, graph, dispatch/runtime and python capture suites pass on macOS, and their darwin quarantine entries are gone (macos-suite-portability).
- Added: enforcer plan check streams each result as it is known (running count on stderr), survives read-only temp trees (Go module cache), and takes --only <key> and --timeout <s>; the exit code reflects MISMATCH only.
- `enforcer plan check` posts each node's acceptance lines to the server lint and prints its warnings beside the local results (plan-check-uses-server-lint).
- - Plugin manifest conformance: validate-plugin test (six manifests agree, hooks.json loads in a real session, login passes arguments via stdin), `claude plugin validate` in CI, and /enforcer:login reads its arguments from stdin.
- - `enforcer dispatch status` prints each failed criterion of a review item with its probability and the threshold.
- - Dispatcher pure logic ported to Node (src/dispatch: select, model, summarize, triage, prune, stream) with the matching tests on node:test.
- - Dispatcher runtime ported to Node (src/dispatch: api, lease, worktree, launch, run): process-group kill, signal drain, pids.json orphan reaping, usage-limit and CI holds; `enforcer dispatch` runs it (not on Windows).
- - Salvage, remediation, triage gate and landing completion ported to Node (src/dispatch: salvage, remediate, land-complete): PR reuse, auto-link neutralising, lander heartbeats, acceptance output as landing evidence, no launch mid-landing.
- - Port the evidence store (locked O_APPEND append, 50 MB cap, sweep, failing-first select, merge) to src/graph/evidence.mjs, byte-identical to the Python jsonl, with a differential test.
- - Run attach_evidence (evidence gate, gh PR resolution, enforcer-files upload, client attestation, usage) in-process in Node (src/graph/hooks/attach.mjs); the PreToolUse graph hook no longer needs python3.
- - Run track_run, heartbeat and capture_evidence in-process in Node (src/graph/hooks/*), so a graph-live PostToolUse spawns no python3; differential test against the Python handlers.
- Port of four hooks: session.mjs/version-check.mjs; python3 probe and hooks=off:python3 removed from bin/enforcer and src/event.mjs; doctor and preflight drop the python3 and fcntl checks (port-hooks-session).
- - land-pr is now Node (`enforcer land <pr>`, src/land.mjs); bin/land-pr.sh is a two-line shim to it, same exit codes.
- test/run.sh's 116 checks became node:test against a Node stub graph server (test/graph/run.test.mjs); npm test runs every suite and writes test-results/junit.xml; privateDir no longer spins on an unwritable /proc path.
- - Port lib.py state, run file, HTTP and redaction to src/graph (state, run, http, redact, clip) with node:test ports and a Python/Node redaction corpus test.
- - OAuth refresh retries once on timeout/5xx and keeps the current token until its real expiry; only invalid_grant/400/401 signs out, and the reason is recorded in oauth.last_refresh_error.
- - CI release gate accepts a `changes/<slug>.md` fragment instead of a version bump on PRs that touch enforcer/, so parallel fix PRs do not conflict on CHANGELOG.md.
- Removed the Python runtime (lib/graph, bin/graph-dispatch, python tests and checks); skill checks and credential-format test now run in Node, docs updated.
- - `enforcer doctor --bundle` writes a redacted tar.gz under the state dir (versions, config sources, credential metadata, doctor, log tails, receipts verify, outbox error, worker streams) and prints its path and size.
- The test script is now `node scripts/test.mjs`, which discovers every `*.test.mjs` under enforcer/test and lib/governor/test and runs each in its own process under the isolating preload with a per-suite timeout, so a new suite no longer edits a shared package.json line.
- - `enforcer uninstall [--purge]` removes the OTEL entries, headers shim, plugin-root and the Grok and Codex installs by manifest; state files carry schema_version and an older plugin refuses newer state; Codex install writes a manifest like Grok's.
- Doctor prints the Windows support position on win32 and README and graph docs state it: MCP, files and governor supported, graph hooks after the port, dispatcher POSIX only (windows-support-statement).
- - Dispatched workers now get an allowlisted environment (no operator keys) and a worker-scoped graph token minted per run via the agent credential route; gh gets only ENFORCER_WORKER_GH_TOKEN as GH_TOKEN.

## 1.0.5

Governor gate:
- Governor hooks fail closed (#76); default rules tokenise, strip wrappers, strictest wins (#81); settings guard denies anything but a plain read (#86).
- Headless worker denies unrecognised delivery shapes (#71); CLAUDE_PLUGIN_ROOT exported to workers (#91).
- Aliases become empty stubs, kit defaults off, README fixes (#74).

Evidence:
- Secrets redacted at capture time (#72); state, evidence and run files 0600 in 0700 dirs (#77).
- Evidence gate keyed by actor so subagents are captured (#70); failing commands captured (#80).

Other:
- CLI main guard works from any install path (#69); login logout revokes refresh token (#92); heartbeat by elapsed time (#89); `enforcer doctor` (#88); Codex marketplace shape and harness (#93).

## 1.0.4

- The governor announces itself: SessionStart (Claude, Codex, Grok shims and `bin/enforcer hook session-start`) sets `ENFORCER_GOVERNOR=1`.

## 1.0.3

- Governor: the secrets rule asks about credential-file access, not mentions (#64).

## 1.0.2

- graph-dispatch passes each plugin name once to a worker (#63); per-repo start-from base, missing base refused (#62).

## 1.0.1

- graph-dispatch: the worker agent is `enforcer:graph-worker` since the fold-in (#61); presets request `enforcer:workspace.write`, a 403 on switch names the scope and the re-login line (#60).

## 1.0.0 — enforcer

One plugin, `enforcer`, as an Agent Plugins 1.0 package that installs in Claude Code, Codex CLI and Grok Build. Claude Code stays the reference harness.

### Folded in
- **enforcer-governor**: the policy gate and tamper-evident decision records, history kept, wired into `enforcer`.
- **enforcer-graph**: the graph worker hooks (self-gating behind `bin/enforcer hook <event>`), skill, agent and dispatcher.
- **enforcer-files**: the files skill, `files.mjs`, upload and download commands.
- **State** moved to `~/.config/enforcer/` with first-run migration; no `~/.claude` path outside `hooks/claude/`.

### Adapters
- **Claude Code**: `.claude-plugin/plugin.json` fallback and hook shims in `hooks/claude/`.
- **Codex CLI**: `extensions.com.openai` overlay, `.agents/plugins/marketplace.json`, shims tested on Codex-shaped stdin.
- **Grok Build**: `harness/grok` hooks, `config.toml.snippet` MCP section, agent, `enforcer harness install grok` (experimental), hook fixtures captured from a grok 1.0.41 run.
- **MCP**: remote OAuth path proven without a shim; Codex and Grok MCP snippets.
- **Dispatcher**: `graph-dispatch --harness claude|codex|grok`. Claude and Grok parsers are tested on fixtures from real runs; Grok is experimental (`--experimental`); the Codex parser is a stub until a real `codex exec --json` sample exists.

### Deprecated aliases
`enforcer-graph`, `enforcer-files` and `enforcer-governor` are marketplace aliases for one release. Install `enforcer` instead: `claude plugin install enforcer@instruxi`.

### Related
`jev-hooks` 1.0.0 now depends on `enforcer` and contains no allow/deny policy.
