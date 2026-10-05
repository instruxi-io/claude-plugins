#!/usr/bin/env python3
"""PostToolUse on every tool. While this session holds a run, append what the
tool actually did to ~/.config/enforcer/sessions/<harness>/evidence/<actor>.jsonl.

This is the load-bearing half of verification. A report is prose, and prose can
be invented: a fabricated report with invented paths, line numbers and test
names has scored full marks. What cannot be invented is a tool result the model
never touched, so the evidence a report is judged on is captured HERE, as the
results come back, and attached by attach_evidence.py at report time.

Captured:
  Bash                      -> {kind: command, cmd, exit, output}
  Edit / Write / MultiEdit  -> {kind: file, path, excerpt}
Not captured:
  Read / Grep / Glob and everything else - reading is not evidence of doing,
  and a capture no one will read is only a slower tool call.

No HTTP, no Jev, no model. It runs on every tool call, so it must stay cheap:
one stdin parse, one stat of the run file, one append.
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

DELIVERY_CMD = re.compile(r"gh\s+pr\s+(create|view)\b|land-pr\.sh")
EXIT_LINE = re.compile(r"^(?:Error: )?Exit code (\d+)\s*", re.I)


def normalize(resp):
    """The result of a tool that SUCCEEDED arrives as its structured result
    object; a tool that FAILED arrives as a plain string. Both are evidence."""
    if isinstance(resp, list):
        texts = [b.get("text") for b in resp if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(t for t in texts if t)
    return resp


def bash_record(tool_input, resp):
    cmd = (tool_input or {}).get("command") or ""
    if not cmd:
        return None
    exit_code, out = 0, ""
    if isinstance(resp, dict):
        # Claude Code's Bash result carries stdout/stderr/interrupted but NO exit
        # code - a zero-exit command is the only thing that reaches this shape.
        for k in ("exit_code", "exitCode", "returnCode", "code"):
            if isinstance(resp.get(k), int):
                exit_code = resp[k]
                break
        else:
            exit_code = 130 if resp.get("interrupted") else 0
        out = resp.get("stdout") or ""
        err = resp.get("stderr") or ""
        if err.strip():
            out = (out + "\n" + err) if out else err
    elif isinstance(resp, str):
        # "Error: Exit code 1\n<combined output>" - the failure path, and the
        # only place the real exit code is written down.
        m = EXIT_LINE.match(resp)
        if m:
            exit_code, out = int(m.group(1)), resp[m.end():]
        elif resp.lstrip().lower().startswith("error"):
            exit_code, out = 1, resp
        else:
            out = resp
    cmd, n_cmd = lib.redact(cmd)
    out, n_out = lib.redact(out)
    rec = {"kind": "command", "cmd": cmd[:lib.OUTPUT_CLIP], "exit": exit_code,
           "output": lib.clip_output(out)}
    if n_cmd + n_out:
        rec["redactions"] = n_cmd + n_out
    # The whole output rides beside the clip ONLY when the clip lost something,
    # so the data dir does not double for the common short command.
    # attach_evidence.py uploads it to enforcer-files and never sends it on.
    if len(out) > lib.OUTPUT_CLIP:
        rec["raw"] = lib.clip_output(out, lib.RAW_KEEP)
    return rec


def file_record(name, tool_input):
    ti = tool_input or {}
    path = ti.get("file_path") or ti.get("path") or ti.get("notebook_path") or ""
    if not path:
        return None
    if name == "Write":
        excerpt = ti.get("content") or ""
    elif name == "MultiEdit":
        edits = ti.get("edits")
        excerpt = "\n".join(str((e or {}).get("new_string") or "") for e in edits if isinstance(e, dict)) \
            if isinstance(edits, list) else ""
    else:
        excerpt = ti.get("new_string") or ti.get("new_source") or ti.get("content") or ""
    excerpt, n = lib.redact(str(excerpt))
    rec = {"kind": "file", "path": path, "excerpt": excerpt[:lib.EXCERPT_CLIP]}
    if n:
        rec["redactions"] = n
    return rec


def main():
    inp = lib.read_stdin()
    name = inp.get("tool_name") or ""
    captured = name in ("Bash", "Edit", "Write", "MultiEdit", "NotebookEdit")
    if not captured and (not name.startswith("mcp__") or lib.is_graph_tool(name)):
        return
    sid = lib.actor_key(inp)
    lib.mark_attested(sid, inp.get("session_id"))  # the hooks ran end to end: hooks=on is now honest
    run = lib.load_run(sid)
    if not run:
        return  # no run held: nothing to attach this to, so nothing to record
    rid = run.get("run_id")
    resp = normalize(inp.get("tool_response"))
    if inp.get("hook_event_name") == "PostToolUseFailure" or (resp is None and "error" in inp):
        # PostToolUseFailure carries the failure as a top-level `error` string
        # ("Exit code N\n<output>"), not as tool_response. Always a failed command.
        err = str(inp.get("error") or "")
        resp = err if (EXIT_LINE.match(err) or inp.get("is_interrupt")) else "Error: Exit code 1\n" + err
        if inp.get("is_interrupt") and not EXIT_LINE.match(err):
            resp = "Error: Exit code 130\n" + err
    rec = None
    if captured:
        rec = bash_record(inp.get("tool_input"), resp) if name == "Bash" \
            else file_record(name, inp.get("tool_input"))
    if rec:
        rec["_run"] = rid          # scoped to THIS run; attach strips it
        lib.append_evidence(sid, rec)
    # A pull request URL is an artifact only when a delivery command produced it
    # (the create, view and land-pr.sh commands), never a list or MCP output.
    if name == "Bash" and rec and DELIVERY_CMD.search(str(rec.get("cmd") or "")):
        for url in dict.fromkeys(lib.PR_RE.findall(rec.get("output") or "")):
            lib.append_evidence(sid, {"kind": "artifact", "url": url, "label": "pull request URL in tool output", "_run": rid})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
