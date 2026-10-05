import tmpclean  # noqa: F401
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


class PostToolUseFailure(unittest.TestCase):
    def test_failure_payload_with_error_is_captured_as_a_failed_command(self):
        """PostToolUseFailure payload with error is captured as a failed command"""
        tmp = tempfile.mkdtemp()
        env = {k: v for k, v in os.environ.items() if k not in ("GRAPH_ID", "ENFORCER_STATE_DIR")}
        env["CLAUDE_PLUGIN_DATA"] = os.path.join(tmp, "data")
        os.environ["CLAUDE_PLUGIN_DATA"] = env["CLAUDE_PLUGIN_DATA"]
        os.environ.pop("ENFORCER_STATE_DIR", None)
        key = "sfail"
        lib.save_run(key, {"graph_id": "g", "node_id": "n", "run_id": "r"})
        payload = {"session_id": key, "cwd": tmp, "hook_event_name": "PostToolUseFailure",
                   "tool_name": "Bash", "tool_input": {"command": "npm test"},
                   "error": "Exit code 3\nCannot find module", "is_interrupt": False}
        r = subprocess.run(["node", CLI, "hook", "post-tool-use-failure", "capture-evidence"],
                           input=json.dumps(payload), capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = lib.load_evidence(key)
        self.assertEqual(len(ev), 1)
        self.assertEqual((ev[0]["cmd"], ev[0]["exit"]), ("npm test", 3))
        self.assertIn("Cannot find module", ev[0]["output"])
        lib.clear_run(key)


class Attest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.environ["ENFORCER_STATE_DIR"] = self.tmp

    def test_attest_hooks_off_python3_when_python3_is_missing(self):
        orig = lib.shutil.which
        lib.shutil.which = lambda n: None
        try:
            lib.mark_attested("s")
            self.assertTrue(lib.client_for({"session_id": "s"}).endswith("hooks=off:python3"))
        finally:
            lib.shutil.which = orig

    def test_attest_hooks_off_until_a_capture_marker_exists(self):
        inp = {"session_id": "s-new"}
        self.assertTrue(lib.client_for(inp).endswith("hooks=off:no-capture-yet"))
        lib.mark_attested("s-new")
        self.assertTrue(lib.client_for(inp).endswith("hooks=on"))

    def test_attest_doctor_fails_without_python3(self):
        env = dict(os.environ, PATH="/nonexistent", ENFORCER_STATE_DIR=self.tmp)
        r = subprocess.run([__import__("shutil").which("node"), CLI, "doctor"], capture_output=True, text=True, env=env)
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertRegex(r.stdout, r"fail\s+python3 present")
        self.assertRegex(r.stdout, r"ok\s+node version")


if __name__ == "__main__":
    unittest.main()
