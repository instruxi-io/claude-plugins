"""Full outputs beyond the clip go to the USER's enforcer-files (adapter-files).

Run by test/run.sh (python3 -m unittest); pytest collects it too. Everything is
local: a stub enforcer-files on 127.0.0.1 with the real routes and shapes
(GET /storage/provider -> {provider, configured, upload_mode}; multipart POST
/storage/file/{provider}/upload -> {success, data: {file_id}}).
"""
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(os.path.dirname(HERE), "hooks")
sys.path.insert(0, HOOKS)
import lib  # noqa: E402

FILE_ID = "5E6F7A8B-9C0D-4E1F-8A2B-3C4D5E6F7A8B"
PREFIX = "/api/v1/files"


class FilesStub:
    """enforcer-files, just the two routes the hook uses."""

    def __init__(self, provider="storj"):
        self.provider = provider
        self.requests = []
        self.fail_upload = 0
        self.fail_provider = 0
        self.upload_delay = 0.0
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                stub.requests.append(("GET", self.path, self.headers, b""))
                if self.path == PREFIX + "/storage/provider":
                    if stub.fail_provider:
                        return self._send(stub.fail_provider, {"success": False})
                    return self._send(200, {"provider": stub.provider, "configured": True, "upload_mode": "proxy"})
                self._send(404, {"error": "not found"})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                stub.requests.append(("POST", self.path, self.headers, body))
                if stub.upload_delay:
                    time.sleep(stub.upload_delay)
                if self.path != "%s/storage/file/%s/upload" % (PREFIX, stub.provider):
                    return self._send(404, {"error": "Cannot POST " + self.path})
                if stub.fail_upload:
                    return self._send(stub.fail_upload, {"success": False, "message": "boom"})
                self._send(200, {"success": True, "message": "File uploaded successfully",
                                 "data": {"file_id": FILE_ID}})

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d%s" % (self.srv.server_address[1], PREFIX)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()

    def paths(self, method=None):
        return [p for m, p, _, _ in self.requests if method is None or m == method]


def long_output(n=200_000):
    head = "BEGIN go test -v ./...\n"
    tail = "\nPASS\nok  \tenforcer-graph\t6.8s"
    return head + ("--- PASS: TestCase (0.01s)\n" * (n // 27)) + tail


class Base(unittest.TestCase):
    def setUp(self):
        self.stub = FilesStub()
        self.work = tempfile.mkdtemp()
        self.data = os.path.join(self.work, "data")
        self.proj = os.path.join(self.work, "proj")
        os.makedirs(os.path.join(self.proj, ".claude"))
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ("GRAPH_FILES_BASE_URL", "GRAPH_BASE_URL", "GRAPH_ID", "ENFORCER_API_KEY")}
        self.env.update(CLAUDE_PLUGIN_DATA=self.data, GRAPH_API_KEY="user-key",
                        ENFORCER_HOME=os.path.join(self.work, "no-enforcer-home"))
        lib._provider_cache.clear()

    def tearDown(self):
        self.stub.close()
        shutil.rmtree(self.work, ignore_errors=True)

    def graph_json(self, files_base_url, base_url="http://127.0.0.1:9"):
        cfg = {"graph_id": "g1", "base_url": base_url, "api_key_env": "GRAPH_API_KEY"}
        if files_base_url is not None:
            cfg["files_base_url"] = files_base_url
        with open(os.path.join(self.proj, ".claude", "graph.json"), "w") as f:
            json.dump(cfg, f)

    def capture(self, sid, *outputs):
        """What capture_evidence.py records for Bash results with these outputs."""
        spec = importlib.util.spec_from_file_location("capture_evidence", os.path.join(HOOKS, "capture_evidence.py"))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        d = os.path.join(self.data, "evidence")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, sid + ".jsonl"), "w") as f:
            for i, out in enumerate(outputs):
                rec = m.bash_record({"command": "cmd-%d" % i}, {"stdout": out, "stderr": ""})
                f.write(json.dumps(rec) + "\n")

    def attach(self, sid="s1"):
        inp = {"session_id": sid, "cwd": self.proj, "tool_name": "mcp__enforcer-graph__graph_report",
               "tool_input": {"node_id": "n1", "run_id": "r1", "status": "succeeded", "report": "done"}}
        t0 = time.monotonic()
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "attach_evidence.py")], input=json.dumps(inp),
                           capture_output=True, text=True, env=self.env, timeout=60)
        self.elapsed = time.monotonic() - t0
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(r.stdout.strip(), "the hook said nothing: the report would go without evidence")
        return json.loads(r.stdout)["hookSpecificOutput"]["updatedInput"]["evidence"]


class CaptureTest(Base):
    def test_raw_is_kept_only_when_the_clip_lost_something(self):
        self.capture("c1", "short", long_output())
        with open(os.path.join(self.data, "evidence", "c1.jsonl")) as f:
            recs = [json.loads(l) for l in f]
        self.assertNotIn("raw", recs[0])
        self.assertEqual(recs[1]["raw"], long_output())
        self.assertEqual(len(recs[1]["output"]), lib.OUTPUT_CLIP)


