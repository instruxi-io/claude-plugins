"""bin/graph-dispatch: tier -> model, contested resources, merge targets, the
stream summary, dry run and stop-file drain, against a fake API and a fake
claude binary. No network, no model."""
import datetime as dt
import importlib.machinery
import importlib.util
import io
import json
import os
import stat
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "..", "bin", "graph-dispatch")
_loader = importlib.machinery.SourceFileLoader("graph_dispatch", PATH)
_spec = importlib.util.spec_from_loader("graph_dispatch", _loader)
gd = importlib.util.module_from_spec(_spec)
_loader.exec_module(gd)


def node(key, type="task", status="active", **data):
    return {"id": "id-" + key, "key": key, "type": type, "status": status, "title": key,
            "work_state": "looking_for_work", "data": data}


class TierToModel(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(gd.model_for(node("a", tier="mechanical")), "sonnet")
        self.assertEqual(gd.model_for(node("a", tier="standard")), "sonnet")
        self.assertEqual(gd.model_for(node("a", tier="deep")), "opus")
        self.assertEqual(gd.model_for(node("a")), "sonnet")
        self.assertEqual(gd.model_for(node("a", tier="unheard-of")), "sonnet")

    def test_cap_applies_to_planner_tier(self):
        self.assertEqual(gd.model_for(node("a", tier="deep", tier_source="planner"), "sonnet"), "sonnet")
        self.assertEqual(gd.model_for(node("a", tier="deep", tier_source="rule"), "sonnet"), "sonnet")

    def test_user_tier_wins_over_cap(self):
        self.assertEqual(gd.model_for(node("a", tier="deep", tier_source="user"), "sonnet"), "opus")
        self.assertEqual(gd.model_for(node("a", tier="mechanical", tier_source="user"), "opus"), "sonnet")

    def test_explicit_model_wins(self):
        self.assertEqual(gd.model_for(node("a", tier="deep", tier_source="user", model="haiku"), "sonnet"), "haiku")
        n = node("a", tier="mechanical")
        n["model"] = "opus"  # the claim card's model (graph #224)
        self.assertEqual(gd.model_for(n), "opus")


class ContestedResources(unittest.TestCase):
    def test_never_two_on_one_value(self):
        a, b, c = node("a", resources=["r1"]), node("b", resources=["r1", "r2"]), node("c")
        chosen, skipped = gd.select([a, b, c], set(), 3)
        self.assertEqual([n["key"] for n in chosen], ["a", "c"])
        self.assertEqual(skipped[0][0]["key"], "b")
        self.assertIn("r1", skipped[0][1])

    def test_held_elsewhere_blocks(self):
        chosen, skipped = gd.select([node("a", resources="r1"), node("b")], {"r1"}, 3)
        self.assertEqual([n["key"] for n in chosen], ["b"])

    def test_slots_bound(self):
        chosen, skipped = gd.select([node(k) for k in "abcd"], set(), 2)
        self.assertEqual(len(chosen), 2)
        self.assertEqual([why for _, why in skipped], ["no free worker slot"] * 2)

    def test_busy_keys_skipped(self):
        chosen, _ = gd.select([node("a"), node("b")], set(), 3, {"a": object()})
        self.assertEqual([n["key"] for n in chosen], ["b"])

    def test_one_land_per_repo(self):
        m1 = node("m1", type="merge", repo="r", pr="1")
        m2 = node("m2", type="merge", repo="r", pr="2")
        m3 = node("m3", type="merge", repo="s", pr="3")
        chosen, _ = gd.select([m1, m2, m3], set(), 9)
        self.assertEqual([n["key"] for n in chosen], ["m1", "m3"])

    def test_held_elsewhere_counts_live_runs_not_lapsed(self):
        future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).isoformat()
        past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=5)).isoformat()
        live = dict(node("x", status="running", resources=["live"]), lease_expires_at=future)
        dead = dict(node("y", status="running", resources=["dead"]), lease_expires_at=past)
        d = gd.Dispatcher(None, args())
        self.assertEqual(d.held_elsewhere([live, dead]), {"live"})
        self.assertTrue(gd.lapsed(dead) and not gd.lapsed(live))


