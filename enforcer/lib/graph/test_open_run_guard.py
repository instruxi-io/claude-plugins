import json, os, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import tmpclean  # noqa: F401
ROOT = os.path.dirname(os.path.dirname(HERE))
CLI = os.path.join(ROOT, "bin", "enforcer")
sys.path.insert(0, HERE)
import importlib.util
_spec = importlib.util.spec_from_file_location('graph_lib', os.path.join(HERE, 'lib.py'))
lib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lib)


def run_event(name, payload, data):
    env = {k: v for k, v in os.environ.items() if k not in ("GRAPH_ID", "ENFORCER_STATE_DIR")}
    env["CLAUDE_PLUGIN_DATA"] = data
    r = subprocess.run(["node", CLI, "event", name], input=json.dumps(payload), capture_output=True, text=True, env=env)
    return r.stdout.strip()


class Guard(unittest.TestCase):
    def setUp(self):
        self.data = tempfile.mkdtemp()
        os.environ["CLAUDE_PLUGIN_DATA"] = self.data
        os.environ.pop("ENFORCER_STATE_DIR", None)
        self.cwd = tempfile.mkdtemp()

    def hold(self, ev):
        lib.save_run(lib.actor_key(ev), {"graph_id": "g", "node_id": "n", "key": "k", "run_id": "run-1"})

    def test_quoting_graph_report_does_not_pass(self):
        ev = {"session_id": "s1", "cwd": self.cwd, "last_assistant_message": "I should call graph_report and reported this run"}
        self.hold(ev)
        self.assertIn('"block"', run_event("stop", ev, self.data))

    def test_still_running_marker_passes(self):
        ev = {"session_id": "s1", "cwd": self.cwd, "last_assistant_message": "Paused.\nstill running: run-1"}
        self.hold(ev)
        self.assertEqual(run_event("stop", ev, self.data), "")

    def test_subagent_stop_with_an_open_run_blocks(self):
        ev = {"session_id": "s1", "agent_id": "ag-1", "cwd": self.cwd, "last_assistant_message": "done"}
        self.hold(ev)
        self.assertIn('"block"', run_event("subagent-stop", ev, self.data))

    def test_hooks_json(self):
        h = json.load(open(os.path.join(ROOT, "hooks", "hooks.json")))["hooks"]
        self.assertIn("clear", h["SessionStart"][0]["matcher"])
        self.assertIn("SubagentStop", h)


if __name__ == "__main__":
    unittest.main()
