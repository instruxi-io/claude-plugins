---
name: graph
description: Work a plan held in enforcer-graph — claim the next runnable node, do it, keep the lease alive, report against its acceptance criteria. Use when a project has .claude/graph.json, when asked to "work the plan", "take the next node", "claim from the frontier", or when the enforcer-graph MCP tools (graph_next_work, graph_report, graph_heartbeat, graph_plan_status, graph_remember) are available.
---

# Working a graph

enforcer-graph holds a plan as a DAG. Nodes are tasks; each carries
`data.acceptance`, the list of lines your report will be judged against. You
never decide what to do next: the graph does, from the edges.

## The loop

1. **`graph_next_work`** — claims one runnable node under a row lock and returns
   one card: the node, its `acceptance` lines, attached `skills` (read them
   before starting), recent `observations` (facts earlier runs left), and the
   `run` you now hold (`run_id`, `lease_expires_at`). Two sessions can never
   receive the same node.
   - `state: wait` — nothing runnable, something running. Do not poll in a tight
     loop; say you are waiting and stop.
   - `state: complete` — nothing runnable, nothing running. The plan is done, or
     failed nodes block the rest; the card says which.
2. **Work the node** in its own worktree or branch named after `node.key`.
3. **`graph_heartbeat`** — you hold a lease, not the node. The plugin's hook
   heartbeats every ten tool calls for you; call it yourself before any long
   silent step. The response `state` is an instruction:
   - `ok` — keep working.
   - `cancel_requested` — stop, `graph_remember` what is worth keeping, then
     `graph_report` with `status: cancelled`.
   - `reclaimed` — your lease lapsed and another harness owns the node. STOP.
     A report from this run will be refused. `graph_remember` any progress worth
     keeping, then `graph_next_work`.
   - `finished` — the run already ended. Nothing to report; `graph_next_work`.
4. **`graph_report`** — `status: succeeded | failed | cancelled` plus a `report`.
   The response carries `verification` (when judgment is enabled on the tenant)
   and `released`, the nodes your outcome made runnable. They are not claimed;
   `graph_next_work` claims one.
5. **`graph_remember`** — write a fact about a node at any time: a decision, a
   measurement, something the next run must know. The server dedupes and can
   flag a contradiction with an earlier observation; read `judgment` in the
   response.

`graph_plan_status` is the whole plan on one card: counts, frontier, running,
failed, unverified runs. Call it when asked how the plan stands, not every turn.

## Two conventions that silently invert the plan if reversed

- **A dependency edge points FROM the dependent TO its prerequisite.**
  `build --requires--> setup` means "build requires setup". The frontier is the
  set of unfinished nodes whose every outgoing `requires` edge points at a done
  node. Reverse an edge and the plan runs backwards without an error.
- **A repeated step is a node with several runs, never a loop edge.** A retry is
  attempt N+1 on the same node. On a dag-mode graph an edge that would close a
  cycle is refused with `409 edge_would_create_cycle`.

## Writing a report the server can judge

The report is judged line by line against `data.acceptance`. Write it as a
numbered list in the same order as the acceptance lines, each answered with
**evidence** (paths, commands run, test output, PR URL, measured numbers) and
marked **met** or **not met**. State plainly what was not done and why. A
report that asserts success without evidence scores low; a report that says
"not met, because X" scores honestly and lets a human decide.

```
PR: https://github.com/org/repo/pull/12 (branch plan/<key>, not merged)
1. <acceptance line 1> — MET. <what exists, how it was checked>
2. <acceptance line 2> — NOT MET. <what is missing and why>
```

## Evidence is captured, not written

You do not write the `evidence` argument of `graph_report`. The plugin's
PostToolUse hook records it while you work — every `Bash` command with its exit
code and output, every `Edit`/`Write` with the path and what it wrote — and its
PreToolUse hook on `graph_report` attaches the capture to the call. Reads,
greps and globs are not captured: reading is not evidence of doing.

- **Do not hand-write evidence.** Anything you put in `evidence` is replaced by
  the capture. The point is that the proof is not yours to author.
- **A report with no captured evidence is `unsupported`**, not verified. If you
  claim a test passes, run it — the run is what the judge reads.
- Prose still matters: the report says which acceptance line each piece of
  evidence answers. The evidence says it happened.
- The cap is 20 items, failing commands first. A long run keeps its failures
  and its most recent work, not its beginning.

`status: succeeded` is for a report where every line is met. Use `failed` when
one is not; the node stays claimable for another attempt with your report as
its history.

## Before stopping

Report the run or say explicitly that you are leaving it open. The plugin's
Stop hook sends you back once if a run is open and unreported.
