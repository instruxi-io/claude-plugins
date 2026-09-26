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
   one card: the node, its `criteria` (its own acceptance lines, the graph and
   tenant mandates marked `[mandate: …]`, and `[check]` rows the server
   evaluates in code), its `inputs` (values upstream nodes produced), attached
   `skills` (read them before starting), recent `observations` (facts earlier
   runs left), and the `run` you now hold (`run_id`, `lease_expires_at`). Two
   sessions can never receive the same node.
   - `state: wait` — nothing runnable, but something is running, verifying, or
     time-gated. When the card has `wait_until`, nothing can start before that
     instant: say so and stop. Do not poll in a tight loop.
   - `state: complete` — nothing runnable, running, verifying or time-gated. The
     plan is done, or failed nodes block the rest; the card says which.
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
   The response carries `verification` (when judgment is enabled on the tenant),
   an `outputs` block when the node declares outputs, a `checks` block when its
   criteria hold `[check]` rows, and `frontier_after`, the nodes runnable after
   your outcome. They are not claimed; `graph_next_work` claims one.
   - `node_status: verifying` — the run succeeded under a gate policy and its
     verdict is pending (a re-judge, or a person's approval). Its dependents
     are held until the verdict. It is not yours to poll and not yours to
     retry: move on with `graph_next_work`.
5. **`graph_remember`** — write a fact about a node at any time: a decision, a
   measurement, something the next run must know. The server dedupes and can
   flag a contradiction with an earlier observation; read `judgment` in the
   response.

`graph_plan_status` is the whole plan on one card: counts, frontier, running,
verifying, waiting (with `not_before`), failed, unverified runs. Call it when asked how the plan stands, not every turn.

## Inputs and outputs

- **Read inputs from the card; never re-derive them.** `inputs` says where each
  value came from (`image (docker_image) = ghcr.io/… — from ship-fix attempt 1,
  extracted 0.97`); `input_values` holds it exactly. Do not re-run `git
  rev-parse`, re-read a log or re-compute a number to get a value the card
  already handed you: the point is that the value is the one the upstream run
  was judged on. An input marked `ABSENT` is not an error — proceed without it,
  or report why you cannot.
- **Declare `outputs` only for computed values.** Anything verbatim in your
  evidence — a PR URL, a commit sha, a pushed image — is extracted from the
  evidence without you. Pass `outputs: {name: value}` on `graph_report` only
  for what you computed or chose (a count, a variance, an id you picked). Each
  declared value is judged against the evidence and dropped when the evidence
  does not show it, so the command that produced it must have run.
- **A verifying node is not yours to poll.** Its verdict arrives on the run
  (a worker re-judge, or a person approving it in `graph_review`). Do not
  heartbeat it, re-report it or call `graph_plan_status` in a loop waiting for
  it; take other work, or stop.

## Two conventions that silently invert the plan if reversed

- **A dependency edge points FROM the dependent TO its prerequisite.**
  `build --requires--> setup` means "build requires setup". The frontier is the
  set of unfinished nodes whose every outgoing `requires` edge points at a done
  node. Reverse an edge and the plan runs backwards without an error.
- **A repeated step is a node with several runs, never a loop edge.** A retry is
  attempt N+1 on the same node. On a dag-mode graph an edge that would close a
  cycle is refused with `409 edge_would_create_cycle`.

## Writing a report the server can judge

The report is judged line by line against the card's `criteria` (the node's
own lines, then the mandates; `[check]` rows are decided in code, not by your
prose). Write it as a numbered list in the same order, each answered with
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