class MergeTarget(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(gd.merge_target(node("m", type="merge", pr="https://github.com/o/r/pull/7")), ("7", "o/r"))
        self.assertEqual(gd.merge_target(node("m", type="merge", pr="o/r#8")), ("8", "o/r"))
        self.assertEqual(gd.merge_target(node("m", type="merge", pr=9)), ("9", None))
        self.assertEqual(gd.merge_target(node("m", type="merge", branch="feat/x")), ("feat/x", None))
        self.assertIsNone(gd.merge_target(node("m", type="merge")))
        self.assertIsNone(gd.merge_target(node("t", pr="1")))


class StreamSummary(unittest.TestCase):
    def test_run_id_and_report(self):
        card = json.dumps({"state": "claimed", "run": {"run_id": "11111111-2222-3333-4444-555555555555"}})
        lines = [
            {"type": "system", "subtype": "init"},
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "t1", "name": "mcp__plugin_enforcer_enforcer__graph_next_work"}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": card}]}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}},
            {"type": "result", "subtype": "success", "permission_denials": [], "total_cost_usd": 0.1},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            f.write("\n".join(json.dumps(x) for x in lines) + "\nnot json\n")
        s = gd.summarize(f.name)
        os.unlink(f.name)
        self.assertEqual(s["run_id"], "11111111-2222-3333-4444-555555555555")
        self.assertFalse(s["reported"])
        self.assertEqual((s["turns"], s["result"], s["denials"]), (2, "success", 0))


class FakeAPI:
    def __init__(self, nodes):
        self._nodes = nodes
        self.calls = []

    def frontier(self, g):
        return [n for n in self._nodes if n["status"] == "active"]

    def nodes(self, g):
        return self._nodes

    def claim(self, g, n, runner):
        self.calls.append(("claim", n))
        return {"run_id": "run-" + n}

    def heartbeat(self, g, n, r):
        return {"state": "ok"}

    def complete(self, g, n, r, body):
        self.calls.append(("complete", n, body))
        for x in self._nodes:
            if x["id"] == n:
                x["status"] = "done" if body["status"] == "succeeded" else "failed"
        return {}


def args(**kw):
    a = gd.parse_args(["--graph", "g1", "--repo-root", "/nonexistent", "--plugin-dir", "/p"])
    for k, v in kw.items():
        setattr(a, k, v)
    return a


def fake_claude(dirpath, seconds):
    p = os.path.join(dirpath, "claude")
    with open(p, "w") as f:
        f.write("#!/bin/sh\nsleep %s\necho '{\"type\":\"assistant\",\"message\":{\"content\":[]}}'\n"
                "echo '{\"type\":\"result\",\"subtype\":\"success\",\"permission_denials\":[]}'\n" % seconds)
    os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
    return p


class DryRunAndDrain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_dry_run_launches_nothing(self):
        nodes = [node("a", tier="deep"), node("b", tier="mechanical"), node("c"),
                 node("m", type="merge", repo="r", pr="5")]
        api, out = FakeAPI(nodes), io.StringIO()
        a = args(dry_run=True, workers=2, state_dir=os.path.join(self.tmp, "s"), stop_file="/nope",
                 claude=os.path.join(self.tmp, "no-such-claude"))
        self.assertEqual(gd.Dispatcher(api, a, out).run(), 0)
        text = out.getvalue()
        self.assertIn("would launch a [task, tier deep] model=opus", text)
        self.assertIn("would launch b [task, tier mechanical] model=sonnet", text)
        self.assertIn("skip c: no free worker slot", text)
        self.assertIn("would land m [merge, no agent]", text)
        self.assertIn("worktree=", text)
        self.assertEqual(api.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "s")))

    def test_stop_file_drains(self):
        nodes = [node("a"), node("b")]
        api, out = FakeAPI(nodes), io.StringIO()
        state = os.path.join(self.tmp, "s")
        os.makedirs(os.path.join(state, "logs"))
        a = args(workers=1, state_dir=state, stop_file=os.path.join(state, "STOP"), interval=0.2,
                 claude=fake_claude(self.tmp, 1.5))
        d = gd.Dispatcher(api, a, out)
        # the fake worker never reports, so the node stays active; touch the
        # stop file once the first worker is running
        def stop_soon():
            while not d.workers:
                time.sleep(0.05)
            open(a.stop_file, "w").close()
        threading.Thread(target=stop_soon, daemon=True).start()
        self.assertEqual(d.run(), 0)
        text = out.getvalue()
        self.assertEqual(text.count("launch a "), 1)
        self.assertNotIn("launch b ", text)
        self.assertIn("stop file present: draining; 1 worker(s) running (a), no new launches", text)
        self.assertIn("done a exit=0", text)
        self.assertIn("drained", text)

    def test_denied_graph_tool_blocks_and_drains(self):
        nodes = [node("a"), node("b"), node("c")]
        api, out = FakeAPI(nodes), io.StringIO()
        state = os.path.join(self.tmp, "s")
        os.makedirs(os.path.join(state, "logs"))
        p = os.path.join(self.tmp, "claude-denied")
        with open(p, "w") as f:
            f.write("#!/bin/sh\necho '{\"type\":\"result\",\"subtype\":\"success\",\"permission_denials\":"
                    "[{\"tool_name\":\"mcp__plugin_enforcer_enforcer__graph_next_work\"}]}'\n")
        os.chmod(p, 0o755)
        a = args(workers=1, state_dir=state, stop_file=os.path.join(state, "STOP"), interval=0.2, claude=p)
        self.assertEqual(gd.Dispatcher(api, a, out).run(), 2)
        text = out.getvalue()
        self.assertIn("BLOCKED: mcp__plugin_enforcer_enforcer__graph_next_work denied", text)
        self.assertEqual(text.count("launch "), 1)

    def _run_denied(self, body, nodes):
        api, out = FakeAPI(nodes), io.StringIO()
        state = os.path.join(self.tmp, "s")
        os.makedirs(os.path.join(state, "logs"))
        p = os.path.join(self.tmp, "claude-denied")
        with open(p, "w") as f:
            f.write("#!/bin/sh\nprintf '%%s\\n' '%s'\necho \"$JEV_HOOKS_HEADLESS\" >> %s/headless\n"
                    % (body, self.tmp))
        os.chmod(p, 0o755)
        a = args(workers=1, state_dir=state, stop_file=os.path.join(state, "STOP"), interval=0.2,
                 claude=p, max_attempts=2)
        d = gd.Dispatcher(api, a, out)
        stopper = threading.Timer(2.5, lambda: open(a.stop_file, "w").close())
        stopper.start()
        try:
            d.run()
        finally:
            stopper.cancel()
        return d, out.getvalue()

    def test_denied_push_is_logged_not_relaunched(self):
        body = ('{"type":"result","subtype":"success","permission_denials":'
                '[{"tool_name":"Bash","tool_input":{"command":"git push -u origin graph/a"}}]}')
        d, text = self._run_denied(body, [node("a")])
        self.assertEqual(text.count("launch a "), 1, text)
        self.assertIn("DENIED a: Bash; not relaunching it this session. Worktree: ", text)
        self.assertIn(d.denied["a"], text)
        self.assertEqual(d.attempts["a"], 1)

    def test_denial_named_in_result_text_is_not_relaunched(self):
        body = '{"type":"result","subtype":"success","permission_denials":[],"result":"git push was denied by the classifier"}'
        d, text = self._run_denied(body, [node("a")])
        self.assertEqual(text.count("launch a "), 1, text)
        self.assertIn("DENIED a:", text)

    def test_ordinary_failure_is_still_relaunched(self):
        body = '{"type":"result","subtype":"error_max_turns","permission_denials":[],"result":"ran out of turns"}'
        d, text = self._run_denied(body, [node("a")])
        self.assertEqual(text.count("launch a "), 2, text)
        self.assertNotIn("DENIED", text)

    def test_worker_env_has_jev_hooks_headless_and_dispatcher_does_not(self):
        os.environ.pop("JEV_HOOKS_HEADLESS", None)
        body = '{"type":"result","subtype":"success","permission_denials":[]}'
        self._run_denied(body, [node("a")])
        with open(os.path.join(self.tmp, "headless")) as f:
            self.assertEqual(f.read().split()[0], "1")
        self.assertNotIn("JEV_HOOKS_HEADLESS", os.environ)

    def test_merge_landed_by_script(self):
        nodes = [node("m", type="merge", repo="r", pr="5")]
        api, out = FakeAPI(nodes), io.StringIO()
        state = os.path.join(self.tmp, "s")
        os.makedirs(os.path.join(state, "logs"))
        land = os.path.join(self.tmp, "land-pr.sh")
        with open(land, "w") as f:
            f.write("#!/bin/sh\necho \"land-pr: cannot read PR $1\" >&2\nexit 5\n")
        os.chmod(land, 0o755)
        old, gd.LAND_PR = gd.LAND_PR, land
        try:
            a = args(workers=1, state_dir=state, stop_file=os.path.join(state, "STOP"), interval=0.2,
                     max_attempts=1)
            self.assertEqual(gd.Dispatcher(api, a, out).run(), 0)
        finally:
            gd.LAND_PR = old
        done = [c for c in api.calls if c[0] == "complete"]
        self.assertEqual(len(done), 1)
        body = done[0][2]
        self.assertEqual(body["status"], "failed")
        ev = body["evidence"][0]
        self.assertEqual((ev["kind"], ev["exit"]), ("command", 5))
        self.assertIn("cannot read PR 5", ev["output"])


