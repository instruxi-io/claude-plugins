import hashlib, json, os, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
import importlib.util
_spec = importlib.util.spec_from_file_location('graph_lib', os.path.join(HERE, 'lib.py'))
lib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lib)
ROOT = os.path.dirname(os.path.dirname(HERE))
CLI = os.path.join(ROOT, "bin", "enforcer")


class ActorKey(unittest.TestCase):
    def test_node_gate_and_python_actor_key_agree_on_a_subagent_event(self):
        tmp = tempfile.mkdtemp()
        data = os.path.join(tmp, "data")
        env = {k: v for k, v in os.environ.items() if k not in ("GRAPH_ID", "ENFORCER_STATE_DIR")}
        env["CLAUDE_PLUGIN_DATA"] = data
        os.environ["CLAUDE_PLUGIN_DATA"] = data
        os.environ.pop("ENFORCER_STATE_DIR", None)
        for ev in ({"agent_id": "ag-1", "session_id": "s1"}, {"session_id": "s1"}):
            key = lib.actor_key(ev)
            if "agent_id" in ev:
                self.assertEqual(key, hashlib.sha256(b"agent_id:ag-1").hexdigest()[:32])
            lib.save_run(key, {"graph_id": "g", "node_id": "n", "run_id": "r"})
            payload = dict(ev, cwd=tmp, tool_name="Bash", tool_input={"command": "echo hi"},
                           tool_response={"stdout": "hi", "exit_code": 0})
            r = subprocess.run(["node", CLI, "hook", "post-tool-use", "capture-evidence"], input=json.dumps(payload),
                               capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(lib.load_evidence(key), "node gate let capture run under python's key %s" % key)
            lib.clear_run(key)


if __name__ == "__main__":
    unittest.main()
