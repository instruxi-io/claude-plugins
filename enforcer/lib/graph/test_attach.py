import os as _o, sys as _s2; _s2.path.insert(0, _o.path.dirname(_o.path.abspath(__file__)))
import tmpclean  # noqa: F401
"""The evidence gate decides before any upload; the override names the acceptance line."""
import os, sys, tempfile, unittest
os.environ["CLAUDE_PLUGIN_DATA"] = tempfile.mkdtemp()
os.environ.pop("GRAPH_API_KEY", None)
# Run as `unittest lib/graph/test_attach.py` the loader has bound `lib` to the
# enforcer/lib directory; the hooks need lib.py, so swap it in and keep the
# loader's `lib.graph` reference alive.
_pkg = sys.modules.pop("lib", None)
_graph = sys.modules.get("lib.graph")
import lib  # noqa: E402
if _pkg is not None and _graph is not None:
    lib.graph = _graph
import attach_evidence as ae  # noqa: E402

HINTS = [{"criterion": "file written", "kind": "file", "evidence": "body"}]
REC = {"kind": "command", "cmd": "echo hi", "exit": 0, "output": "hi"}
TOOL = "mcp__plugin_enforcer_enforcer__graph_report"


def run(**extra):
    os.makedirs(os.path.join(os.environ["CLAUDE_PLUGIN_DATA"], "runs"), exist_ok=True)
    inp = {"session_id": "at", "tool_name": TOOL, "cwd": "/",
           "tool_input": dict({"node_id": "n", "run_id": "r1", "status": "succeeded", "report": "x"}, **extra)}
    sid = lib.actor_key(inp)
    lib.clear_evidence(sid)
    lib.save_run(sid, {"run_id": "r1", "claimed_at": "2026-10-01T10:00:00.000Z", "acceptance_evidence": HINTS})
    lib.append_evidence(sid, dict(REC, _run="r1"))
    return ae.decide(inp)


class Attach(unittest.TestCase):
    def setUp(self):
        self.uploads = []
        self._orig = lib.attach_files
        lib.attach_files = lambda ev, cfg: (self.uploads.append(1), ev)[1]

    def tearDown(self):
        lib.attach_files = self._orig

    def test_denied_report_uploads_nothing(self):
        out = run()
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertEqual(self.uploads, [])

    def test_override_without_a_line_index_is_refused(self):
        for ov in (True, {"reason": "because"}, {"line": "1", "reason": "because"}):
            out = run(evidence_override=ov)
            self.assertEqual(out["permissionDecision"], "deny")
        self.assertEqual(self.uploads, [])

    def test_override_with_line_uploads_and_records(self):
        out = run(evidence_override={"line": 1, "reason": "binary"})
        self.assertNotIn("permissionDecision", out)
        self.assertEqual(out["updatedInput"]["data"]["overrides"], [{"line": 1, "reason": "binary"}])
        self.assertEqual(len(self.uploads), 1)


if __name__ == "__main__":
    unittest.main()