FAKE_WARM_CLAUDE = r"""#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
key = opt("--name").split(":", 1)[1]
resume, sid = opt("--resume"), opt("--session-id")
with open(os.environ["FAKE_CALLS"], "a") as f:
    f.write(json.dumps({"key": key, "argv": argv}) + "\n")
if resume and os.environ.get("FAKE_RESUME_FAILS"):
    print("No conversation found with session ID: " + resume)
    print(json.dumps({"type": "result", "subtype": "error_during_execution", "num_turns": 0,
                      "session_id": resume, "usage": {}, "permission_denials": []}))
    sys.exit(1)
s = resume or sid
print(json.dumps({"type": "system", "subtype": "init", "session_id": s, "mcp_servers": []}))
print(json.dumps({"type": "assistant", "message": {"content": [
    {"type": "tool_use", "id": "r1", "name": "mcp__plugin_enforcer_enforcer__graph_report"}]}}))
print(json.dumps({"type": "result", "subtype": "success", "num_turns": 3, "session_id": s,
                  "permission_denials": [], "total_cost_usd": 0.05 if resume else 0.01,
                  "usage": {"cache_read_input_tokens": 900 if resume else 100,
                            "cache_creation_input_tokens": 10 if resume else 500, "output_tokens": 7}}))
open(os.path.join(os.environ["FAKE_DONE"], key), "w").close()
"""


