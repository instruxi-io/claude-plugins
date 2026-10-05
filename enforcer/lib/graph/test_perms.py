import importlib.util, os, stat, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("graph_lib", os.path.join(HERE, "lib.py"))
lib = importlib.util.module_from_spec(_s)
_s.loader.exec_module(lib)


def mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


class Perms(unittest.TestCase):
    def test_evidence_dir_is_0700_and_files_0600(self):
        with tempfile.TemporaryDirectory() as home:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
            os.environ["ENFORCER_STATE_DIR"] = os.path.join(home, "state")
            os.umask(0o022)
            lib.append_evidence("s1", {"kind": "note"})
            lib.save_run("s1", {"a": 1})
            ev = lib.evidence_dir()
            f = lib.evidence_path("s1")
            print("evidence dir is 0700 and files 0600:", oct(mode(ev)), oct(mode(f)))
            self.assertEqual(mode(ev), 0o700)
            self.assertEqual(mode(f), 0o600)
            self.assertEqual(mode(lib.data_dir()), 0o700)
            self.assertEqual(mode(lib.run_path("s1")), 0o600)

    def test_tighten_existing(self):
        with tempfile.TemporaryDirectory() as home:
            os.environ["ENFORCER_STATE_DIR"] = os.path.join(home, "state")
            d = os.path.join(home, "state", "evidence")
            os.makedirs(d, mode=0o775)
            os.chmod(d, 0o775)
            f = os.path.join(d, "x.jsonl")
            open(f, "w").close(); os.chmod(f, 0o644)
            lib.tighten_state()
            self.assertEqual(mode(d), 0o700)
            self.assertEqual(mode(f), 0o600)


if __name__ == "__main__":
    unittest.main()
