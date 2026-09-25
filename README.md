# Instruxi kit for Claude Code

One marketplace for the Instruxi plugins. Add it once, then install what you
need.

The Enforcer API documents itself through the MCP server: `enforcer_api_search`
and `enforcer_api_describe` answer from the live spec, so there is no doc
plugin to drift out of date.

`enforcer` and `enforcer-graph` are the defaults; the rest are opt-in.

| Plugin | Default | What it gives you | Source |
|---|---|---|---|
| `enforcer` | **on** | The `enforcer` MCP server and one sign-in, `/enforcer:login`, that every plugin here shares. A short skill on how Enforcer is organised. | this repo, `enforcer/` |
| `enforcer-files` | opt-in | Files in your workspace: find, read and share them through the MCP server; `/enforcer-files:upload` and `:download` move the bytes, never through the model. | this repo, `enforcer-files/` |
| `enforcer-graph` | **on** | Work a plan held in enforcer-graph: claim a node, keep its lease, report against its criteria. | this repo, `enforcer-graph/` |
| `jev-hooks` | opt-in, **Instruxi staff** | Jev-backed hooks: Bash and edit risk gates, subagent model routing, subagent verification, a stop self-check, loop detection, compaction triage. | `instruxi-io/jev-hooks`, default branch |
| `enforcer-governor` | opt-in | Decides whether an agent action may run and keeps a tamper-evident record. Uses the `enforcer` sign-in. | `instruxi-io/enforcer-governor`, tag `v2.6.2` |

## Before you start

- **An Enforcer account** in your workspace (an invite from an admin), and the
  workspace's tenant code: the sign-in page asks for it, and the code decides
  which workspace you land in. There is no API key to get.
- **Instruxi staff only, for `jev-hooks`:** access to the private
  `instruxi-io/jev-hooks` repo (Claude Code clones it with your own git
  credentials) and your own `TYPESAFE_API_KEY` from console.typesafe.ai.

## Install

```sh
claude plugin marketplace add instruxi-io/claude-plugins
claude plugin install enforcer@instruxi
claude plugin install enforcer-graph@instruxi        # optional: work and write plans
claude plugin install enforcer-files@instruxi        # optional: workspace files, upload and download
claude plugin install enforcer-governor@instruxi     # optional: govern agent actions
```

**Instruxi staff** can also install `jev-hooks@instruxi` (put your Jev key in
`~/.claude/settings.json` as `{ "env": { "TYPESAFE_API_KEY": "<your key>" } }`),
or run the `claude-loadout` wizard from the private jev-hooks releases, which
does all of this and reads `kit.json` for the defaults:

```sh
gh release download -R instruxi-io/jev-hooks \
  --pattern "claude-loadout-$(uname -s | tr 'A-Z' 'a-z')-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
  --output ~/.local/bin/claude-loadout --clobber && chmod +x ~/.local/bin/claude-loadout
claude-loadout setup          # --dry-run first, if you want to see the plan
```

Then, in Claude Code, sign in once:

```
/enforcer:login
```

If your admin gave you a workspace code, add it (`/enforcer:login ACME-1234-ABCD`)
and the sign-in page goes straight to your workspace's email step. A team can
set `ENFORCER_TENANT_CODE` in its shared settings to do the same for everyone.

That one browser sign-in is what the `enforcer` MCP server and
`enforcer-governor` both use. Don't sign in through `/mcp` instead: that covers
the MCP tools but leaves the governor signed out.

That sign-in is also what `enforcer-graph`'s hooks use, so nobody needs an API
key. It grants the graph's work loop (claim, heartbeat, report, remember) and
plan authoring (import, templates, nodes, edges); deleting and sharing plans
stay with a person. If you added the server by hand earlier as `enforcer-graph`
with an `X-API-Key`, remove it (`claude mcp remove enforcer-graph -s user`):
while it exists, Claude Code hides the plugin's copy as a duplicate of the same
URL and every call runs with the key instead.

CI and containers, where nobody can sign in, use a scoped key instead:
`ENFORCER_API_KEY` (or `GRAPH_API_KEY` for the graph hooks).

Restart Claude Code after installing.

## Updating

```sh
claude plugin marketplace update instruxi
claude plugin update <plugin>@instruxi
```

`enforcer-governor` is pinned to a release tag and changes only when this
catalog moves the tag. `enforcer` and `enforcer-graph` live in this repo and
follow its `main`; `jev-hooks` follows its own default branch.

## What leaves your machine

`jev-hooks` sends commands, prompts and tool results to TypeSafe's Jev to be
judged (see its README for exactly what each hook sends). The MCP servers talk
to `api.instruxi.dev`.
