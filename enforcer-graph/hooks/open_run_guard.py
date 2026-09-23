#!/usr/bin/env python3
"""Stop. A session that holds a run and is about to end without reporting it
gets sent back once with the reason. stop_hook_active guards the second time.
A final message that says the run was reported, or is deliberately left open,
passes."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

PASS = re.compile(r"graph_report|reported (the|this) run|report(ed)? .* as (succeeded|failed|cancelled)|"
                  r"leav(e|ing) (it|the run|the node) open|still running|remains? open|handing (it )?back|"
                  r"graph_heartbeat said reclaimed|was reclaimed", re.I)


def main():
    inp = lib.read_stdin()
    if inp.get("stop_hook_active"):
        return
    run = lib.load_run(lib.actor_key(inp))
    if not run:
        return
    msg = inp.get("last_assistant_message") or ""
    if PASS.search(msg):
        return
    key = run.get("key") or run["node_id"]
    reason = (f"enforcer-graph: this session still holds node {key} (run {run['run_id']}) and has not reported it. "
              f"Before stopping, either graph_report it (succeeded or failed, with a report that answers each acceptance "
              f"line), or graph_remember your progress and say explicitly that you are leaving the run open.")
    print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
