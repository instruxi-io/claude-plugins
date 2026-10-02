"""Structural checks on skills/graph/SKILL.md, run by test/run.sh.

The skill is loaded into every graph worker's context, so it must name real
tools with real parameters, and keep the worker rule that the per-agent
evidence capture depends on: whoever does the work claims and reports it. A
coordinator that claimed and reported 18 nodes for its subagents had all 18
judged `rejected / unsupported_by_evidence`.

Usage: python3 test/check_skill.py <frontmatter|tools|rules|upload>
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


if __name__ == "__main__":
    text = open(SKILL).read()
    try:
        {"frontmatter": frontmatter, "tools": tools, "rules": rules, "upload": upload}[sys.argv[1]](text)
    except AssertionError as e:
        print(e)
        sys.exit(1)
