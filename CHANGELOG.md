# Changelog

## 1.0.4

- The governor announces itself: SessionStart (Claude, Codex, Grok shims and `bin/enforcer hook session-start`) sets `ENFORCER_GOVERNOR=1`.

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
- **Grok Build**: `harness/grok` hooks, `config.toml` MCP section, agent, `enforcer harness install grok`, fixtures recorded from a live grok run.
- **MCP**: remote OAuth path proven without a shim; Codex and Grok MCP snippets.
- **Dispatcher**: `graph-dispatch --harness claude|codex|grok`. Claude and Grok parsers are tested on recorded fixtures; the Codex parser is a stub until a real `codex exec --json` sample exists.

### Deprecated aliases
`enforcer-graph`, `enforcer-files` and `enforcer-governor` are marketplace aliases for one release. Install `enforcer` instead: `claude plugin install enforcer@instruxi`.

### Related
`jev-hooks` 1.0.0 now depends on `enforcer` and contains no allow/deny policy.