class DoneAPI(FakeAPI):
    """The fake worker marks its node done by touching <done>/<key>."""
    def __init__(self, nodes, done):
        super().__init__(nodes)
        self.done = done

    def frontier(self, g):
        return [n for n in self._nodes if n["status"] == "active"
                and not os.path.exists(os.path.join(self.done, n["key"]))]


class WarmWorkers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = os.path.join(self.tmp, "s")
        os.makedirs(os.path.join(self.state, "logs"))
        self.done = os.path.join(self.tmp, "done")
        os.makedirs(self.done)
        self.calls = os.path.join(self.tmp, "calls.jsonl")
        self.claude = os.path.join(self.tmp, "claude-warm")
        with open(self.claude, "w") as f:
            f.write(FAKE_WARM_CLAUDE)
        os.chmod(self.claude, 0o755)
        os.environ["FAKE_CALLS"], os.environ["FAKE_DONE"] = self.calls, self.done
        os.environ.pop("FAKE_RESUME_FAILS", None)

    def tearDown(self):
        os.environ.pop("FAKE_RESUME_FAILS", None)

    def run_dispatch(self, nodes, **kw):
        out = io.StringIO()
        a = args(workers=1, state_dir=self.state, stop_file=os.path.join(self.state, "STOP"),
                 interval=0.05, claude=self.claude, **kw)
        rc = gd.Dispatcher(DoneAPI(nodes, self.done), a, out).run()
        with open(self.calls) as f:
            launches = [json.loads(l) for l in f]
        return rc, out.getvalue(), launches

    def test_next_node_in_repo_resumes_the_session(self):
        rc, text, launches = self.run_dispatch([node(k, repo="r") for k in "abc"])
        self.assertEqual(rc, 0)
        a0 = launches[0]["argv"]
        sid = a0[a0.index("--session-id") + 1]
        self.assertNotIn("--resume", a0)
        for l in launches[1:]:
            self.assertEqual(l["argv"][l["argv"].index("--resume") + 1], sid)
            self.assertIn("NEW NODE. Your previous node", l["argv"][l["argv"].index("-p") + 1])
        self.assertIn("launch a pid=", text)
        self.assertIn("mode=cold session=" + sid, text)
        self.assertEqual(text.count("mode=resume session=" + sid), 2)
        self.assertIn("cold cache_read=100 cache_creation=500 output=7", text)
        self.assertIn("resumed cache_read=900 cache_creation=10 output=7", text)
        self.assertIn("cost=0.04 session=", text)  # 0.05 session total - 0.01 before

    def test_session_life_cap_retires(self):
        rc, text, launches = self.run_dispatch([node(k, repo="r") for k in "abc"], warm_max_nodes=2)
        modes = ["resume" if "--resume" in l["argv"] else "cold" for l in launches]
        self.assertEqual(modes, ["cold", "resume", "cold"])
        self.assertIn("retire session", text)
        self.assertIn("2 node(s), cap 2", text)

    def test_session_usable_caps(self):
        s = gd.Session("sid", "r", "sonnet", born=1000.0)
        self.assertEqual(gd.session_usable(s, 5, 7200, now=1001.0), (True, ""))
        s.nodes = 5
        self.assertFalse(gd.session_usable(s, 5, 7200, now=1001.0)[0])
        s.nodes = 1
        ok, why = gd.session_usable(s, 5, 7200, now=1000.0 + 7200)
        self.assertFalse(ok)
        self.assertIn("120m old", why)

    def test_failed_resume_falls_back_to_cold(self):
        os.environ["FAKE_RESUME_FAILS"] = "1"
        # max_attempts=1: the fallback must not spend the node's one attempt
        rc, text, launches = self.run_dispatch([node(k, repo="r") for k in "ab"], max_attempts=1)
        self.assertEqual(rc, 0)
        modes = [(l["key"], "resume" if "--resume" in l["argv"] else "cold") for l in launches]
        self.assertEqual(modes, [("a", "cold"), ("b", "resume"), ("b", "cold")])
        self.assertIn("resume failed for b (session ", text)
        self.assertIn("No conversation found with session ID", text)
        self.assertIn("falling back to a cold start", text)
        self.assertTrue(os.path.exists(os.path.join(self.done, "b")))

    def test_affinity_prefers_warm_repo(self):
        cands = [node("x1", repo="x"), node("y1", repo="y"), node("y2", repo="y"), node("z")]
        m = lambda n: "sonnet"
        self.assertEqual([n["key"] for n in gd.affinity_order(cands, {("y", "sonnet"): 1}, m)],
                         ["y1", "x1", "y2", "z"])
        self.assertEqual([n["key"] for n in gd.affinity_order(cands, {("y", "opus"): 1}, m)],
                         ["x1", "y1", "y2", "z"])
        self.assertEqual([n["key"] for n in gd.affinity_order(cands, {}, m)], ["x1", "y1", "y2", "z"])

    def test_one_plugin_dir_each_and_max_turns(self):
        a = args(plugin_dir=[gd.PLUGIN_DIR, "/p", "/p/", "/q"])
        cmd = gd.claude_cmd("hi", "sonnet", a, "k", session="s1", max_turns=40)
        dirs = [cmd[i + 1] for i, c in enumerate(cmd) if c == "--plugin-dir"]
        self.assertEqual(len(dirs), 3)
        self.assertEqual(len({os.path.realpath(d) for d in dirs}), 3)
        self.assertEqual(cmd[cmd.index("--max-turns") + 1], "40")
        self.assertEqual(cmd[cmd.index("--session-id") + 1], "s1")
        self.assertNotIn("--max-turns", gd.claude_cmd("hi", "sonnet", a, "k"))
        self.assertEqual(gd.node_max_turns(node("n", max_turns="60")), 60)
        self.assertIsNone(gd.node_max_turns(node("n")))


