#!/usr/bin/env python3
"""SessionStart (startup, resume, compact). Prints where the plan stands so the
session opens knowing what is runnable, what is running, and whether IT still
holds a run. Plain stdout becomes context. Silent without .claude/graph.json."""
import os, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib


def main():
    inp = lib.read_stdin()
    cfg = lib.find_config(inp.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    if not cfg:
        return
    g = cfg["graph_id"]
    fr = lib.http(cfg, "GET", f"/graphs/{g}/frontier")
    nodes = lib.http(cfg, "GET", f"/graphs/{g}/nodes?limit=100")
    if fr is None and nodes is None:
        return
    lines = [f"## enforcer-graph plan status (graph {g})"]
    rows = (nodes or {}).get("data") or []
    if rows:
        counts = Counter(n.get("status") for n in rows)
        lines.append("nodes by status: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        running = [n.get("key") for n in rows if n.get("status") == "running"]
        failed = [n.get("key") for n in rows if n.get("status") == "failed"]
        if running:
            lines.append("running: " + ", ".join(map(str, running)))
        if failed:
            lines.append("failed (claimable for retry once prerequisites are done): " + ", ".join(map(str, failed)))
    fnodes = (fr or {}).get("data") or []
    lines.append("frontier (runnable now, not claimed): " + (", ".join(str(n.get("key")) for n in fnodes) if fnodes else "none"))
    run = lib.load_run(lib.actor_key(inp))
    if run:
        lines.append(f"THIS SESSION HOLDS node {run.get('key') or run['node_id']} (run {run['run_id']}). Continue it, heartbeat rides on your tool calls, and graph_report it before stopping.")
    else:
        lines.append("Next: graph_next_work to claim, or graph_plan_status for the full card." if fnodes else "Nothing runnable; graph_next_work will say whether to wait or whether the plan is complete.")
    print("\n".join(lines))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
