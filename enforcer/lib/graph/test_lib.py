import os as _o, sys as _s2; _s2.path.insert(0, _o.path.dirname(_o.path.abspath(__file__)))
import tmpclean  # noqa: F401
"""The Python side of the OAuth refresh takes the same mkdir lock as Node."""
import importlib.util, json, os, tempfile, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("graph_lib_refresh", os.path.join(HERE, "lib.py"))
lib = importlib.util.module_from_spec(_s)
_s.loader.exec_module(lib)


class Refresh(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ("ENFORCER_HOME", "ENFORCER_BASE_URL", "ENFORCER_API_KEY")}
        self.home = tempfile.mkdtemp()
        os.environ["ENFORCER_HOME"] = self.home
        os.environ.pop("ENFORCER_BASE_URL", None)
        os.environ.pop("ENFORCER_API_KEY", None)

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def seed(self, endpoint="https://api.instruxi.dev/oauth/token", expires="2000-01-01T00:00:00.000Z"):
        doc = {"enforcer": {"oauth": {"access_token": "old", "refresh_token": "r1", "client_id": "c",
                                      "token_endpoint": endpoint, "expires_at": expires}}}
        lib._save_credentials(doc)
        return doc

    def test_refresh_rereads_after_lock(self):
        doc = self.seed()
        # another process rotated the pair while we waited for the lock
        lib._save_credentials({"enforcer": {"oauth": {"access_token": "rotated", "refresh_token": "r2",
                               "client_id": "c", "token_endpoint": "https://api.instruxi.dev/t",
                               "expires_at": "2999-01-01T00:00:00.000Z"}}})
        with mock.patch("urllib.request.urlopen") as u:
            self.assertEqual(lib._refresh(doc), "rotated")
            u.assert_not_called()

    def test_refresh_uses_shared_mkdir_lock_and_releases(self):
        doc = self.seed()
        seen = {}

        def fake(req, timeout=None):
            seen["locked"] = os.path.isdir(os.path.join(self.home, ".refresh.lock"))
            m = mock.MagicMock()
            m.__enter__.return_value.read.return_value = json.dumps(
                {"access_token": "new", "refresh_token": "r2", "expires_in": 900}).encode()
            return m
        with mock.patch("urllib.request.urlopen", fake):
            self.assertEqual(lib._refresh(doc), "new")
        self.assertTrue(seen["locked"])
        self.assertFalse(os.path.exists(os.path.join(self.home, ".refresh.lock")))
        self.assertEqual(lib.read_credentials()["enforcer"]["oauth"]["refresh_token"], "r2")
        self.assertEqual(os.stat(self.home).st_mode & 0o777, 0o700)

    def test_refresh_held_lock_times_out_with_stale_token(self):
        doc = self.seed()
        os.mkdir(os.path.join(self.home, ".refresh.lock"))
        with mock.patch.object(lib, "REFRESH_LOCK_TIMEOUT_S", 0.2), mock.patch("urllib.request.urlopen") as u:
            self.assertEqual(lib._refresh(doc), "old")
            u.assert_not_called()

    def test_refresh_refuses_http_and_foreign_origin(self):
        for ep in ("http://api.instruxi.dev/t", "https://evil.example/t"):
            doc = self.seed(ep)
            with mock.patch("urllib.request.urlopen") as u:
                self.assertIsNone(lib._refresh(doc))
                u.assert_not_called()


if __name__ == "__main__":
    unittest.main()