class SalvageDenied(unittest.TestCase):
    """salvage() against a real local git repo + bare origin, a fake gh, land-pr and claude."""
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = os.path.join(self.tmp, "s")
        os.makedirs(os.path.join(self.state, "logs"))
        origin, self.wt = os.path.join(self.tmp, "origin.git"), os.path.join(self.tmp, "wt")
        self.git(self.tmp, "init", "-q", "--bare", "-b", "main", origin)
        self.git(self.tmp, "clone", "-q", origin, self.wt)
        self.git(self.wt, "config", "user.email", "t@t")
        self.git(self.wt, "config", "user.name", "t")
        self.git(self.wt, "commit", "-q", "--allow-empty", "-m", "base")
        self.git(self.wt, "push", "-q", "origin", "HEAD:main")
        self.git(self.wt, "fetch", "-q")
        self.git(self.wt, "remote", "set-head", "origin", "main")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        self.log = os.path.join(self.tmp, "calls.log")
        self.script("gh", '#!/bin/sh\necho "gh $*" >> %s\n[ -n "$FAKE_GH_FAIL" ] && exit 1\n'
                    'echo https://github.com/o/r/pull/7\n' % self.log)
        self.land = self.script("land-pr.sh", '#!/bin/sh\necho "land $*" >> %s\necho landed-output\n'
                                'exit ${FAKE_LAND_EXIT:-0}\n' % self.log)
        self.claude = self.script("claude", '#!/bin/sh\necho "claude $*" >> %s\n' % self.log)
        self.oldpath, self.oldland = os.environ["PATH"], gd.LAND_PR
        os.environ["PATH"] = self.bin + ":" + self.oldpath
        gd.LAND_PR = self.land
        for k in ("FAKE_GH_FAIL", "FAKE_LAND_EXIT"):
            os.environ.pop(k, None)

    def tearDown(self):
        os.environ["PATH"], gd.LAND_PR = self.oldpath, self.oldland
        for k in ("FAKE_GH_FAIL", "FAKE_LAND_EXIT"):
            os.environ.pop(k, None)

    def git(self, cwd, *a):
        import subprocess
        subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)

    def script(self, name, body):
        p = os.path.join(self.bin, name)
        with open(p, "w") as f:
            f.write(body)
        os.chmod(p, 0o755)
        return p

    def calls(self):
        return open(self.log).read() if os.path.exists(self.log) else ""

    def setup_branch(self, name="graph/a", commit=True):
        self.git(self.wt, "checkout", "-q", "-b", name)
        if commit:
            self.git(self.wt, "commit", "-q", "--allow-empty", "-m", "work")

    def run_salvage(self, key="a", denied_cmd="git push -u origin graph/a", tools=("Bash",), text="final report", d=None):
        out = io.StringIO()
        d = d or gd.Dispatcher(FakeAPI([]), args(state_dir=self.state, claude=self.claude), out)
        w = gd.Worker(node(key), os.path.join(self.tmp, "w.log"))
        w.path, w.model, w.max_turns = self.wt, "sonnet", 10
        w.session = gd.Session("sess-1", "r", "sonnet")
        s = {"denied_tools": list(tools), "result_text": text,
             "denied_inputs": [{"tool_name": t, "tool_input": {"command": denied_cmd}} for t in tools]}
        ok = d.salvage(w, s)
        time.sleep(0.3)
        return d, ok, out.getvalue()

    def test_happy_path_pushes_opens_pr_lands_and_resumes(self):
        self.setup_branch()
        d, ok, text = self.run_salvage()
        self.assertTrue(ok, text)
        c = self.calls()
        self.assertIn("gh pr create --head graph/a", c)
        self.assertIn("final report", c)
        self.assertIn("land 7 --timeout", c)
        self.assertIn("--resume sess-1", c)
        self.assertIn("PR #7", c)
        self.assertIn("a", d.workers)
        self.assertNotIn("SALVAGE-SKIPPED", text)
        import subprocess
        r = subprocess.run(["git", "ls-remote", "--heads", "origin", "graph/a"], cwd=self.wt, capture_output=True, text=True)
        self.assertIn("refs/heads/graph/a", r.stdout)

    def assertSkipped(self, why, ok, text):
        self.assertFalse(ok)
        self.assertIn("SALVAGE-SKIPPED a: " + why, text)
        c = self.calls()
        self.assertNotIn("--resume", c)

    def test_skip_dirty_worktree(self):
        self.setup_branch()
        open(os.path.join(self.wt, "x"), "w").write("x")
        d, ok, text = self.run_salvage()
        self.assertSkipped("worktree is dirty", ok, text)
        self.assertNotIn("gh pr", self.calls())

    def test_skip_no_commits(self):
        self.setup_branch(commit=False)
        d, ok, text = self.run_salvage()
        self.assertSkipped("branch has no commits", ok, text)
        self.assertNotIn("gh pr", self.calls())

    def test_skip_non_graph_branch(self):
        self.setup_branch("feature/x")
        d, ok, text = self.run_salvage()
        self.assertSkipped("branch is feature/x", ok, text)

    def test_skip_land_failure(self):
        self.setup_branch()
        os.environ["FAKE_LAND_EXIT"] = "2"
        d, ok, text = self.run_salvage()
        self.assertSkipped("PR #7: land-pr exited 2", ok, text)

    def test_skip_other_tool_denial(self):
        self.setup_branch()
        d, ok, text = self.run_salvage(tools=("Bash", "Write"))
        self.assertSkipped("not a push or PR denial", ok, text)
        d, ok, text = self.run_salvage(denied_cmd="rm -rf /")
        self.assertIn("not a push or PR denial", text)
        self.assertEqual(self.calls(), "")

    def test_pr_denial_is_salvaged(self):
        self.setup_branch()
        d, ok, text = self.run_salvage(denied_cmd="gh pr create --title x")
        self.assertTrue(ok, text)

    def test_one_attempt_per_node(self):
        self.setup_branch()
        os.environ["FAKE_LAND_EXIT"] = "3"
        d, ok, text = self.run_salvage()
        self.assertFalse(ok)
        os.environ["FAKE_LAND_EXIT"] = "0"
        d, ok, text = self.run_salvage(d=d)
        self.assertIn("already salvaged once", d.out.getvalue())
        self.assertNotIn("--resume", self.calls())


if __name__ == "__main__":
    unittest.main()
