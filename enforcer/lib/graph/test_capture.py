import os as _o, sys as _s2; _s2.path.insert(0, _o.path.dirname(_o.path.abspath(__file__)))
import tmpclean  # noqa: F401
import importlib.util, json, os, subprocess, sys, tempfile, unittest, multiprocessing
HERE = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("graph_lib", os.path.join(HERE, "lib.py"))
lib = importlib.util.module_from_spec(_s)
_s.loader.exec_module(lib)


def _w(args):
    sid, i = args
    for k in range(5):
        lib.append_evidence(sid, {"kind": "note", "i": i, "pad": "x" * 20000})


class Capture(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp()
        lib.state_base = lambda: self.state

    def test_raw_cap_holds_at_50_MB(self):
        self.assertEqual(lib.RAW_RUN_CAP, 50 * 1024 * 1024)
        big = "y" * (5 * 1024 * 1024)
        for _ in range(14):
            lib.append_evidence("s", {"kind": "command", "cmd": "c", "exit": 0, "output": "o", "raw": big})
        size = os.path.getsize(lib.evidence_path("s"))
        self.assertLessEqual(size, lib.RAW_RUN_CAP)
        recs = lib.load_evidence("s")
        self.assertTrue(any("raw_truncated" in r for r in recs))
        self.assertEqual(len(recs), 14)

    def test_concurrent_appends_do_not_interleave(self):
        with multiprocessing.Pool(8) as p:
            p.map(_w, [("c", i) for i in range(8)])
        lines = open(lib.evidence_path("c")).read().splitlines()
        self.assertEqual(len(lines), 40)
        for l in lines:
            json.loads(l)

    def run_hook(self, cmd, out):
        inp = {"tool_name": "Bash", "session_id": "p", "tool_input": {"command": cmd},
               "tool_response": {"stdout": out, "stderr": ""}}
        lib.save_run("p", {"run_id": "r1", "node_id": "n"})
        subprocess.run([sys.executable, os.path.join(HERE, "capture_evidence.py")],
                       input=json.dumps(inp), text=True, capture_output=True,
                       env=dict(os.environ, **self.env()))
        return [x for x in lib.load_evidence("p") if x["kind"] == "artifact"]

    def env(self):
        return {"ENFORCER_STATE_DIR": self.state}

    def test_gh_pr_list_output_is_not_a_PR_artifact(self):
        self.assertEqual(self.run_hook("gh pr list", "https://github.com/a/b/pull/3"), [])

    def test_gh_pr_create_output_is(self):
        a = self.run_hook("gh pr create --fill", "https://github.com/a/b/pull/3")
        self.assertEqual(len(a), 1)

    def test_sweep_removes_old_sessions(self):
        lib.append_evidence("old", {"kind": "note"})
        lib.append_evidence("new", {"kind": "note"})
        os.utime(lib.evidence_path("old"), (1, 1))
        lib.sweep_sessions()
        self.assertFalse(os.path.exists(lib.evidence_path("old")))
        self.assertTrue(os.path.exists(lib.evidence_path("new")))


if __name__ == "__main__":
    unittest.main()
