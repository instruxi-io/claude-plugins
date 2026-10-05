---
name: governor
description: The Enforcer governor — decides whether an agent action is allowed before it runs and keeps a tamper-evident record of every decision. Use when the user asks what the governor has seen, its spend limit or settings, or whether the decision record is intact.
---

# Governor

Run from the plugin root; print the output verbatim.

| ask | run |
|---|---|
| What has the governor seen this session (spend, limits, record state)? | `node bin/enforcer governor status` |
| Every setting, what it does, which changed | `node bin/enforcer governor config [--why]` |
| Set the per-agent spend limit in dollars | `node bin/enforcer governor limit <dollars>` |
| Check the receipt chain; names the first bad record | `node bin/enforcer governor verify` |
| Decide one event (common event JSON on stdin) | `node bin/enforcer governor decide` |

`decide` prints the decision record `{"decision","code","rule","tool","summary"}`.
