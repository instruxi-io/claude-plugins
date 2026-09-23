#!/usr/bin/env python3
"""PreToolUse on graph_report. Attaches the evidence capture_evidence.py
recorded while the run was open, so the server judges what ran rather than what
the model says ran.

A hook cannot edit the arguments the model wrote; it can only answer the
harness. So this hook returns the whole argument object back with an `evidence`
array merged in, through `hookSpecificOutput.updatedInput`.

  Claude Code 2.1.278 applies `updatedInput` to MCP tool calls. Verified in the
  shipped binary: the PreToolUse result path validates the rewritten input with
  `n.inputSchema.safeParse(...)` and then explicitly DROPS `unrecognized_keys`
  issues, so a key the tool's schema does not declare does not deny the call;
  `if (Ee.updatedInput && Ee.permissionBehavior === undefined)` carries the
  rewrite with no permission decision attached; and the surrounding telemetry
  is MCP-aware (`isMcp`, `mcpServerType`, `e.mcpInfo`). The published docs say
  only "updatedInput - Modified tool input (PreToolUse only)" and never mention
  MCP either way, so this is read from the binary, not from the docs.

  `updatedInput` REPLACES the input object rather than merging into it, which
  is why this hook echoes every argument back.

  One surface does not apply it: a hook run through the remote/sandboxed tool
  path turns a rewrite into `permissionBehavior: "ask"` ("fallback_rewrite")
  instead of applying it. Set GRAPH_EVIDENCE_MODE=context there: the capture is
  then handed to the model as text to pass on verbatim, which is a weaker
  guarantee - the model is back in the loop and could edit it.

Fails open: nothing captured, no data dir, garbage stdin -> no output, and the
report the model wrote goes through untouched.
"""
import json, re, subprocess, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

MODE = os.environ.get("GRAPH_EVIDENCE_MODE", "input").strip().lower()

NOTE = ("enforcer-graph: {n} evidence item(s) captured from your own tool results "
        "were attached to this report. Do not hand-write evidence.")

HANDOFF = ("enforcer-graph: this harness cannot rewrite an MCP tool's arguments, so pass the "
           "following captured evidence as the `evidence` argument of graph_report VERBATIM - "
           "do not edit, summarise, reorder or add to it. It was captured from your own tool "
           "results while the run was open.\n\n{js}")



REMEMBER_RECENT = 3       # records that could plausibly support one fact
PR_URL = re.compile(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)")


def check_pr(url):
    """Resolve a claimed pull request with `gh`, and record what it says.

    Not a validator that refuses: an unresolvable PR is itself a finding, and
    the judge should see it rather than have the hook silently drop the claim.
    Bounded and fails open — no gh, no network, a private repo, a timeout, all
    return None and the report goes through as the model wrote it.
    """
    m = PR_URL.search(url or "")
    if not m:
        return None
    owner, repo, num = m.group(1), m.group(2), m.group(3)
    try:
        r = subprocess.run(
            ["gh", "pr", "view", num, "-R", f"{owner}/{repo}", "--json", "state,title,mergedAt,url"],
            capture_output=True, text=True, timeout=10)
    except Exception:
        return None
    if r.returncode != 0:
        err = (r.stderr or "").strip().splitlines()
        if not err:
            return None
        return {"kind": "artifact", "url": url, "label": "pull request NOT FOUND",
                "output": f"gh pr view {num} -R {owner}/{repo} -> {err[-1][:200]}"}
    try:
        d = json.loads(r.stdout)
    except Exception:
        return None
    return {"kind": "artifact", "url": d.get("url") or url,
            "label": f"pull request {d.get('state', '?').lower()}: {(d.get('title') or '')[:120]}",
            "output": f"gh pr view {num} -R {owner}/{repo} -> state={d.get('state')} merged={d.get('mergedAt') or 'no'}"}

def main():
    inp = lib.read_stdin()
    tool = (inp.get("tool_name") or "")
    is_report = tool.endswith("graph_report")
    is_remember = tool.endswith("graph_remember")
    if not (is_report or is_remember):
        return
    sid = lib.actor_key(inp)
    records = lib.load_evidence(sid)
    if not records:
        # Nothing captured - a run with no Bash and no edit, or a data dir we
        # could not write. Fail open: say nothing rather than strip whatever the
        # model supplied. A report with no evidence is the server's call, not a
        # hook's.
        return
    if is_remember:
        # A FACT is not a run. Everything captured during the run supports the
        # report; only what just happened plausibly supports "the lease is 300
        # seconds". So attach the most recent few, not the lot.
        #
        # Over-attaching is safe by construction and that is why this heuristic
        # is allowed to be rough: the judge asks whether the record SHOWS the
        # claim, so an irrelevant record yields `asserted`, never a false
        # `grounded`. Measured — a false claim against a record that disproves
        # it scored 0.01. Attaching the wrong thing costs a missed grounding,
        # never a wrong one.
        evidence = lib.select_evidence(records[-REMEMBER_RECENT:], cap=REMEMBER_RECENT)
    else:
        evidence = lib.select_evidence(records)
    # A `pr` on the report is the ONE claim that is externally checkable, and
    # nothing checked it: a URL for a pull request that does not exist was
    # stored and shown as if it were a result (measured against production
    # 2026-09-20 with .../pull/999999). `gh` already has the credentials the
    # server does not and must not, so resolve it HERE and attach what it says
    # as evidence — a real title and state, or the fact that it is not there.
    pr = (inp.get("tool_input") or {}).get("pr") if is_report else None
    checked = check_pr(pr) if isinstance(pr, str) and pr.strip() else None
    if checked:
        evidence = (evidence + [checked])[:lib.MAX_EVIDENCE] if hasattr(lib, "MAX_EVIDENCE") else evidence + [checked]
    out = {"hookEventName": "PreToolUse"}
    if MODE == "context":
        out["additionalContext"] = HANDOFF.format(js=json.dumps(evidence, indent=None))
    else:
        args = inp.get("tool_input")
        args = dict(args) if isinstance(args, dict) else {}
        args["evidence"] = evidence          # replaces anything the model wrote there
        out["updatedInput"] = args
        out["additionalContext"] = NOTE.format(n=len(evidence))
    print(json.dumps({"hookSpecificOutput": out}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
