"""Structural checks on skills/graph/SKILL.md, run by test/run.sh.

The skill is loaded into every graph worker's context, so it must name real
tools with real parameters, and keep the worker rule that the per-agent
evidence capture depends on: whoever does the work claims and reports it. A
coordinator that claimed and reported 18 nodes for its subagents had all 18
judged `rejected / unsupported_by_evidence`.

Usage: python3 test/check_skill.py <frontmatter|tools|rules|upload|agent|plan>
Exit 0 on pass; on failure, prints what is wrong and exits 1.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = os.path.join(ROOT, "skills", "graph", "SKILL.md")
FILES_CLI = os.path.join(os.path.dirname(ROOT), "enforcer-files", "bin", "files.mjs")

# enforcer-v3-mcp src/graph.ts, graph-replay.ts, graph-validation.ts,
# graph-sharing.ts. Params are listed for the tools the loop documents; None
# means the skill may name the tool but not document its params.
TOOLS = {
    "graph_next_work": {"graph", "runner", "for", "node", "upstream_depth"},
    "graph_heartbeat": {"graph", "node_id", "run_id"},
    "graph_report": {"graph", "node_id", "run_id", "status", "report", "error", "pr", "data", "outputs", "evidence"},
    "graph_remember": {"graph", "node_id", "body", "source", "data", "evidence"},
    "graph_plan_status": None, "graph_review": None, "graph_reset": None, "graph_query": None,
    "graph_access": None, "graph_epochs": None, "graph_lifecycle": None, "graph_my_validations": None,
    "graph_judge": None, "graph_share": None, "graph_unshare": None,
}

RULES = [
    "## The worker rule",
    "Claim your own node with `graph_next_work`",
    "Never claim by id",
    "Report before you return",
    "Never report a node you did not claim",
    "Evidence is captured, not written",
    "files_base_url",
    "NOT MET — STALE",
    "## Done means merged",
    "## Coordinating subagents",
    "## Following the route",
    "override reason",
    "`node` parameter",
    "MCP 0.9.5",
    "user` beats `planner` beats `rule` beats `jev`",
    "Load the `enforcer-graph:graph`",
    "Never call `graph_report` for a worker",
]

UPLOAD = 'files.mjs | tail -1)" upload <log> --dir graph-evidence'


def frontmatter(s):
    assert s.startswith("---\n"), "no frontmatter"
    fm = s.split("---\n")[1]
    assert re.search(r"^name: graph$", fm, re.M), "name is not graph"
    d = re.search(r"^description: (.+)$", fm, re.M)
    assert d and 0 < len(d.group(1)) <= 1024, "description missing or over 1024 chars"


def tools(s):
    named = set(re.findall(r"\bgraph_[a-z_]+\b", s))
    assert named <= set(TOOLS), "not real tools: %s" % sorted(named - set(TOOLS))
    documented = re.findall(r"\*\*`(graph_[a-z_]+)`\*\* \(([^)]*)\)", s)
    assert len(documented) >= 4, "the loop no longer lists each tool's params"
    for tool, params in documented:
        used = set(re.findall(r"`([a-z_]+)`", params))
        real = TOOLS[tool] or set()
        assert used and used <= real, "%s: not real params: %s" % (tool, sorted(used - real))


def rules(s):
    missing = [r for r in RULES if r not in s]
    assert not missing, "missing: %s" % missing


def upload(s):
    assert UPLOAD in s, "upload command changed"
    cli = open(FILES_CLI).read()
    assert re.search(r"upload <path> .*\[--dir <directory>\]", cli), "files.mjs no longer takes upload --dir"


def agent(_s):
    t = open(os.path.join(os.path.dirname(SKILL), "..", "..", "agents", "graph-worker.md")).read()
    m = re.match(r"---\n(.*?)\n---\n", t, re.S)
    assert m, "no frontmatter"
    fm = m.group(1)
    assert re.search(r"^name: graph-worker$", fm, re.M), "name"
    assert re.search(r"^description: .{20,}", fm, re.M), "description"
    assert re.search(r"^model: sonnet$", fm, re.M), "model"
    tl = re.search(r"^tools: (.+)$", fm, re.M)
    assert tl, "tools allowlist"
    names = [x.strip() for x in tl.group(1).split(",")]
    for tool in ("graph_next_work", "graph_heartbeat", "graph_report"):
        for pre in ("plugin_enforcer_enforcer", "enforcer", "enforcer-graph"):
            assert "mcp__%s__%s" % (pre, tool) in names, "missing %s %s" % (pre, tool)
    assert not [n for n in names if "api_write" in n], "agent must not be allowed enforcer_api_write"
    body = t[m.end():]
    for line in body.splitlines():
        if "api_write" in line:
            assert re.search(r"[Nn]ever|bypass|not ", line), "api_write mentioned without a prohibition: " + line


MAX_BRIEF_FILES = 5
MAX_BRIEF_BYTES = 30 * 1024
# a node that defers to the plan instead of carrying its spec
POINTER = re.compile(r"\b(see|per|as in|refer to|read)\b[^.\n]{0,30}\b(plan|contract)\b[^.\n]{0,20}\b(section|part|§|doc|document)", re.I)


def plan_problems(nodes, root):
    """Problems in a plan's nodes ({key, description, data:{brief}}). Briefs are
    paths relative to `root`; a path that does not exist counts as 0 bytes."""
    out = []
    for n in nodes:
        key = n.get("key", "?")
        d = n.get("description", "")
        if POINTER.search(d) or re.search(r"\bplan section\b|§\s*\d", d, re.I):
            out.append("%s: description points at a plan section; the description is the spec" % key)
        brief = (n.get("data") or {}).get("brief") or []
        if len(brief) > MAX_BRIEF_FILES:
            out.append("%s: brief names %d files (max %d)" % (key, len(brief), MAX_BRIEF_FILES))
        total = 0
        for b in brief:
            path = os.path.join(root, b.split(" (")[0])
            size = os.path.getsize(path) if os.path.isfile(path) else 0
            if size > MAX_BRIEF_BYTES:
                out.append("%s: %s is %d bytes, over the %d limit for one document" % (key, b, size, MAX_BRIEF_BYTES))
            total += size
        if total > MAX_BRIEF_BYTES:
            out.append("%s: brief totals %d bytes (max %d)" % (key, total, MAX_BRIEF_BYTES))
    return out


def plan(_s):
    import tempfile
    good = [{"key": "a", "description": "Add X to Y. Bump Z to 3.", "data": {"brief": ["agents/graph-worker.md"]}}]
    with tempfile.TemporaryDirectory() as tmp:
        big = os.path.join(tmp, "big.md")
        open(big, "w").write("x" * (MAX_BRIEF_BYTES + 1))
        for i in range(6):
            open(os.path.join(tmp, "f%d.md" % i), "w").write("y")
        assert not plan_problems(good, os.path.dirname(ROOT)), "a clean node was rejected"
        bad = {
            "sees": {"key": "sees", "description": "Implement the lobby. See plan section 4.2 for details."},
            "six": {"key": "six", "description": "ok", "data": {"brief": ["f%d.md" % i for i in range(6)]}},
            "big": {"key": "big", "description": "ok", "data": {"brief": ["big.md"]}},
            "sum": {"key": "sum", "description": "ok", "data": {"brief": ["big.md", "f1.md"]}},
        }
        for name, node in bad.items():
            assert plan_problems([node], tmp), "sample node %r was not rejected" % name
        assert not plan_problems([{"key": "five", "description": "ok", "data": {"brief": ["f%d.md" % i for i in range(5)]}}], tmp)
    # the skill itself must state the limits the check enforces
    s = open(SKILL).read()
    for need in ("at most 5 files and 30 KB", "`scout`", "WORKER_BRIEF.md", "8 KB", "description IS its spec"):
        assert need in s, "SKILL.md missing: " + need
    w = open(os.path.join(ROOT, "agents", "graph-worker.md")).read()
    for need in ("maxTurns: 80", "WORKER_BRIEF.md", "turn 12", "turn 20", "ONLY"):
        assert need in w, "graph-worker.md missing: " + need
    skill = open(SKILL).read()
    for name, txt in (("graph-worker.md", w), ("SKILL.md", skill)):
        assert "`git push -u origin graph/<key>`" in txt, name + " must say to push alone as git push -u origin graph/<key>"
        assert re.search(r"never chained", txt), name + " must say the push is never chained"


if __name__ == "__main__":
    text = open(SKILL).read()
    try:
        {"frontmatter": frontmatter, "tools": tools, "rules": rules, "upload": upload, "agent": agent, "plan": plan}[sys.argv[1]](text)
    except AssertionError as e:
        print(e)
        sys.exit(1)
