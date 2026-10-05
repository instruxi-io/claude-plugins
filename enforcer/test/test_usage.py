import tmpclean  # noqa: F401
"""graph_report carries what the run cost: model, tokens and tool calls read
from the reporting agent's own transcript since its claim."""
import json, os, subprocess, sys, tempfile, unittest

HOOKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "graph")
sys.path.insert(0, HOOKS)
import lib


def msg(mid, ts, usage, tools=(), model="claude-sonnet-5"):
    content = [{"type": "tool_use", "id": t, "name": "Bash", "input": {}} for t in tools] or [{"type": "text", "text": "x"}]
    return {"type": "assistant", "timestamp": ts, "message": {"id": mid, "model": model, "usage": usage, "content": content}}


U = lambda i, cc, cr, o: {"input_tokens": i, "cache_creation_input_tokens": cc, "cache_read_input_tokens": cr, "output_tokens": o}


class UsageTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.sid = "sess1"
        self.parent = os.path.join(self.dir, f"{self.sid}.jsonl")
        sub = os.path.join(self.dir, self.sid, "subagents")
        os.makedirs(sub)
        self.sub = os.path.join(sub, "agent-ag1.jsonl")
        with open(self.parent, "w") as f:
            f.write(json.dumps(msg("p1", "2026-10-01T10:00:00.000Z", U(1, 1, 1, 1))) + "\n")
        with open(self.sub, "w") as f:
            for rec in [
                msg("m0", "2026-10-01T09:00:00.000Z", U(500, 0, 0, 500)),            # before the claim
                msg("m1", "2026-10-01T10:00:01.000Z", U(2, 100, 200, 10), ["t1"]),
                msg("m1", "2026-10-01T10:00:01.100Z", U(2, 100, 200, 10), ["t2"]),   # same message, next block
                msg("m2", "2026-10-01T10:00:05.000Z", U(3, 0, 300, 20), ["t3"]),
            ]:
                f.write(json.dumps(rec) + "\n")

    def test_subagent_transcript_resolved_from_parent_path(self):
        inp = {"transcript_path": self.parent, "agent_id": "ag1", "session_id": self.sid}
        self.assertEqual(lib.actor_transcript(inp), self.sub)
        self.assertEqual(lib.actor_transcript({"transcript_path": self.parent, "session_id": self.sid}), self.parent)

    def test_counts_each_message_once_since_the_claim(self):
        u = lib.transcript_usage(self.sub, "2026-10-01T10:00:00.000Z")
        self.assertEqual(u["messages"], 2)
        self.assertEqual(u["tool_uses"], 3)
        self.assertEqual(u["input_tokens"], 5)
        self.assertEqual(u["cache_read_input_tokens"], 500)
        self.assertEqual(u["output_tokens_recorded"], 30)
        self.assertEqual(u["output_tokens_est"], 30)
        self.assertEqual(u["total_tokens"], 5 + 100 + 500 + 30)
        self.assertEqual(u["model"], "claude-sonnet-5")

    def test_output_estimate_beats_the_start_of_stream_count(self):
        # The transcript records usage when a message STARTS streaming.
        p = os.path.join(self.dir, "long.jsonl")
        with open(p, "w") as f:
            rec = msg("L1", "2026-10-01T11:00:00.000Z", U(1, 0, 0, 2))
            rec["message"]["content"] = [{"type": "text", "text": "x" * 8000}]
            f.write(json.dumps(rec) + "\n")
        u = lib.transcript_usage(p)
        self.assertEqual(u["output_tokens_recorded"], 2)
        self.assertEqual(u["output_tokens_est"], 2000)
        self.assertEqual(u["total_tokens"], 1 + 2000)

    def test_nothing_found_is_none_not_zeros(self):
        self.assertIsNone(lib.transcript_usage(self.sub, "2027-01-01T00:00:00.000Z"))
        self.assertIsNone(lib.transcript_usage(os.path.join(self.dir, "missing.jsonl")))

    def test_report_hook_stamps_usage_without_evidence_and_keeps_model_data(self):
        env = dict(os.environ, CLAUDE_PLUGIN_DATA=os.path.join(self.dir, "data"))
        env.pop("GRAPH_API_KEY", None)
        os.makedirs(os.path.join(env["CLAUDE_PLUGIN_DATA"], "runs"), exist_ok=True)
        inp = {"session_id": self.sid, "agent_id": "ag1", "transcript_path": self.parent,
               "tool_name": "mcp__plugin_enforcer_enforcer__graph_report",
               "tool_input": {"node_id": "n", "run_id": "r", "status": "succeeded", "report": "done", "data": {"keep": 1}}}
        key = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {HOOKS!r}); import lib; print(lib.actor_key({json.dumps(inp)}))"],
                             capture_output=True, text=True, env=env).stdout.strip()
        subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {HOOKS!r}); import lib; lib.save_run({key!r}, {{'claimed_at': '2026-10-01T10:00:00.000Z'}})"],
                       check=True, env=env)
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "attach_evidence.py")], input=json.dumps(inp),
                           capture_output=True, text=True, env=env, timeout=20)
        out = json.loads(r.stdout)["hookSpecificOutput"]["updatedInput"]
        self.assertEqual(out["data"]["keep"], 1)
        self.assertEqual(out["data"]["usage"]["total_tokens"], 635)
        self.assertEqual(out["report"], "done")

    def _hook(self, tool, tool_input, script="attach_evidence.py", with_run=True):
        env = dict(os.environ, CLAUDE_PLUGIN_DATA=os.path.join(self.dir, "data"))
        env.pop("GRAPH_API_KEY", None)
        os.makedirs(os.path.join(env["CLAUDE_PLUGIN_DATA"], "runs"), exist_ok=True)
        inp = {"session_id": self.sid, "agent_id": "ag1", "transcript_path": self.parent,
               "tool_name": tool, "tool_input": tool_input}
        key = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {HOOKS!r}); import lib; print(lib.actor_key({json.dumps(inp)}))"],
                             capture_output=True, text=True, env=env).stdout.strip()
        if with_run:
            subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {HOOKS!r}); import lib; lib.save_run({key!r}, {{'claimed_at': '2026-10-01T10:00:00.000Z'}})"],
                           check=True, env=env)
        r = subprocess.run([sys.executable, os.path.join(HOOKS, script)], input=json.dumps(inp),
                           capture_output=True, text=True, env=env, timeout=20)
        return json.loads(r.stdout)["hookSpecificOutput"]["updatedInput"] if r.stdout.strip() else None

    def test_report_carries_typed_usage_from_fixture_transcript(self):
        out = self._hook("mcp__plugin_enforcer_enforcer__graph_report",
                         {"node_id": "n", "run_id": "r", "status": "succeeded", "report": "done"})
        self.assertEqual(out["usage"], {"input_tokens": 5, "cache_creation_input_tokens": 100,
                                        "cache_read_input_tokens": 500, "output_tokens": 30,
                                        "model": "claude-sonnet-5", "source": "reported"})

    def test_heartbeat_carries_running_total_and_no_data_arg(self):
        out = self._hook("mcp__plugin_enforcer_enforcer__graph_heartbeat",
                         {"graph": "g", "node_id": "n", "run_id": "r"})
        self.assertEqual(out["usage"]["input_tokens"], 5)
        self.assertNotIn("data", out)

    def test_no_transcript_means_no_usage(self):
        env = dict(os.environ, CLAUDE_PLUGIN_DATA=os.path.join(self.dir, "data2"))
        os.makedirs(os.path.join(env["CLAUDE_PLUGIN_DATA"], "runs"), exist_ok=True)
        for tool in ("graph_report", "graph_heartbeat"):
            inp = {"session_id": "none", "transcript_path": os.path.join(self.dir, "missing.jsonl"),
                   "tool_name": "mcp__plugin_enforcer_enforcer__" + tool, "tool_input": {"run_id": "r"}}
            r = subprocess.run([sys.executable, os.path.join(HOOKS, "attach_evidence.py")], input=json.dumps(inp),
                               capture_output=True, text=True, env=env, timeout=20)
            self.assertNotIn("usage", r.stdout)
        self.assertIsNone(lib.typed_usage(None))

    def test_typed_usage_shape_for_the_heartbeat_body(self):
        u = lib.typed_usage(lib.transcript_usage(self.sub, "2026-10-01T10:00:00.000Z"))
        self.assertEqual(u["output_tokens"], 30)
        self.assertEqual(u["cache_read_input_tokens"], 500)


if __name__ == "__main__":
    unittest.main()
