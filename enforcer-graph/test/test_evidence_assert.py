"""graph_report is blocked when the evidence misses a kind the card's hints ask for."""
import json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
sys.path.insert(0, HOOKS)
os.environ["CLAUDE_PLUGIN_DATA"] = tempfile.mkdtemp()
os.environ.pop("GRAPH_API_KEY", None)
import lib  # noqa: E402
import attach_evidence as ae  # noqa: E402

HINTS = [
    {"criterion": "the file review.md is written", "kind": "file", "evidence": "the file body"},
    {"criterion": "PR landed via land-pr.sh", "kind": "pr", "evidence": "land-pr output"},
]
CAT = {"kind": "command", "cmd": "cat review.md", "exit": 0, "output": "# review"}
LAND = {"kind": "command", "cmd": "land-pr.sh 7", "exit": 0, "output": '{"merged": true, "state": "merged"}'}
TOOL = "mcp__plugin_enforcer_enforcer__graph_report"


def run(records, hints=HINTS, **extra):
    os.makedirs(os.path.join(os.environ["CLAUDE_PLUGIN_DATA"], "runs"), exist_ok=True)
    inp = {"session_id": "ea", "tool_name": TOOL, "cwd": "/",
           "tool_input": dict({"node_id": "n", "run_id": "r1", "status": "succeeded", "report": "x"}, **extra)}
    sid = lib.actor_key(inp)
    lib.clear_evidence(sid)
    lib.save_run(sid, {"run_id": "r1", "claimed_at": "2026-10-01T10:00:00.000Z", "acceptance_evidence": hints})
    for r in records:
        lib.append_evidence(sid, dict(r, _run="r1"))
    return ae.decide(inp)


class EvidenceAssertTest(unittest.TestCase):
    def test_blocks_naming_criterion_and_fix(self):
        out = run([LAND])
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("criterion 1", out["permissionDecisionReason"])
        self.assertIn("cat <file>", out["permissionDecisionReason"])
        self.assertNotIn("criterion 2", out["permissionDecisionReason"])

    def test_passes_when_met(self):
        out = run([CAT, LAND])
        self.assertNotIn("permissionDecision", out)
        self.assertIn("updatedInput", out)

    def test_no_hints_fails_open(self):
        self.assertNotIn("permissionDecision", run([LAND], hints=None))

    def test_failed_report_not_blocked(self):
        self.assertNotIn("permissionDecision", run([LAND], status="failed"))

    def test_override_needs_reason_and_is_recorded(self):
        out = run([LAND], evidence_override=True)
        self.assertEqual(out["permissionDecision"], "deny")
        out = run([LAND], evidence_override=True, evidence_override_reason="file is binary")
        self.assertNotIn("permissionDecision", out)
        ti = out["updatedInput"]
        self.assertEqual(ti["data"]["evidence_override"]["reason"], "file is binary")
        self.assertNotIn("evidence_override", ti)


if __name__ == "__main__":
    unittest.main()
