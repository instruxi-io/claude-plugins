#!/usr/bin/env python3
"""PostToolUse on every tool. When the lease is a third spent (and
not within 20 s of the last beat), extend its lease over HTTP. Silent when the state is ok. When the control
channel says cancel_requested, reclaimed or finished, say so in one line, both
to the user (systemMessage) and to the model (additionalContext), and forget a
run that is no longer ours. Budget: one HTTP call with a 1.5s timeout."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

MIN_GAP = float(os.environ.get("GRAPH_HEARTBEAT_MIN_GAP", "20"))   # seconds between beats, at most
DEFAULT_LEASE = 300.0


def _ts(s):
    try:
        from datetime import datetime
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def lease_seconds(run):
    """The lease length, from the claim and its expiry; five minutes when unknown."""
    a, b = _ts(run.get("claimed_at") or ""), _ts(run.get("lease_expires_at") or "")
    return b - a if a and b and b > a else DEFAULT_LEASE


def due(run, now, long_call=False):
    """Beat when lease/3 has passed since the last beat (or claim), never twice within MIN_GAP.
    A Bash call longer than lease/2 beats at once (still subject to MIN_GAP)."""
    last = run.get("last_hb") or _ts(run.get("claimed_at") or "") or 0
    if now - last < MIN_GAP:
        return False
    return long_call or now - last >= lease_seconds(run) / 3


def call_seconds(inp):
    r = inp.get("tool_response")
    d = r.get("duration_ms") if isinstance(r, dict) else None
    d = d if d is not None else inp.get("duration_ms")
    return d / 1000.0 if isinstance(d, (int, float)) else 0


def beat(inp, run, sid, now=None, post=None):
    """One heartbeat. Returns the control state, 'reclaimed' also for a 404/409."""
    now = time.time() if now is None else now
    cfg = lib.find_config(inp.get("cwd"))
    if not cfg:
        return None
    usage = lib.typed_usage(lib.transcript_usage(lib.actor_transcript(inp), run.get("claimed_at")))
    status, r = (post or lib.http_status)(cfg, "POST", f"/graphs/{run['graph_id']}/nodes/{run['node_id']}/runs/{run['run_id']}/heartbeat",
                                          {"usage": usage} if usage else {})
    run["last_hb"] = now
    if status in (404, 409):
        run["reclaimed"] = True
        lib.save_run(sid, run)
        return "reclaimed"
    d = (r or {}).get("data") or {}
    if d.get("lease_expires_at"):
        run["lease_expires_at"] = d["lease_expires_at"]
        run["claimed_at"] = run.get("claimed_at") or d.get("started_at")
    lib.save_run(sid, run)
    return d.get("state")


def main():
    inp = lib.read_stdin()
    sid = lib.actor_key(inp)
    if lib.is_graph_tool(inp.get("tool_name")):
        return  # the graph tools speak to the server themselves; track_run handles them
    run = lib.load_run(sid)
    if not run or run.get("reclaimed"):
        return
    now = time.time()
    long_call = inp.get("tool_name") == "Bash" and call_seconds(inp) > lease_seconds(run) / 2
    if not due(run, now, long_call):
        return
    state = beat(inp, run, sid, now)
    if not state or state == "ok":
        return
    key = run.get("key") or run["node_id"]
    msg = {
        "cancel_requested": f"enforcer-graph: cancellation was requested for node {key}. Stop the work, graph_remember what is worth keeping, then graph_report it as cancelled.",
        "reclaimed": f"enforcer-graph: the lease on node {key} lapsed and another harness now owns it. Stop; a report from this run will be refused. graph_remember any progress worth keeping, then graph_next_work.",
        "finished": f"enforcer-graph: the run on node {key} has already ended. Nothing further to report; graph_next_work for the next node.",
    }.get(state, f"enforcer-graph: heartbeat state {state} on node {key}; treat as reclaimed and stop.")
    if state in ("reclaimed", "finished") and not run.get("reclaimed"):
        lib.clear_run(sid)   # a 404/409 keeps the run file, flagged, so the next graph call prints the notice
    print(json.dumps({"systemMessage": msg, "hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
