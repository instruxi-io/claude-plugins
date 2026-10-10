# Context budget scout

Question: can a headless worker's context be capped below the harness limit, and what does it cost.
Scout only, no product code. All numbers below come from commands run on 2026-10-10 on this machine.

## 1. Does Claude Code expose a compaction trigger for `claude -p`

```
$ claude --version
2.1.296 (Claude Code)
$ claude --help | grep -A2 -- '--autocompact'
  --autocompact <auto|tokens>           Auto-compact window size (auto, or
                                        100k to 1M tokens)
```

Yes. `claude --version` 2.1.296 has a `--autocompact <auto|tokens>` flag, minimum 100k tokens.
The binary also contains the strings `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (`strings $(which claude) | grep -o ...`), and a settings key
`autoCompactWindow`. Only the flag was exercised here; the env vars and the settings key are
unverified. The floor is 100k, so it cannot cap a worker below 100k, but the median worker
(52.8K last call) never reaches it. It only bites the deep tail (max 295K).

Hook events: stream-json emits `SessionStart` with matcher `compact` after a compaction (seen
below), so the plugin's PreCompact and SessionStart hooks fire for the headless run.

## 2. Measured before/after

Same prompt, model haiku, `claude -p ... --output-format stream-json --verbose`: 12 Read calls of
six 142 KB files (each Read truncated to about 393 lines). Per-call context = input + cache_read +
cache_creation of each assistant message.

| | `--autocompact auto` | `--autocompact 100000` |
|---|---|---|
| turns (result event) | 13 | 14 |
| per-call context | 27418 x7, 161104 x7, 294807 x2 | 27418 x7, 160999 x7, 156055 x2 |
| last-call context | 294807 | 156055 |
| cache_read (result usage) | 201959 | 68273 |
| cache_creation (result usage) | 281364 | 276193 |
| total_cost_usd | 0.2816 | 0.3553 |

Stream evidence for the capped run: `compact_boundary` with `"trigger":"auto","pre_tokens":224636,
"post_tokens":67874`, plus one earlier status `compact_result":"failed","compact_error":"too_few_groups"`
(compaction cannot run when the transcript is only a few large tool results), and a
`SessionStart:compact` hook round.

Findings:
- The flag works: last-call context fell 294.8K to 156.1K (-47 percent).
- It is a threshold on the next call, not a hard cap: calls ran at 161K against a 100k window
  before compaction landed, because the 7 large reads arrived in one stretch.
- It cost money on this short, tool-output-heavy node: +26 percent USD (0.355 vs 0.282), one
  extra turn, and a summarising call. Compaction pays only when many more calls follow it. Here
  only 2 did. The saving shows in cache_read (-66 percent) and would grow with more calls after
  the fold; cache_creation did not fall.
- Caveat: one run each, haiku, synthetic reads, not a dispatched graph node. The dispatcher's done
  line (`cache_read`, `cache_creation`, `output`) was not available in this worktree, so a real
  dispatched before/after is still unmeasured.

## 3. Alternatives (flag exists, so these are the fallbacks)

1. Rely on the harness limit (today): no work, but the top 10 percent of runs hold 43 percent of
   cache reads and the tail reaches 295K.
2. Dispatcher restart with a handoff from graph memory when the stream's reported context crosses
   a budget: allows budgets below 100k, and the summary is graph-scoped and recallable. Cost per
   restart: a cold first call (median 17.4K tokens, 8.1K cache-hit) plus re-orientation turns.
   Turns lost per restart is not measured: no dispatcher logs exist on this machine, so only the
   token cost is estimated. It also touches leases and attempts, the surfaces the design says not
   to change.

Ranking for a worker that exceeds 100k: native `--autocompact` first (zero new surface, PreCompact
already folds into graph memory), restart-with-handoff second (only if a budget under 100k is
wanted), harness default last.

## Recommendation

Add `--autocompact 100000` as an opt-in dispatcher launch setting (off by default, per-graph
switch alongside `context.enabled`), and do not build the restart path yet. Gate it on a dispatched
before/after: run one deep node both ways and compare the done line. Compaction raised cost on the short
synthetic node, so it must be judged on deep nodes only. Acceptance line a later node should carry:
`claude -p` launched by the dispatcher with the flag on a deep node prints a `compact_boundary`
event in its stream, and its done line shows last-call context at or below 160K and `cache_read`
lower than the same node run without the flag.
