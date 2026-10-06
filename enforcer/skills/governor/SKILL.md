---
name: governor
description: The Enforcer governor — decides whether an agent action is allowed before it runs and keeps a tamper-evident record of every decision. Use when the user asks what the governor has seen, its spend limit or settings, or whether the decision record is intact.
---

# Governor

Print the output verbatim. Run `enforcer ...`; if it is not on PATH (Claude Code), use `node "${CLAUDE_PLUGIN_ROOT}/bin/enforcer" ...`.

| ask | run |
|---|---|
| What has the governor seen this session (spend, limits, record state)? | `enforcer governor status` |
| Every setting, what it does, which changed | `enforcer governor config [--why]` |
| Set the per-agent spend limit in dollars | `enforcer governor limit <dollars>` |
| Check the receipt chain; names the first bad record | `enforcer governor verify` |
| Decide one event (common event JSON on stdin) | `enforcer governor decide` |

`decide` prints the decision record `{"decision","code","rule","tool","summary"}`.
