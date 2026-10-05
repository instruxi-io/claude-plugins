#!/usr/bin/env python3
"""PreCompact. If this session holds a run, write one progress observation on
its node before the context is summarised, so the state of the work survives
in the graph rather than only in the summary. Side effect only."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib


def main():
    inp = lib.read_stdin()
    sid = inp.get("session_id")
    # actor_key for the LOOKUP (per-agent), session_id for the PROVENANCE below
    # (what a human searches by). See lib.actor_key.
    run = lib.load_run(lib.actor_key(inp))
    if not run:
        return
    cfg = lib.find_config(inp.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    if not cfg:
        return
    text = lib.last_assistant_text(inp.get("transcript_path") or "")
    if not text:
        text = "context was compacted while this run was open; no assistant summary was available"
    body = f"Progress at compaction ({inp.get('trigger') or 'auto'}), run {run['run_id']} in session {sid}:\n{text}"
    lib.http(cfg, "POST", f"/graphs/{run['graph_id']}/nodes/{run['node_id']}/observations",
             {"body": body, "source": f"claude-code:compact:{sid}", "data": {"session_id": sid, "run_id": run["run_id"], "kind": "progress"}})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