class UploadTest(Base):
    def test_long_output_is_uploaded_under_the_users_credential_and_the_item_carries_the_file(self):
        self.graph_json(self.stub.url)
        raw = long_output()
        self.capture("s1", "short output", raw)
        ev = self.attach()
        by_cmd = {e["cmd"]: e for e in ev}
        short, big = by_cmd["cmd-0"], by_cmd["cmd-1"]
        self.assertEqual(big["file"], FILE_ID.lower())
        self.assertEqual(big["file_bytes"], len(raw.encode()))
        self.assertEqual(big["output"], lib.clip_output(raw), "the clip is still what is judged")
        self.assertNotIn("raw", big)
        self.assertNotIn("file", short)
        self.assertNotIn("raw", short)

        # The provider was READ, then the upload went to ITS route.
        self.assertEqual(self.stub.paths(), [PREFIX + "/storage/provider", PREFIX + "/storage/file/storj/upload"])
        for _, _, headers, _ in self.stub.requests:
            self.assertEqual(headers.get("X-API-Key"), "user-key", "not the user's credential")
        _, _, headers, body = self.stub.requests[1]
        self.assertTrue(headers["Content-Type"].startswith("multipart/form-data; boundary="))
        self.assertIn(raw.encode(), body, "the upload is not the whole output")
        self.assertIn(b'name="file_name"\r\n\r\ngraph-evidence/', body)

    def test_the_provider_is_whatever_the_service_says(self):
        self.stub.provider = "gcs"
        self.graph_json(self.stub.url)
        self.capture("s1", long_output())
        ev = self.attach()
        self.assertEqual(ev[0]["file"], FILE_ID.lower())
        self.assertIn(PREFIX + "/storage/file/gcs/upload", self.stub.paths("POST"))

    def test_the_provider_is_read_once_per_process(self):
        cfg = {"graph_id": "g1", "api_key": "user-key", "files_base_url": self.stub.url}
        items = [{"kind": "command", "cmd": "a", "output": "x", "raw": long_output()},
                 {"kind": "command", "cmd": "b", "output": "y", "raw": long_output(90_000)}]
        lib.attach_files(items, cfg)
        self.assertEqual([i.get("file") for i in items], [FILE_ID.lower()] * 2)
        self.assertEqual(self.stub.paths("GET"), [PREFIX + "/storage/provider"])
        self.assertEqual(len(self.stub.paths("POST")), 2)


class FailOpenTest(Base):
    def assert_unchanged(self, ev, raw):
        self.assertEqual(len(ev), 1)
        self.assertNotIn("file", ev[0])
        self.assertNotIn("file_bytes", ev[0])
        self.assertNotIn("raw", ev[0])
        self.assertEqual(ev[0]["output"], lib.clip_output(raw))

    def test_an_upload_failure_leaves_the_item_as_it_is_today(self):
        self.stub.fail_upload = 500
        self.graph_json(self.stub.url)
        raw = long_output()
        self.capture("s1", raw)
        self.assert_unchanged(self.attach(), raw)
        self.assertEqual(len(self.stub.paths("POST")), 1, "the upload was not attempted")

    def test_a_provider_failure_leaves_the_item_and_uploads_nothing(self):
        self.stub.fail_provider = 401
        self.graph_json(self.stub.url)
        raw = long_output()
        self.capture("s1", raw)
        self.assert_unchanged(self.attach(), raw)
        self.assertEqual(self.stub.paths("POST"), [])

    def test_a_refused_connection_leaves_the_item(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()  # nothing listens here now
        self.graph_json("http://127.0.0.1:%d%s" % (port, PREFIX))
        raw = long_output()
        self.capture("s1", raw)
        self.assert_unchanged(self.attach(), raw)

    def test_uploads_are_bounded_and_a_slow_one_is_abandoned(self):
        self.stub.upload_delay = 3.0
        cfg = {"graph_id": "g1", "api_key": "user-key", "files_base_url": self.stub.url}
        items = [{"kind": "command", "cmd": "a", "output": "x", "raw": long_output()}]
        old = lib.UPLOAD_BUDGET_S
        lib.UPLOAD_BUDGET_S = 0.5
        try:
            t0 = time.monotonic()
            lib.attach_files(items, cfg)
            took = time.monotonic() - t0
        finally:
            lib.UPLOAD_BUDGET_S = old
        self.assertLess(took, 2.0)
        self.assertEqual(items, [{"kind": "command", "cmd": "a", "output": "x"}])

    def test_an_unset_files_base_url_makes_no_network_call(self):
        # The graph's own base is the stub's origin, so a client that derived
        # a files URL from it instead of staying off would be seen here.
        origin = self.stub.url[: -len(PREFIX)]
        self.graph_json(None, base_url=origin)
        raw = long_output()
        self.capture("s1", raw)
        self.assert_unchanged(self.attach(), raw)
        self.assertEqual(self.stub.requests, [])

        # In process, with every socket refusing: not one connection attempted.
        attempts = []
        real = socket.socket.connect

        def refuse(sock, addr):
            attempts.append(addr)
            raise ConnectionRefusedError("sockets are refused in this test")
        socket.socket.connect = refuse
        try:
            items = [{"kind": "command", "cmd": "a", "output": "x", "raw": raw}]
            lib.attach_files(items, {"graph_id": "g1", "api_key": "user-key", "base_url": origin})
            lib.attach_files(items, None)
        finally:
            socket.socket.connect = real
        self.assertEqual(attempts, [])
        self.assertEqual(items, [{"kind": "command", "cmd": "a", "output": "x"}])


if __name__ == "__main__":
    unittest.main()
