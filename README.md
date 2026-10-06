# Instruxi kit for Claude Code

One marketplace for the Instruxi plugins. Add it once, then install what you
need.

The Enforcer API documents itself through the MCP server: `enforcer_api_search`
and `enforcer_api_describe` answer from the live spec, so there is no doc
plugin to drift out of date.

`enforcer` is the only default; the rest are opt-in or deprecated aliases.

| Plugin | Default | What it gives you | Source |
|---|---|---|---|
| `enforcer` | **on** | The `enforcer` MCP server and one sign-in, `/enforcer:login`, that every plugin here shares. A short skill on how Enforcer is organised. | this repo, `enforcer/` |
| `enforcer-files` | deprecated | Now part of `enforcer` (skill `files`, `/enforcer:upload`, `/enforcer:download`). Alias for one release. | `enforcer/` |
| `enforcer-graph` | deprecated | Now part of `enforcer` (the graph worker). Empty alias; uninstall it. | `aliases/enforcer-graph/` |
| `jev-hooks` | opt-in, **Instruxi staff** | Jev-backed hooks: Bash and edit risk gates, subagent model routing, subagent verification, a stop self-check, loop detection, compaction triage. | `instruxi-io/jev-hooks`, default branch |
| `enforcer-governor` | deprecated | Now part of `enforcer`. Do not install it separately. | `instruxi-io/enforcer-governor`, tag `v2.9.0` |

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
claude plugin install enforcer@instruxi             # includes the graph worker hooks and the governor
# enforcer-files is now part of enforcer; nothing more to install
```

### Codex CLI

The same `enforcer/` package installs in Codex through `.agents/plugins/marketplace.json`
(`enforcer/plugin.json` carries the `extensions.com.openai` overlay: hooks at
`./hooks/hooks.json`, display name). Codex also exports `CLAUDE_PLUGIN_ROOT`, so the hook
commands resolve unchanged.

```sh
codex plugin marketplace add instruxi-io/claude-plugins
codex plugin install enforcer@instruxi
codex mcp login enforcer
```

The shims are tested on Codex-shaped hook input (`enforcer/test/fixtures/codex`); events
the shims do not handle (`PermissionRequest`, `PostCompact`, `Interrupt`) are ignored with
exit 0 and no output. These fixtures are written from Codex's documented payload, and the
install commands above have not been run against a live Codex: Codex CLI is not installed
on the build machine.

### Grok Build (experimental)

Grok has no plugin marketplace here, so `enforcer` installs by copying itself into
place. This is experimental: the hook fixtures come from one grok 1.0.41 run, and
the dispatcher refuses `--harness grok` unless you pass `--experimental`.

```sh
enforcer harness install grok --dry-run   # list every file it would write
enforcer harness install grok             # asks before writing; --yes skips the question
enforcer harness uninstall grok           # removes only what the install manifest lists
```

It copies the runtime to `~/.config/enforcer/grok/<version>`, writes
`~/.grok/hooks/enforcer.json` and `~/.grok/agents/graph-worker.md`, adds an
`[mcp_servers.enforcer]` section to `~/.grok/config.toml` (and refuses if one exists and differs), and
puts an `enforcer` shim in `~/.local/bin`. Changed files are backed up first. Then sign in
with `enforcer login`.

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

Then, in Claude Code, sign in once and let setup show you the rest:

```
/enforcer:login
/enforcer:setup
```

That is the whole customer setup: **one install, then `/enforcer:setup`**.
`enforcer` carries the graph hooks itself, so you cannot end up with the MCP's
graph tools but no hooks behind them. `/enforcer:setup` asks the
server for the plan (the permission allow rules for the graph worker loop, the
plugin commands, and the first policy rules for this repo's routes), shows it,
and applies only what you confirm.

**Already installed?** `claude plugin update enforcer@instruxi`, then `/reload-plugins`. If you installed the old `enforcer-graph`, `enforcer-files` or `enforcer-governor` plugins, uninstall them: they are now part of `enforcer`.

**Switch workspace vs sign in again.** If you already belong to several
workspaces, move between them with `/enforcer:workspace list` and
`/enforcer:workspace switch <name|code|tenant_id>` (it keeps your sign-in and
swaps the token; `/enforcer:workspace current` shows tenant, role, account and
expiry). Only if you do not belong to the workspace yet, sign in with its code
(`/enforcer:login ACME-1234-ABCD`) or accept an invite. Login prints the
workspace it landed in.

If your admin gave you a workspace code, add it (`/enforcer:login ACME-1234-ABCD`)
and the sign-in page goes straight to your workspace's email step. A team can
set `ENFORCER_TENANT_CODE` in its shared settings to do the same for everyone.

The sign-in asks for every scope your Enforcer offers. To ask for fewer, name
them: `/enforcer:login --scope "enforcer:read policy:self"` (or set
`ENFORCER_SCOPE`). `/enforcer:login scopes` lists what is offered, and a scope
that is not offered is refused before the browser opens.

That one browser sign-in is what the `enforcer` MCP server and the governor
(inside `enforcer`) both use. Don't sign in through `/mcp` instead: that covers
the MCP tools but leaves the governor signed out. The credential is stored in
`~/.enforcer/credentials.json`; governor records and session state are under
`~/.config/enforcer/`.

That sign-in is also what the graph worker hooks use, so nobody needs an API
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

`enforcer` lives in this repo and follows its `main`. The deprecated
`enforcer-governor` alias is pinned to tag `v2.9.0`; the `enforcer-graph` and
`enforcer-files` aliases are empty stubs in this repo. `jev-hooks` follows its own
default branch.

## What leaves your machine

`jev-hooks` sends commands, prompts and tool results to TypeSafe's Jev to be
judged (see its README for exactly what each hook sends). The MCP servers talk
to `api.instruxi.dev`.
