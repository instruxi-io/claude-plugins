import tmpclean  # noqa: F401
import importlib.util, os, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("graph_lib", os.path.join(HERE, "lib.py"))
lib = importlib.util.module_from_spec(_s)
_s.loader.exec_module(lib)
_c = importlib.util.spec_from_file_location("graph_capture", os.path.join(HERE, "capture_evidence.py"))


class Redact(unittest.TestCase):
    def check(self, text, secret, kind):
        out, n = lib.redact(text)
        self.assertNotIn(secret, out)
        self.assertIn("[redacted:%s]" % kind, out)
        self.assertGreaterEqual(n, 1)

    def test_bearer(self):
        self.check("curl -H 'Authorization: Bearer abcdef123456SECRET'", "abcdef123456SECRET", "bearer")

    def test_basic(self):
        self.check("Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA", "basic")

    def test_jwt(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM"
        self.check("token " + jwt, jwt, "jwt")

    def test_env_var(self):
        out, _ = lib.redact("PATH=/bin\nFOO_TOKEN=abc\nHOME=/h")
        self.assertEqual(out, "PATH=/bin\nFOO_TOKEN=[redacted:env]\nHOME=/h")

    def test_env_password_quoted(self):
        self.check('DB_PASSWORD="hunter two"', "hunter", "env")

    def test_pem(self):
        pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef\n-----END RSA PRIVATE KEY-----"
        self.check("x\n" + pem + "\ny", "MIIEabc", "pem")

    def test_aws(self):
        self.check("id AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE", "aws")

    def test_github(self):
        for t in ("ghp_" + "a" * 36, "gho_" + "b" * 36, "github_pat_" + "c" * 30):
            self.check("t=" + t, t, "github")

    def test_slack(self):
        self.check("xoxb-123456789012-abcdefghij", "abcdefghij", "slack")

    def test_x_api_key(self):
        self.check("curl -H 'X-API-Key: s3cr3tvalue' http://x", "s3cr3tvalue", "apikey")

    def test_clean_text_untouched(self):
        self.assertEqual(lib.redact("ls -la\nok"), ("ls -la\nok", 0))

    def test_capture_record_counts_redactions_and_raw_is_clean(self):
        import sys
        sys.modules['lib'] = lib   # capture_evidence does `import lib`; the repo's lib/ package would shadow it
        cc = importlib.util.module_from_spec(_c)
        _c.loader.exec_module(cc)
        big = "FOO_TOKEN=abc\n" + "x" * 5000
        rec = cc.bash_record({"command": "env -H 'X-API-Key: zzzzzzzz'"}, {"stdout": big})
        self.assertEqual(rec["redactions"], 2)
        self.assertNotIn("abc\n", rec["raw"].replace("[redacted:env]", ""))
        self.assertNotIn("zzzzzzzz", rec["cmd"])


if __name__ == "__main__":
    unittest.main()
