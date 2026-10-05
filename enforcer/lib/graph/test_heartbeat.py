import importlib.util, os, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def _load(name, saved=sys.modules.get("lib")):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + ".py"))
    m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m
    spec.loader.exec_module(m)
    return m


# heartbeat.py does `import lib`; when run as lib/graph/test_heartbeat.py the
# enforcer/lib directory is the `lib` package, so swap ours in only while loading.
_saved = sys.modules.pop("lib", None)
try:
    lib = _load("lib")
    heartbeat = _load("heartbeat")
finally:
    if _saved is not None:
        sys.modules["lib"] = _saved

os.environ["CLAUDE_PLUGIN_DATA"] = tempfile.mkdtemp()
os.environ.pop("ENFORCER_STATE_DIR", None)
T0 = 1_000_000.0
RUN = {"graph_id": "g", "node_id": "n", "run_id": "r", "key": "k",
       "claimed_at": "1970-01-12T13:46:40.000Z", "lease_expires_at": "1970-01-12T13:51:40.000Z"}  # 300 s lease at T0


class Heartbeat(unittest.TestCase):
    def setUp(self):
        self.run = dict(RUN)
        lib.save_run("s", self.run)
        self.calls = []
        self.status = 200

    def post(self, cfg, m, p, b=None):
        self.calls.append(p)
        return self.status, {"data": {"state": "ok"}} if self.status == 200 else None

    def go(self, now, **kw):
        if not heartbeat.due(self.run, now, **kw):
            return None
        lib.find_config = lambda cwd: {"base_url": "x"}
        return heartbeat.beat({}, self.run, "s", now, self.post)

    def test_beats_after_lease_third_elapsed_on_the_2nd_call(self):
        """beats after lease/3 elapsed on the 2nd call"""
        self.assertEqual(heartbeat.lease_seconds(self.run), 300)
        self.assertIsNone(self.go(T0 + 30))            # 1st call: 30 s < 100 s
        self.assertEqual(self.go(T0 + 101), "ok")      # 2nd call: past lease/3
        self.assertEqual(len(self.calls), 1)

    def test_does_not_beat_twice_within_20_s(self):
        """does not beat twice within 20 s"""
        self.assertEqual(self.go(T0 + 101), "ok")
        self.assertIsNone(self.go(T0 + 110, long_call=True))
        self.assertEqual(len(self.calls), 1)

    def test_409_marks_reclaimed(self):
        """409 marks reclaimed"""
        self.status = 409
        self.assertEqual(self.go(T0 + 101), "reclaimed")
        self.assertTrue(lib.load_run("s")["reclaimed"])

    def test_404_marks_reclaimed_and_long_call_beats_early(self):
        self.status = 404
        self.assertEqual(self.go(T0 + 60, long_call=True), "reclaimed")
        self.assertTrue(lib.load_run("s")["reclaimed"])


if __name__ == "__main__":
    unittest.main()
