# The canonical `enforcer` release

**Status:** approved design, 2026-10-05. Executed by the enforcer-graph plan
`enforcer-canonical-release`. Every node of that plan reads this document first;
when a node and this document disagree, fix the document in the same PR.

## Decision

Instruxi ships **two** plugins:

- **`enforcer`** — the product. The Enforcer MCP server connection, sign-in and
  workspace switching, workspace files, the graph worker and its dispatcher, and
  the governor (policy gate + tamper-evident decision records). Published as one
  [Agent Plugins 1.0](https://agent-plugins.org/) package so it installs in
  Claude Code, Codex CLI and Grok Build from the same artifact. Claude Code stays
  the first-class, reference harness: its adapter ships in the package and is the
  one every other adapter is tested against.
- **`jev-hooks`** — Instruxi staff only. The nine Jev-backed *quality* hooks
  (narrow output, loop detection, pre-compact triage, stop self-check, subagent
  verify, model routing…). It declares `enforcer` as a dependency and contains **no
  allow/deny policy**: that is the governor's, inside `enforcer`.

`enforcer-graph`, `enforcer-files` and `enforcer-governor` stop existing as
separate installs. Their marketplace entries become deprecated aliases that point
at `enforcer` for one release, then go.

Why one package: a policy gate that can be installed-but-disabled is not a gate
(2026-10-05: the governor was disabled on the owner's machine while jev-hooks
deferred to it because its cache directory existed — no gate at all). Version skew
between four plugins cost a day on the agents-platform build. Every user of the
MCP plugin is a user of the governor; nobody installs the governor without a
workspace. A plugin boundary is not a security boundary: all hooks run in one
process with one set of permissions.

## What is portable, what is an adapter

The industry drew the line (Agent Plugins 1.0; Codex's and Grok's plugin formats
follow it): **MCP servers and skills are portable; hooks, agents and commands are
per-harness extensions.**

| layer | portable form | harness adapters |
|---|---|---|
| MCP connection | `mcp.json`: `{"type": "streamable-http", "url": "https://api.instruxi.dev/mcp"}`. The endpoint already answers 401 with `WWW-Authenticate: Bearer resource_metadata=…/.well-known/oauth-protected-resource/mcp`; Codex and Grok complete OAuth from that. | Claude: `.mcp.json` keeps the `headersHelper` shim for API-key users until Claude's remote-MCP OAuth is verified against this server; then the shim goes. |
| Skills | `skills/<name>/SKILL.md` for enforcer (login, workspace, setup), files (find/read/share/upload/download), graph (claim/work/heartbeat/report), governor (status/config/limit/verify). Slash commands become skills; a command file stays only where Claude needs the `/enforcer:x` surface. | none |
| Policy engine | `bin/enforcer governor decide` — reads the common event JSON (`hook_event_name`, `tool_name`, `tool_input`, `session_id`, `cwd`, `transcript_path`, `model`), returns the 2.9.0 decision record (`{"decision","code","rule","tool","summary"}`), writes the tamper-evident log. Harness-neutral; no Claude field names inside. | `hooks/claude/*.mjs`, `extensions.com.openai.hooks` (Codex), `harness/grok/hooks/*.json` (Grok): ten-line shims that map stdin → event JSON and the record → that harness's exit code / `hookSpecificOutput`. |
| Graph worker hooks | `bin/enforcer hook <event>` — evidence capture, heartbeat, open-run guard, remember-on-compact, version check — **self-gated**: they do nothing unless a graph context is live (`GRAPH_ID` set or a claimed run in the session state). | same three shims as above; one `hooks.json` per harness. |
| Dispatcher | `bin/graph-dispatch --harness claude|codex|grok` — lease, salvage, triage, `data.base`, contested resources are harness-neutral already; only the launch command and the stream parser differ (`claude -p --output-format stream-json`, `codex exec --json`, `grok -p … --output-format json`). | per-harness launcher + parser modules with fixtures recorded from real runs. |
| Graph-worker agent | Claude-only extra (`agents/graph-worker.md`); Codex skips agent handlers, Grok has `.grok/agents/` — a Grok agent file is generated from the same source. | |
| State | `~/.config/enforcer/` — credentials (already), governor records, session state, dispatcher state — keyed by harness where it differs. No `~/.claude` path anywhere in the package. | migration on first run moves what exists. |

## Package layout

```
enforcer/
  plugin.json              Agent Plugins 1.0 (name enforcer, version 1.0.0, $schema)
  mcp.json                 streamable-http, api.instruxi.dev/mcp
  .claude-plugin/plugin.json   Claude compatibility fallback (same version)
  .mcp.json                Claude: http + headersHelper (until OAuth verified)
  skills/{enforcer,files,graph,governor}/SKILL.md
  agents/graph-worker.md   Claude extra
  commands/*.md            Claude extra, thin: each just invokes its skill
  hooks/hooks.json         Claude adapter wiring -> bin/enforcer hook|governor
  hooks/claude/*.mjs       the shims
  harness/codex/           plugin.json extensions.com.openai overlay, hooks wiring
  harness/grok/            hooks/*.json templates, config.toml [mcp_servers.enforcer] snippet, agents/
  bin/enforcer             node CLI: login, workspace, files, headers, governor, hook, harness install <claude|codex|grok>
  bin/graph-dispatch       python
  bin/land-pr.sh
  lib/governor/            the decision core (moved from enforcer-governor with history)
  lib/graph/               the hook libraries (moved from enforcer-graph)
  test/                    node + python + bash; harness fixtures
docs/CANONICAL_RELEASE.md  this file
.claude-plugin/marketplace.json   enforcer 1.0.0; jev-hooks; deprecated aliases
.agents/plugins/marketplace.json  Codex marketplace, same artifact
```

## Rules every node follows

1. **No `~/.claude` in the package.** State under `~/.config/enforcer/`.
2. **No Claude field names below the shim.** The core takes the common event JSON.
3. **Every hook self-gates.** A user who never touches a graph pays nothing.
4. **Fixtures are verbatim.** A parser or shim is tested against the exact JSON a real
   harness emitted (copied from a run log), never a hand-written approximation —
   the salvage parser was "fixed" twice against invented cards before a real one
   showed the slug nested under `skill`.
5. **One version.** `plugin.json`, `.claude-plugin/plugin.json`, `package.json` and
   the marketplace carry the same string; the version-check hook compares one.
6. **History moves with code.** `enforcer-governor` and `enforcer-graph` fold in by
   `git subtree add` (or filter-repo), not by copy.
7. **Claude first.** Nothing lands that makes the Claude install worse than 0.27.3 /
   2.9.0 / 0.7.0 today; Codex and Grok adapters are additive.
8. **Delivery:** branch `graph/<key>`, PR via `land-pr.sh`, verbatim gate output as
   the last evidence; one node per report.

## Plan (nodes)

| key | repo | does | depends on |
|---|---|---|---|
| `design-doc` | claude-plugins | this document | kickoff |
| `package-layout-agent-plugins` | claude-plugins | root `plugin.json`/`mcp.json`/`skills/`, commands → skills, `.claude-plugin` fallback, version 1.0.0-rc.1, schema validation test | design-doc |
| `mcp-oauth-no-shim` | claude-plugins | prove the remote MCP OAuth path from a non-Claude client; `harness/{codex,grok}` MCP snippets; smoke script | design-doc |
| `governor-core-cli` | enforcer-governor | extract `governor decide` CLI + common event JSON; hooks become shims; tests | design-doc |
| `governor-fold-in` | claude-plugins | subtree enforcer-governor into `enforcer/lib/governor` + `bin/enforcer governor`; Claude hooks wired; marketplace alias | package-layout, governor-core-cli |
| `graph-fold-in` | claude-plugins | subtree enforcer-graph into `enforcer/`; hooks self-gate; `bin/enforcer hook`; agent; dispatcher; alias | package-layout |
| `files-fold-in` | claude-plugins | enforcer-files skill + bins into `enforcer`; alias | package-layout |
| `state-relocation` | claude-plugins | every `~/.claude` path → `~/.config/enforcer/…` with first-run migration | governor-fold-in, graph-fold-in |
| `hook-adapter-codex` | claude-plugins | `extensions.com.openai` overlay, hooks wiring, `.agents/plugins/marketplace.json`; shim tests on Codex stdin fixtures | governor-fold-in, graph-fold-in |
| `hook-adapter-grok` | claude-plugins | `harness/grok` hooks + config + agents; `enforcer harness install grok`; shim tests on Grok fixtures (grok 1.0.41 is installed on the owner's machine) | governor-fold-in, graph-fold-in |
| `dispatcher-harness-switch` | claude-plugins | `--harness`; launchers + parsers + fixtures for codex/grok | graph-fold-in |
| `jev-hooks-quality-only` | jev-hooks | depend on `enforcer`; delete bash/edit allow-deny; governor detection = `ENFORCER_GOVERNOR` env only; 1.0.0 | governor-fold-in |
| `release-1.0` | claude-plugins | version 1.0.0 everywhere, CHANGELOG, deprecated aliases, tag, `claude plugin validate` | state-relocation, hook-adapter-codex, hook-adapter-grok, dispatcher-harness-switch, files-fold-in, mcp-oauth-no-shim, jev-hooks-quality-only |
| `gate-release-smoke` | — (human) | install `enforcer` 1.0.0 fresh in Claude Code and Grok Build on the owner's machine, claim + report one node through each, confirm the governor records both | release-1.0 |
| `cleanup` | ops | archive `enforcer-governor` repo, remove old plugin caches and deprecated installs, remove the dangling `enforcer-graph@enforcer-graph` settings entry, update enforcer-graph docs/WORKER_BRIEF | gate-release-smoke |

Nodes that edit `enforcer/` declare `data.resources: ["claude-plugins/enforcer"]`
so the dispatcher never runs two of them at once.
