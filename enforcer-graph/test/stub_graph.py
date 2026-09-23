"""A stand-in for the enforcer-graph API, just enough for the hooks.

GET  /api/v1/graph/graphs/{g}/frontier        -> two runnable nodes
GET  /api/v1/graph/graphs/{g}/nodes           -> five nodes with mixed statuses
POST .../nodes/{n}/runs/{r}/heartbeat         -> state from the file $STUB_LOG.hb (default ok)
POST .../nodes/{n}/observations               -> records the body to STUB_LOG

Every request is appended to STUB_LOG as one JSON line. Wrong key -> 401.
Run: python3 stub_graph.py <port>
"""
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = os.environ.get("STUB_LOG", "/tmp/stub_graph.log")


def log(rec):
    with open(LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # An OAuth access token works as well as the key; stub-token-2 is what a
    # refresh at /token hands out, so a test can tell a refreshed call apart.
    BEARERS = ("Bearer stub-token", "Bearer stub-token-2")

    def _auth(self):
        # Cloudflare in front of the real API refuses urllib's default agent
        # (403, "error code: 1010"); refuse it here too so a regression shows.
        if (self.headers.get("User-Agent") or "").startswith("Python-urllib"):
            self._send(403, {"success": False, "error": "cloudflare_1010"})
            return False
        if self.headers.get("X-API-Key") != "stub-key" and self.headers.get("Authorization") not in self.BEARERS:
            self._send(401, {"success": False, "error": "unauthenticated"})
            return False
        return True

    def do_GET(self):
        log({"method": "GET", "path": self.path})
        if not self._auth():
            return
        if self.path.endswith("/frontier"):
            self._send(200, {"success": True, "data": [
                {"id": "n1", "key": "api-contract", "status": "pending", "type": "task"},
                {"id": "n2", "key": "legal-and-key", "status": "pending", "type": "human"}]})
        elif "/nodes" in self.path:
            self._send(200, {"success": True, "data": [
                {"id": "n1", "key": "api-contract", "status": "pending"},
                {"id": "n2", "key": "legal-and-key", "status": "pending"},
                {"id": "n3", "key": "schema-judgment", "status": "running"},
                {"id": "n4", "key": "old-node", "status": "done"},
                {"id": "n5", "key": "broken", "status": "failed"}], "meta": {"limit": 100, "offset": 0, "total": 5}})
        else:
            self._send(404, {"success": False, "error": "not_found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if self.path == "/token":  # the refresh_token grant, form-encoded like the real one
            if (self.headers.get("User-Agent") or "").startswith("Python-urllib"):
                return self._send(403, {"error": "cloudflare_1010"})
            from urllib.parse import parse_qs
            f = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()}
            log({"method": "POST", "path": "/token", "body": f})
            if f.get("grant_type") == "refresh_token" and f.get("refresh_token") == "rt-1" and f.get("client_id") == "mcp_test":
                return self._send(200, {"access_token": "stub-token-2", "refresh_token": "rt-2", "expires_in": 900,
                                        "scope": "enforcer:read enforcer:graph-runs.write"})
            return self._send(400, {"error": "invalid_grant"})
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        log({"method": "POST", "path": self.path, "body": body})
        if not self._auth():
            return
        if self.path.endswith("/heartbeat"):
            # Steered by a file next to the log, written by the test between calls.
            try:
                state = open(LOG + ".hb").read().strip() or "ok"
            except Exception:
                state = "ok"
            self._send(200, {"success": True, "data": {"state": state, "run_id": "r1", "attempt": 1,
                                                       "run_status": "running", "lease_expires_at": "2030-01-01T00:00:00Z"}})
        elif self.path.endswith("/observations"):
            self._send(201, {"success": True, "data": {"id": "o1", "body": body.get("body")}})
        else:
            self._send(404, {"success": False, "error": "not_found"})


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
