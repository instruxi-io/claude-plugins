#!/usr/bin/env python3
"""PostToolUse on the graph MCP tools. Records the run a session holds so the
other hooks know it: graph_next_work writes the run file; graph_report clears it;
a graph_heartbeat that says reclaimed or finished clears it too."""
import os, sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib


def main():
    inp = lib.read_stdin()
    name = inp.get("tool_name") or ""
    sid = lib.actor_key(inp)
    out = lib.tool_payload(inp.get("tool_response"))
    if name.endswith("graph_next_work"):
        if out.get("state") == "claimed":
            node = out.get("node") or {}
            run = out.get("run") or {}
            if node.get("node_id") and run.get("run_id"):
                lib.clear_evidence(sid)   # a new claim starts a clean capture: nothing before it is this run's
                lib.save_run(sid, {"graph_id": out.get("graph_id"), "node_id": node["node_id"], "run_id": run["run_id"],
                                   "key": node.get("key"), "title": node.get("title"), "lease_expires_at": run.get("lease_expires_at"),
                                   "acceptance_evidence": [h for h in (out.get("acceptance_evidence") or (out.get("criteria_hints")) or []) if isinstance(h, dict)],
                                   "claimed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"})
                if inp.get("session_id") and sid != inp.get("session_id"):
                    # session-keyed marker: the parent sees its subagents' live runs
                    try:
                        open(os.path.join(lib.data_dir(), "%s.live" % inp["session_id"]), "w").close()
                    except Exception:
                        pass
    elif name.endswith("graph_report"):
        # The run is over whether the server accepted the report or refused it as
        # not ours any more; either way there is nothing left to heartbeat.
        lib.clear_run(sid)
        if inp.get("session_id") and sid != inp["session_id"]:
            try:
                os.remove(os.path.join(lib.data_dir(), "%s.live" % inp["session_id"]))
            except Exception:
                pass
    elif name.endswith("graph_heartbeat"):
        if out.get("state") in ("reclaimed", "finished"):
            lib.clear_run(sid)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
