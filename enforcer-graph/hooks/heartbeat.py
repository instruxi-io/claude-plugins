#!/usr/bin/env python3
"""PostToolUse on every tool. Every Nth tool call, if this session holds a run,
extend its lease over HTTP. Silent when the state is ok. When the control
channel says cancel_requested, reclaimed or finished, say so in one line, both
to the user (systemMessage) and to the model (additionalContext), and forget a
run that is no longer ours. Budget: one HTTP call with a 1.5s timeout."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

EVERY = int(os.environ.get("GRAPH_HEARTBEAT_EVERY", "10"))


def tick(sid):
    p = os.path.join(lib.data_dir(), f"{sid or 'unknown'}.count")
    n = 0
    try:
        n = int(open(p).read().strip() or 0)
    except Exception:
        pass
    n += 1
    try:
        open(p, "w").write(str(n))
    except Exception:
        pass
    return n


def main():
    inp = lib.read_stdin()
    sid = lib.actor_key(inp)
    if lib.is_graph_tool(inp.get("tool_name")):
        return  # the graph tools speak to the server themselves; track_run handles them
    run = lib.load_run(sid)
    if not run:
        return
    if tick(sid) % EVERY:
        return
    cfg = lib.find_config(inp.get("cwd"))
    if not cfg:
        return
    r = lib.http(cfg, "POST", f"/graphs/{run['graph_id']}/nodes/{run['node_id']}/runs/{run['run_id']}/heartbeat", {})
    d = (r or {}).get("data") or {}
    state = d.get("state")
    if state == "ok" or not state:
        return
    key = run.get("key") or run["node_id"]
    msg = {
        "cancel_requested": f"enforcer-graph: cancellation was requested for node {key}. Stop the work, graph_remember what is worth keeping, then graph_report it as cancelled.",
        "reclaimed": f"enforcer-graph: the lease on node {key} lapsed and another harness now owns it. Stop; a report from this run will be refused. graph_remember any progress worth keeping, then graph_next_work.",
        "finished": f"enforcer-graph: the run on node {key} has already ended. Nothing further to report; graph_next_work for the next node.",
    }.get(state, f"enforcer-graph: heartbeat state {state} on node {key}; treat as reclaimed and stop.")
    if state in ("reclaimed", "finished"):
        lib.clear_run(sid)
    print(json.dumps({"systemMessage": msg, "hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
