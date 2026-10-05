#!/usr/bin/env python3
"""SessionStart (startup, resume, compact). Prints where the plan stands so the
session opens knowing what is runnable, what is running, and whether IT still
holds a run. Plain stdout becomes context. Silent without a project graph config.

Before that, and with or without a graph, it says ONCE (per version pair) when
an Instruxi plugin installed here is older than the copy in its marketplace
clone, and when enforcer-graph is installed without the `enforcer` plugin that
carries the MCP server. Both are what a person must fix in their own shell, so
they go to the person (systemMessage) and to the model."""
import json, os, sys
from collections import Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib, version_check
import claude_paths as _cp


def _vtuple(v):
    out = []
    for part in str(v or "").split("-")[0].split("."):
        try:
            out.append(int(part))
        except ValueError:
            return None
    return tuple(out) if out else None


def _load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def marketplace_name():
    """The marketplace this copy was installed from: an installed plugin lives at
    <config>/plugins/cache/<marketplace>/<plugin>/<version>."""
    root = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    parts = os.path.normpath(root).split(os.sep)
    if len(parts) >= 4 and parts[-4] == "cache":
        return parts[-3]
    return "instruxi"


def base_url():
    doc = lib.read_credentials() or {}
    return str(os.environ.get("ENFORCER_BASE_URL") or (doc.get("enforcer") or {}).get("base_url") or version_check.DEFAULT_BASE)


def notices():
    """(key, text) for each thing the person should fix. Reads Claude Code's own
    plugin bookkeeping under its config directory; writes nothing there."""
    cfgdir = _cp.config_dir()
    mkt = marketplace_name()
    installed = ((_load(os.path.join(cfgdir, "plugins", "installed_plugins.json")) or {}).get("plugins")) or {}
    loc = (((_load(os.path.join(cfgdir, "plugins", "known_marketplaces.json")) or {}).get(mkt)) or {}).get("installLocation")
    out = [(f"drift:{l}", l) for l in version_check.report(cfgdir, mkt, lib.plugin_version(), lib.read_credentials(), base_url(), None)]
    if f"enforcer-graph@{mkt}" in installed and f"enforcer@{mkt}" not in installed:
        out.append((f"no-enforcer:{mkt}",
                    f"enforcer-graph: the `enforcer` plugin is not installed, so the graph tools have no MCP server here. "
                    f"Install it in your shell: claude plugin install enforcer@{mkt}  (it brings enforcer-graph's hooks with it), then /enforcer:setup"))
    return out


def unseen(items):
    """The notices not shown before, recording them so each is said once."""
    p = os.path.join(os.path.dirname(lib.data_dir()), "notices.json")
    seen = set(_load(p) or [])
    new = [(k, t) for k, t in items if k not in seen]
    if new:
        try:
            with open(p, "w") as f:
                json.dump(sorted(seen | {k for k, _ in new}), f)
        except Exception:
            pass
    return [t for _, t in new]


def main():
    inp = lib.read_stdin()
    try:
        said = unseen(notices())
    except Exception:
        said = []
    lines = status_lines(inp)
    try:
        w = version_check.workspace_line(lib.read_credentials())
    except Exception:
        w = None
    if w:
        lines.insert(0, w)
    if said:
        print(json.dumps({"systemMessage": "\n".join(said),
                          "hookSpecificOutput": {"hookEventName": "SessionStart",
                                                 "additionalContext": "\n".join(said + lines)}}))
    elif lines:
        print("\n".join(lines))


def status_lines(inp):
    cfg = lib.find_config(inp.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR"))
    if not cfg:
        return []
    g = cfg["graph_id"]
    fr = lib.http(cfg, "GET", f"/graphs/{g}/frontier")
    nodes = lib.http(cfg, "GET", f"/graphs/{g}/nodes?limit=100")
    if fr is None and nodes is None:
        return []
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
    return lines


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
