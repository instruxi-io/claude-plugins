#!/usr/bin/env python3
"""Stop and SubagentStop (keyed by actor: agent_id for a subagent). A session that holds a run and is about to end without reporting it
gets sent back once with the reason. stop_hook_active guards the second time.
A final message ending `still running: <run id>` passes."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

# Pass only on an explicit marker at the END of the message: `still running: <run id>`.
# (A reported run is cleared from the run file by track_run, so no run file means nothing to guard.)
# Quoting the tool name, or loose phrases, no longer passes.
def passes(msg, run):
    m = re.search(r"still running:\s*`?([0-9A-Za-z-]+)`?[\s.]*$", msg or "", re.I)
    return bool(m) and m.group(1) == str(run.get("run_id"))


def main():
    inp = lib.read_stdin()
    if inp.get("stop_hook_active"):
        return
    run = lib.load_run(lib.actor_key(inp))
    if not run:
        return
    msg = inp.get("last_assistant_message") or ""
    if passes(msg, run):
        return
    key = run.get("key") or run["node_id"]
    reason = (f"enforcer-graph: this session still holds node {key} (run {run['run_id']}) and has not reported it. "
              f"Before stopping, either graph_report it (succeeded or failed, with a report that answers each acceptance "
              f"line), or graph_remember your progress and end your final message with `still running: {run['run_id']}`.")
    print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
