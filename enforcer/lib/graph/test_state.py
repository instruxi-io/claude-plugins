import os as _o, sys as _s2; _s2.path.insert(0, _o.path.dirname(_o.path.abspath(__file__)))
import tmpclean  # noqa: F401
"""Legacy session state migrates even when CLAUDE_PLUGIN_DATA is set (Claude Code always sets it)."""
import importlib.util, json, os, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("graph_lib_state", os.path.join(HERE, "lib.py"))
lib = importlib.util.module_from_spec(_s)
_s.loader.exec_module(lib)

ENV = ("HOME", "CLAUDE_PLUGIN_DATA", "CLAUDE_CONFIG_DIR", "ENFORCER_STATE_DIR", "ENFORCER_CONFIG_HOME")


class Legacy(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ENV}
        self.root = tempfile.mkdtemp()
        os.environ["HOME"] = os.path.join(self.root, "home")
        os.makedirs(os.environ["HOME"])
        for k in ENV[1:]:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def seed(self, legacy):
        os.makedirs(os.path.join(legacy, "runs"))
        with open(os.path.join(legacy, "runs", "s1.json"), "w") as f:
            json.dump({"run_id": "r1"}, f)

    def test_legacy_runs_migrate_when_CLAUDE_PLUGIN_DATA_is_set(self):
        self.seed(os.path.join(os.environ["HOME"], "." + "claude", "enforcer-graph"))
        data = os.path.join(self.root, "plugin-data")
        os.environ["CLAUDE_PLUGIN_DATA"] = data
        self.assertEqual(lib.state_base(), data)
        with open(os.path.join(data, "runs", "s1.json")) as f:
            self.assertEqual(json.load(f)["run_id"], "r1")

    def test_legacy_dir_honours_CLAUDE_CONFIG_DIR(self):
        cfg = os.path.join(self.root, "cc")
        self.seed(os.path.join(cfg, "enforcer-graph"))
        os.environ["CLAUDE_CONFIG_DIR"] = cfg
        data = os.path.join(self.root, "plugin-data")
        os.environ["CLAUDE_PLUGIN_DATA"] = data
        lib.state_base()
        self.assertTrue(os.path.exists(os.path.join(data, "runs", "s1.json")))


if __name__ == "__main__":
    unittest.main()
