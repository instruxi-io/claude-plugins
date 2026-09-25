#!/usr/bin/env python3
"""PostToolUse on every tool. While this session holds a run, append what the
tool actually did to ${CLAUDE_PLUGIN_DATA}/evidence/<actor>.jsonl.

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
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

EXIT_LINE = re.compile(r"^Error: Exit code (\d+)\s*", re.I)


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
    rec = {"kind": "command", "cmd": cmd[:lib.OUTPUT_CLIP], "exit": exit_code,
           "output": lib.clip_output(out)}
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
    return {"kind": "file", "path": path, "excerpt": str(excerpt)[:lib.EXCERPT_CLIP]}


def main():
    inp = lib.read_stdin()
    name = inp.get("tool_name") or ""
    if name not in ("Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"):
        return
    sid = lib.actor_key(inp)
    if not lib.load_run(sid):
        return  # no run held: nothing to attach this to, so nothing to record
    resp = normalize(inp.get("tool_response"))
    rec = bash_record(inp.get("tool_input"), resp) if name == "Bash" \
        else file_record(name, inp.get("tool_input"))
    if rec:
        lib.append_evidence(sid, rec)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
