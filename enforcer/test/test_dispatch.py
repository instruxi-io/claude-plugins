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
    a = gd.parse_args(["--graph", "g1", "--repo-root", "/nonexistent", "--plugin-dir", "/p", "--no-lease"])
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
        api, out = TriageAPI(nodes), io.StringIO()
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
        self.assertNotIn("TRIAGE", text)
        self.assertEqual(d.failures, {})

    def test_denial_named_in_result_text_is_not_relaunched(self):
        body = '{"type":"result","subtype":"success","permission_denials":[],"result":"git push was denied by the classifier"}'
        d, text = self._run_denied(body, [node("a")])
        self.assertEqual(text.count("launch a "), 1, text)
        self.assertIn("DENIED a:", text)

    # --- decision codes (the governor's records), not text
    @staticmethod
    def _rec(code, decision="deny", **kw):
        return gd.DECISION_PREFIX + json.dumps(dict({"decision": decision, "code": code, "rule": None, "tool": "Bash",
                                                    "summary": "s of " + code}, **kw))

    def _coded(self, code, result_text="ok", extra_denial=True):
        """A stream whose Bash tool_result carries the record; the final result
        text is neutral so only the record can decide."""
        ev = [{"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1",
                                                       "content": self._rec(code) + "\nsentence"}]}},
              {"type": "result", "subtype": "success", "result": result_text,
               "permission_denials": [{"tool_name": "Bash", "tool_input": {"command": "x"}}] if extra_denial else []}]
        return "\n".join(json.dumps(e) for e in ev)

    def test_decision_records_parse_from_stderr_line_and_stream(self):
        self.assertEqual(gd.decision_records("noise\n" + self._rec("force_push") + "\ntail")[0]["code"], "force_push")
        self.assertEqual(gd.decision_records(gd.DECISION_PREFIX + "{broken"), [])
        log = os.path.join(self.tmp, "s.jsonl")
        with open(log, "w") as f:
            f.write(self._rec("push_needs_approval_surface") + "\n" + self._coded("destructive_git") + "\n")
        codes = [r["code"] for r in gd.summarize(log)["decisions"]]
        self.assertEqual(codes, ["push_needs_approval_surface", "destructive_git"])

    def test_denial_class_per_code(self):
        def cls(*recs):
            return gd.denial_class({"decisions": list(recs)})[0]
        r = lambda c, d="deny": {"decision": d, "code": c}
        self.assertEqual(cls(r("push_needs_approval_surface")), "salvage")
        self.assertEqual(cls(r("destructive_delete")), "triage")
        self.assertEqual(cls(r("destructive_git")), "triage")
        self.assertEqual(cls(r("graph_run_not_open")), "remediation")
        self.assertEqual(cls(r("force_push")), "denied")
        self.assertEqual(cls(r("destructive_git"), r("push_needs_approval_surface")), "triage")
        self.assertIsNone(cls(r("graph_push_allowed", "allow")))
        self.assertIsNone(cls())

    def test_code_salvage_is_denied_and_salvage_attempted_without_text(self):
        d, text = self._run_denied(self._coded("push_needs_approval_surface"), [node("a")])
        self.assertEqual(text.count("launch a "), 1, text)
        self.assertIn("DENIED a: push_needs_approval_surface", text)
        self.assertIn("SALVAGE-SKIPPED a:", text)
        self.assertNotIn("not a push or PR denial", text)

    def test_code_destructive_is_never_salvaged_and_goes_to_triage(self):
        d, text = self._run_denied(self._coded("destructive_delete"), [node("a")])
        self.assertEqual(text.count("launch a "), 1, text)
        self.assertIn("TRIAGE-ON-CODE a: destructive_delete", text)
        self.assertNotIn("SALVAGE", text)
        self.assertNotIn("DENIED a", text)
        self.assertIn("TRIAGE a:", text)
        self.assertNotIn("a", d.denied)

    def test_code_run_not_open_is_remediation_with_the_code(self):
        d, text = self._run_denied(self._coded("graph_run_not_open"), [node("a")])
        self.assertEqual(text.count("launch a "), 2, text)
        self.assertIn("FAILED a (attempt 1 of 2 this session): governor denied (graph_run_not_open)", text)
        self.assertNotIn("DENIED", text)
        self.assertNotIn("SALVAGE", text)

    def test_other_code_is_denied_never_salvaged(self):
        d, text = self._run_denied(self._coded("force_push"), [node("a")])
        self.assertEqual(text.count("launch a "), 1, text)
        self.assertIn("DENIED a: force_push", text)
        self.assertNotIn("SALVAGE", text)

    def test_record_beats_text_match(self):
        # the result text says "push was denied", the record says destructive: the record wins
        d, text = self._run_denied(self._coded("destructive_git", result_text="git push was denied by the classifier"),
                                   [node("a")])
        self.assertIn("TRIAGE-ON-CODE a", text)
        self.assertNotIn("SALVAGE", text)

    def test_allow_record_is_no_denial_and_text_fallback_still_applies_without_record(self):
        # no record at all: the old text match (covered by test_denial_named_in_result_text_is_not_relaunched)
        self.assertIsNone(gd.denial_class({"decisions": []})[0])

    def test_ordinary_failure_is_still_relaunched(self):
        body = '{"type":"result","subtype":"error_max_turns","permission_denials":[],"result":"ran out of turns"}'
        d, text = self._run_denied(body, [node("a")])
        self.assertEqual(text.count("launch a "), 2, text)
        self.assertNotIn("DENIED", text)
        self.assertIn("(remediation after 1 failed attempt(s))", text)
        self.assertIn("without reporting: ran out of turns", text)
        self.assertIn("TRIAGE a: 2 failed attempt(s)", text)
        self.assertIn("TRIAGE-NONE a: triage", text)  # the fake triage did not report

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
        self.cbin = os.path.join(self.tmp, "claude-warm")
        with open(self.cbin, "w") as f:
            f.write(FAKE_WARM_CLAUDE)
        os.chmod(self.cbin, 0o755)
        os.environ["FAKE_CALLS"], os.environ["FAKE_DONE"] = self.calls, self.done
        os.environ.pop("FAKE_RESUME_FAILS", None)

    def tearDown(self):
        os.environ.pop("FAKE_RESUME_FAILS", None)

    def run_dispatch(self, nodes, **kw):
        out = io.StringIO()
        a = args(workers=1, state_dir=self.state, stop_file=os.path.join(self.state, "STOP"),
                 interval=0.05, claude=self.cbin, **kw)
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
        cmd = gd.launch_cmd("hi", "sonnet", a, "k", session="s1", max_turns=40)
        dirs = [cmd[i + 1] for i, c in enumerate(cmd) if c == "--plugin-dir"]
        self.assertEqual(len(dirs), 3)
        self.assertEqual(len({os.path.realpath(d) for d in dirs}), 3)
        self.assertEqual(cmd[cmd.index("--max-turns") + 1], "40")
        self.assertEqual(cmd[cmd.index("--session-id") + 1], "s1")
        self.assertNotIn("--max-turns", gd.launch_cmd("hi", "sonnet", a, "k"))
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
        self.land = self.script("land-pr.sh", '#!/bin/sh\necho "land $*" >> %s\nsleep ${FAKE_LAND_SLEEP:-0}\necho landed-output\n'
                                'exit ${FAKE_LAND_EXIT:-0}\n' % self.log)
        self.cbin = self.script("claude", '#!/bin/sh\necho "claude $*" >> %s\n' % self.log)
        self.oldpath, self.oldland = os.environ["PATH"], gd.LAND_PR
        os.environ["PATH"] = self.bin + ":" + self.oldpath
        gd.LAND_PR = self.land
        for k in ("FAKE_GH_FAIL", "FAKE_LAND_EXIT", "FAKE_LAND_SLEEP"):
            os.environ.pop(k, None)

    def tearDown(self):
        os.environ["PATH"], gd.LAND_PR = self.oldpath, self.oldland
        for k in ("FAKE_GH_FAIL", "FAKE_LAND_EXIT", "FAKE_LAND_SLEEP"):
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

    def run_salvage(self, key="a", denied_cmd="git push -u origin graph/a", tools=("Bash",), text="final report", d=None, skills=("deliver-via-github-pr",)):
        out = io.StringIO()
        d = d or gd.Dispatcher(FakeAPI([]), args(state_dir=self.state, claude=self.cbin), out)
        w = gd.Worker(node(key), os.path.join(self.tmp, "w.log"))
        w.path, w.model, w.max_turns = self.wt, "sonnet", 10
        w.session = gd.Session("sess-1", "r", "sonnet")
        s = {"denied_tools": list(tools), "result_text": text, "card_skills": list(skills),
             "denied_inputs": [{"tool_name": t, "tool_input": {"command": denied_cmd}} for t in tools]}
        ok = d.salvage(w, s)
        if ok:  # land-pr is a background child: reap until it exits and the session is resumed
            deadline = time.time() + 10
            while any(x.kind == "salvage" for x in d.workers.values()) and time.time() < deadline:
                d.reap()
                time.sleep(0.05)
            ok = key in d.workers
        time.sleep(0.3)
        return d, ok, out.getvalue()

    def test_happy_path_pushes_opens_pr_lands_and_resumes(self):
        self.setup_branch()
        d, ok, text = self.run_salvage()
        self.assertTrue(ok, text)
        c = self.calls()
        self.assertIn("gh pr create --base main --head graph/a", c)
        self.assertIn("final report", c)
        self.assertIn("land 7 --timeout", c)
        self.assertIn("--resume sess-1", c)
        self.assertIn("PR #7", c)
        self.assertIn("a", d.workers)
        self.assertNotIn("SALVAGE-SKIPPED", text)
        import subprocess
        r = subprocess.run(["git", "ls-remote", "--heads", "origin", "graph/a"], cwd=self.wt, capture_output=True, text=True)
        self.assertIn("refs/heads/graph/a", r.stdout)

    def test_salvage_honours_data_base(self):
        self.git(self.wt, "push", "-q", "origin", "HEAD:staging")
        self.git(self.wt, "fetch", "-q")
        self.setup_branch()
        d = gd.Dispatcher(FakeAPI([]), args(state_dir=self.state, claude=self.cbin), io.StringIO())
        n = node("a")
        n["data"] = dict(n.get("data") or {}, base="staging")
        w = gd.Worker(n, os.path.join(self.tmp, "w.log"))
        w.path, w.model, w.max_turns = self.wt, "sonnet", 10
        w.session = gd.Session("sess-1", "r", "sonnet")
        s = {"denied_tools": ["Bash"], "result_text": "r", "card_skills": ["deliver-via-github-pr"],
             "denied_inputs": [{"tool_name": "Bash", "tool_input": {"command": "git push -u origin graph/a"}}]}
        self.assertTrue(d.salvage(w, s))
        self.assertIn("gh pr create --base staging --head graph/a", self.calls())
        for x in list(d.workers.values()):
            if x.proc:
                x.proc.wait()

    def test_no_salvage_without_the_delivery_skill(self):
        self.setup_branch()
        d, ok, text = self.run_salvage(skills=())
        self.assertFalse(ok, text)
        self.assertIn("SALVAGE-SKIPPED a: the node's skills do not include deliver-via-github-pr", text)
        self.assertNotIn("gh pr create", self.calls())
        self.assertNotIn("land ", self.calls())

    def test_skills_of_reads_the_claim_card(self):
        card = '{"skills":[{"key":"close-books"},{"name":"deliver-via-github-pr"},"x"]}'
        self.assertEqual(gd.skills_of(card), ["close-books", "deliver-via-github-pr", "x"])
        self.assertEqual(gd.skills_of("not json"), [])

    def test_skills_of_reads_the_claimed_node(self):
        # graph_next_work wraps the card as {"state","graph_id","node":{...}}; the
        # graph-level skills merged onto the node were invisible here, so every
        # salvage on enforcer-plugin-stack-hardening was skipped (2026-10-04).
        wrapped = json.dumps({"state": "claimed", "graph_id": "g", "node": {"key": "k", "skills": [{"slug": "deliver-via-github-pr"}, "other"]}})
        self.assertEqual(gd.skills_of(wrapped), ["deliver-via-github-pr", "other"])

    def test_skills_of_prefers_the_slug_over_the_display_name(self):
        # The real graph_next_work card (enforcer-graph MCP, 2026-10-05): skills
        # at the top level, each with slug AND name. The salvage rule compares
        # slugs; returning the name ("Deliver via GitHub pull request") made
        # DELIVER_SKILL never match, so salvage stayed skipped after 0.27.1.
        card = json.dumps({"state": "claimed", "graph_id": "g", "node": {"key": "k", "type": "bug"},
                           "skills": [{"slug": "deliver-via-github-pr", "name": "Deliver via GitHub pull request",
                                       "version": 1, "body": "# Deliver via GitHub pull request\n..."}]})
        self.assertEqual(gd.skills_of(card), ["deliver-via-github-pr"])
        self.assertIn(gd.DELIVER_SKILL, gd.skills_of(card))

    def test_skills_of_reads_attached_skill_rows(self):
        # The real card body (POST /frontier/claim, enforcer-graph 0.27): each
        # entry is a skills.AttachedSkill row and the slug is nested under
        # "skill". Copied from GET /graphs/{id}/nodes/{id}/skills on plan
        # b50d452b, 2026-10-04 — the shape that made skills_of return [] and
        # every salvage skip although the skill was attached.
        card = json.dumps({"node_id": "e5395ade-303d-4be6-a8c8-e1de27c01e72", "key": "portal-vendor-bot", "skills": [
            {"node_id": "e5395ade-303d-4be6-a8c8-e1de27c01e72", "position": 0, "config": {},
             "created_at": "2026-10-04T21:12:01.094906Z",
             "skill": {"id": "674fd6aa-5c4e-424c-859a-31c2e8660cf2", "tenant_id": "7d548352-3941-44fb-a217-09c55d86b379",
                       "slug": "deliver-via-github-pr", "version": 1, "name": "Deliver via GitHub PR"}}]})
        self.assertEqual(gd.skills_of(card), ["deliver-via-github-pr"])
        wrapped = json.dumps({"state": "claimed", "node": json.loads(card)})
        self.assertEqual(gd.skills_of(wrapped), ["deliver-via-github-pr"])

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

    def test_salvage_is_asynchronous_and_other_nodes_launch(self):
        """While land-pr waits on CI, the same pass launches another ready node;
        the salvage holds node a (no double launch) but no worker slot."""
        self.setup_branch()
        os.environ["FAKE_LAND_SLEEP"] = "2"
        out = io.StringIO()
        api = FakeAPI([node("a"), node("b")])
        d = gd.Dispatcher(api, args(state_dir=self.state, claude=self.cbin, workers=1,
                                    stop_file=os.path.join(self.state, "STOP")), out)
        w = gd.Worker(node("a"), os.path.join(self.tmp, "w.log"))
        w.path, w.model, w.max_turns = self.wt, "sonnet", 10
        w.session = gd.Session("sess-1", "r", "sonnet")
        t0 = time.time()
        self.assertTrue(d.salvage(w, {"denied_tools": ["Bash"], "card_skills": ["deliver-via-github-pr"], "result_text": "final report",
                                      "denied_inputs": [{"tool_name": "Bash",
                                                         "tool_input": {"command": "git push -u origin graph/a"}}]}))
        self.assertLess(time.time() - t0, 1.5, "salvage must not wait for land-pr")
        self.assertEqual(d.workers["a"].kind, "salvage")
        nodes, chosen = d.tick()
        self.assertEqual([n["key"] for n in chosen], ["b"], out.getvalue())  # the slot is free; a is not double-launched
        self.assertEqual(d.workers["b"].kind, "agent")
        self.assertEqual(d.workers["a"].kind, "salvage")
        deadline = time.time() + 10
        while d.workers.get("a") is not None and d.workers["a"].kind == "salvage" and time.time() < deadline:
            d.reap()
            time.sleep(0.05)
        self.assertEqual(d.workers["a"].kind, "agent")
        self.assertIn("--resume sess-1", self.calls())
        self.assertIn("landing in the background", out.getvalue())
        for x in d.workers.values():
            x.proc.wait(timeout=10)

    def test_one_attempt_per_node(self):
        self.setup_branch()
        os.environ["FAKE_LAND_EXIT"] = "3"
        d, ok, text = self.run_salvage()
        self.assertFalse(ok)
        os.environ["FAKE_LAND_EXIT"] = "0"
        d, ok, text = self.run_salvage(d=d)
        self.assertIn("already salvaged once", d.out.getvalue())
        self.assertNotIn("--resume", self.calls())


FAKE_FAIL_CLAUDE = r"""#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
key, prompt = opt("--name").split(":", 1)[1], opt("-p")
resume, sid = opt("--resume"), opt("--session-id")
with open(os.environ["FAKE_CALLS"], "a") as f:
    f.write(json.dumps({"key": key, "argv": argv, "prompt": prompt, "model": opt("--model")}) + "\n")
s = resume or sid
def emit(o):
    print(json.dumps(o))
emit({"type": "system", "subtype": "init", "session_id": s, "mcp_servers": []})
emit({"type": "assistant", "message": {"content": [
    {"type": "tool_use", "id": "c1", "name": "mcp__plugin_enforcer_enforcer__graph_next_work", "input": {}}]}})
card = {"run_id": "00000000-0000-0000-0000-%012d" % (len(open(os.environ["FAKE_CALLS"]).readlines())),
        "last_rejection": {"reasons": ["criterion 2: no test output in the evidence"]}}
emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "c1",
                                               "content": json.dumps(card)}]}})
if prompt.startswith("TRIAGE"):
    tid = prompt.split('node: "', 1)[1].split('"', 1)[0]
    if os.environ.get("FAKE_TRIAGE_WRONG_NODE"):
        tid = "id-a"
    rep = {"graph": "g1", "node_id": tid, "run_id": card["run_id"], "status": "succeeded",
           "report": "1. MET", "data": {"triage": json.loads(os.environ["FAKE_TRIAGE"])}}
    ans = {"verification": {"state": "verified"}}
else:
    rep = {"graph": "g1", "node_id": "id-" + key, "run_id": card["run_id"], "status": "failed",
           "report": "1. NOT MET", "error": "ERR-%d: the suite is red" % (2 if resume else 1)}
    ans = {"verification": {"state": "rejected", "reason": "evidence shows 3 failing tests"}}
emit({"type": "assistant", "message": {"content": [
    {"type": "tool_use", "id": "r1", "name": "mcp__plugin_enforcer_enforcer__graph_report", "input": rep}]}})
emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "r1",
                                               "content": json.dumps(ans)}]}})
emit({"type": "result", "subtype": "success", "num_turns": 3, "session_id": s, "permission_denials": [],
      "result": "done", "usage": {}})
"""


class TriageAPI(FakeAPI):
    """Records the graph writes a triage decision makes. A created triage node
    joins the plan (so the frontier offers it, and the dispatcher must skip it);
    other created nodes are recorded only."""
    def __init__(self, nodes):
        super().__init__(nodes)
        self.writes = []

    def create_node(self, g, body):
        self.writes.append(("node", body))
        n = {"id": "id-" + body["key"], "key": body["key"], "type": body.get("type"), "status": "active",
             "title": body.get("title"), "work_state": "looking_for_work", "data": body.get("data") or {}}
        if (body.get("data") or {}).get("triage_of"):
            self._nodes.append(n)
        return n

    def create_edge(self, g, body):
        self.writes.append(("edge", body))
        return body

    def patch_node(self, g, n, body):
        self.writes.append(("patch", n, body))
        return {}

    def runs(self, g, n):
        return [{"status": "failed", "error": "ERR-1"}]

    def observations(self, g, n):
        return [{"body": "Tried X; blocked by Y; next needs Z"}]


class FailureRemediation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state = os.path.join(self.tmp, "s")
        os.makedirs(os.path.join(self.state, "logs"))
        self.calls = os.path.join(self.tmp, "calls.jsonl")
        self.cbin = os.path.join(self.tmp, "claude-fail")
        with open(self.cbin, "w") as f:
            f.write(FAKE_FAIL_CLAUDE)
        os.chmod(self.cbin, 0o755)
        os.environ["FAKE_CALLS"] = self.calls
        os.environ["FAKE_TRIAGE"] = json.dumps({"action": "revise", "reason": "acceptance 2 names a removed file",
                                                "acceptance": ["the suite passes"]})
        os.environ.pop("FAKE_TRIAGE_WRONG_NODE", None)

    def tearDown(self):
        for k in ("FAKE_TRIAGE", "FAKE_TRIAGE_WRONG_NODE"):
            os.environ.pop(k, None)

    def run_dispatch(self, **kw):
        out = io.StringIO()
        api = TriageAPI([node("a", repo="r")])
        a = args(workers=1, state_dir=self.state, stop_file=os.path.join(self.state, "STOP"),
                 interval=0.05, claude=self.cbin, **kw)
        d = gd.Dispatcher(api, a, out)
        rc = d.run()
        with open(self.calls) as f:
            launches = [json.loads(l) for l in f]
        return rc, d, api, out.getvalue(), launches

    def test_failure_then_remediation_then_triage(self):
        rc, d, api, text, launches = self.run_dispatch()
        self.assertEqual(rc, 0, text)
        self.assertEqual([l["key"] for l in launches][:2], ["a", "a"], text)
        first, second, third = launches
        sid = first["argv"][first["argv"].index("--session-id") + 1]
        # the remediation launch resumes the failed attempt's session and carries
        # the previous error, the rejection, and the rule
        self.assertEqual(second["argv"][second["argv"].index("--resume") + 1], sid)
        p = second["prompt"]
        self.assertTrue(p.startswith("REMEDIATION LAUNCH"), p)
        self.assertIn("Previous error: ERR-1: the suite is red", p)
        self.assertIn("evidence shows 3 failing tests", p)
        self.assertIn("last_rejection: ", p)
        self.assertIn("Fix the cause, not the symptom", p)
        self.assertIn("graph_next_work {graph", p)
        self.assertIn("FAILED a (attempt 1 of 2 this session): ERR-1", text)
        self.assertIn("next: remediation launch", text)
        self.assertIn("mode=resume session=" + sid, text)
        # the second failure launches a triage worker, deep tier, not the task
        self.assertTrue(third["key"].startswith("triage-a-"), third["key"])
        self.assertTrue(third["prompt"].startswith("TRIAGE."), third["prompt"])
        self.assertEqual(third["model"], "opus")
        self.assertIn("ERR-2: the suite is red", third["prompt"])
        self.assertIn("never claim, heartbeat or report `a`", third["prompt"])
        self.assertIn("FAILED a (attempt 2 of 2 this session): ERR-2", text)
        self.assertIn("next: triage", text)

    def test_bounded_two_attempts_one_triage(self):
        # the triage revises the node, so it stays on the frontier: still nothing more this session
        rc, d, api, text, launches = self.run_dispatch()
        self.assertEqual(rc, 0)
        kinds = ["triage" if l["key"].startswith("triage-") else l["key"] for l in launches]
        self.assertEqual(kinds, ["a", "a", "triage"], text)
        self.assertEqual(d.attempts["a"], 2)
        self.assertEqual(d.triaged, {"a"})
        self.assertIn("nothing runnable or running; exiting", text)
        # the triage node joined the frontier and was never launched from it
        self.assertEqual(text.count("TRIAGE a: 2 failed attempt(s)"), 1)

    def assert_no_report_of_failed_node(self, api):
        self.assertFalse([c for c in api.calls if c[0] == "complete" and c[1] == "id-a"])

    def test_triage_revise(self):
        rc, d, api, text, launches = self.run_dispatch()
        tnode = [w for w in api.writes if w[0] == "node"]
        self.assertEqual(len(tnode), 1)
        self.assertEqual(tnode[0][1]["data"]["triage_of"], "id-a")
        rest = [w for w in api.writes if w not in tnode]
        self.assertEqual(len(rest), 1, api.writes)
        kind, nid, body = rest[0]
        self.assertEqual((kind, nid), ("patch", "id-a"))
        self.assertEqual(body["data"]["revised_by"], "triage")
        self.assertEqual(body["data"]["revised_reason"], "acceptance 2 names a removed file")
        self.assertEqual(body["data"]["acceptance"], ["the suite passes"])
        self.assertTrue(body["merge_data"])
        self.assertIn("TRIAGE a -> revise: patched a", text)
        self.assert_no_report_of_failed_node(api)

    def test_triage_prerequisite(self):
        os.environ["FAKE_TRIAGE"] = json.dumps({"action": "prerequisite", "reason": "the API has no endpoint yet",
                                                "nodes": [{"key": "api-endpoint", "title": "add the endpoint",
                                                           "acceptance": ["GET /x answers 200"]}]})
        rc, d, api, text, launches = self.run_dispatch()
        writes = api.writes[1:]  # [0] is the triage node
        self.assertEqual([w[0] for w in writes], ["node", "edge"], api.writes)
        n = writes[0][1]
        self.assertEqual((n["key"], n["type"]), ("api-endpoint", "task"))
        self.assertEqual(n["data"]["repo"], "r")
        self.assertEqual(n["data"]["created_by"], "triage")
        self.assertEqual(writes[1][1], {"from_node_id": "id-a", "to_node_id": "id-api-endpoint", "type": "requires"})
        self.assertFalse([w for w in api.writes if w[0] == "patch"])
        self.assertIn("TRIAGE a -> prerequisite: created node api-endpoint + requires edge a -> api-endpoint", text)
        self.assert_no_report_of_failed_node(api)

    def test_triage_gate(self):
        os.environ["FAKE_TRIAGE"] = json.dumps({"action": "gate", "reason": "the worker may not rotate prod keys",
                                                "decision": "May the prod signing key be rotated?"})
        rc, d, api, text, launches = self.run_dispatch()
        writes = api.writes[1:]
        self.assertEqual([w[0] for w in writes], ["node", "edge"], api.writes)
        g = writes[0][1]
        self.assertEqual((g["key"], g["type"], g["title"]), ("gate-a", "gate", "May the prod signing key be rotated?"))
        self.assertEqual(writes[1][1], {"from_node_id": "id-a", "to_node_id": "id-gate-a", "type": "requires"})
        # nothing else: no rewrite of the node, no task node
        self.assertFalse([w for w in api.writes if w[0] == "patch"])
        self.assertEqual([w[1]["type"] for w in api.writes if w[0] == "node"], ["chore", "gate"])
        self.assertIn("TRIAGE a -> gate: created gate gate-a", text)
        self.assert_no_report_of_failed_node(api)

    def test_triage_that_reports_the_failed_node_applies_nothing(self):
        os.environ["FAKE_TRIAGE_WRONG_NODE"] = "1"
        rc, d, api, text, launches = self.run_dispatch()
        self.assertIn("TRIAGE-VIOLATION a", text)
        self.assertEqual([w[0] for w in api.writes], ["node"])  # the triage node only

    def test_invalid_decision_applies_nothing(self):
        os.environ["FAKE_TRIAGE"] = json.dumps({"action": "rewrite-everything", "reason": "x"})
        rc, d, api, text, launches = self.run_dispatch()
        self.assertIn("TRIAGE-NONE a: data.triage.action", text)
        self.assertEqual([w[0] for w in api.writes], ["node"])
        self.assertEqual(gd.triage_decision({"triage": {"action": "gate", "reason": "r"}})[0], None)
        self.assertEqual(gd.triage_decision({"triage": {"action": "prerequisite", "reason": "r", "nodes": []}})[0], None)

    def test_failed_outcome(self):
        base = {"reported": True, "report_status": "succeeded", "report_error": None, "rejection": None,
                "card_rejection": '{"reasons": ["old"]}', "result": "success", "turns": 3, "result_text": None}
        # an earlier run's last_rejection does not fail a run that succeeded
        self.assertIsNone(gd.failed_outcome(base, 0))
        o = gd.failed_outcome(dict(base, report_status="failed", report_error="E"), 0)
        self.assertEqual(o, {"error": "E", "rejection": '{"reasons": ["old"]}'})
        o = gd.failed_outcome(dict(base, rejection='{"state": "rejected"}'), 0)
        self.assertIn("verdict rejected", o["error"])
        self.assertEqual(o["rejection"], '{"state": "rejected"}')
        self.assertIn("without reporting", gd.failed_outcome(dict(base, reported=False), 1)["error"])
        self.assertIsNone(gd.rejection_of('{"verification": {"state": "verified"}}', "verification"))

    def test_no_triage_flag(self):
        rc, d, api, text, launches = self.run_dispatch(no_triage=True)
        self.assertEqual([l["key"] for l in launches], ["a", "a"])
        self.assertEqual(api.writes, [])
        self.assertIn("left for a person (--no-triage)", text)


class TriageAllFailures(unittest.TestCase):
    """Every failed node gets triage, whatever its type."""
    setUp, tearDown = FailureRemediation.setUp, FailureRemediation.tearDown

    def run_dispatch(self, nodes=None, **kw):
        out = io.StringIO()
        api = TriageAPI(nodes or [node("o", type="ops", status="failed", repo="r"),
                                  node("p", type="ops", status="active")])
        a = args(workers=2, state_dir=self.state, stop_file=os.path.join(self.state, "STOP"),
                 interval=0.05, types=kw.pop('types', 'task,bug,chore,merge'), claude=self.cbin, **kw)
        d = gd.Dispatcher(api, a, out)
        rc = d.run()
        launches = [json.loads(l) for l in open(self.calls)] if os.path.exists(self.calls) else []
        return rc, d, api, out.getvalue(), launches

    def test_failed_ops_node_is_triaged_once(self):
        rc, d, api, text, launches = self.run_dispatch()
        self.assertEqual(rc, 0, text)
        self.assertEqual(len(launches), 1, text)  # not relaunched next pass
        self.assertTrue(launches[0]["key"].startswith("triage-o-"), launches)
        self.assertTrue(launches[0]["prompt"].startswith("TRIAGE."))
        self.assertIn("type ops", launches[0]["prompt"])
        self.assertIn("you never do the node's own work", launches[0]["prompt"])
        self.assertEqual(text.count("TRIAGE o: 0 failed attempt(s)"), 1, text)
        # marked: data.triaged_at and the runs signature
        marks = [w for w in api.writes if w[0] == "patch" and "triaged_at" in w[2]["data"]]
        self.assertEqual(len(marks), 1, api.writes)
        self.assertEqual(marks[0][2]["data"]["triaged_runs"], [1, "failed"])

    def test_failed_gate_node_is_triaged_too(self):
        rc, d, api, text, launches = self.run_dispatch(
            [node("gt", type="gate", status="failed"), node("rl", type="release", status="failed")])
        keys = sorted(l["key"].split("-")[1] for l in launches)
        self.assertEqual(keys, ["gt", "rl"], text)

    def test_node_with_a_live_run_or_already_marked_is_skipped(self):
        marked = node("m", type="ops", status="failed", triaged_at="2026-10-03T00:00:00Z", triaged_runs=[1, "failed"])
        live = node("o", type="ops", status="failed")
        api = TriageAPI([marked, live])
        d = gd.Dispatcher(api, args(state_dir=self.state, types="task"), io.StringIO())
        d.workers["o"] = gd.Worker(live, "/dev/null")  # a live run of ours
        self.assertEqual(d.candidates(api.nodes("g")), [])
        # its runs changed since the mark: triaged again
        changed = node("m", type="ops", status="failed", triaged_at="2026-10-03T00:00:00Z", triaged_runs=[0, ""])
        d = gd.Dispatcher(TriageAPI([changed]), args(state_dir=self.state, types="task"), io.StringIO())
        self.assertEqual([c["key"] for c in d.candidates([changed])], ["m"])
        # and a node triaged this session is skipped until its runs change
        d.triaged_sig["m"] = (1, "failed")
        self.assertEqual(d.candidates([changed]), [])
        d.triaged_sig["m"] = (0, "")
        self.assertEqual([c["key"] for c in d.candidates([changed])], ["m"])

    def test_no_triage_flag_skips_ops_failures(self):
        rc, d, api, text, launches = self.run_dispatch(no_triage=True)
        self.assertEqual(launches, [])

    def test_outcome_b_writes_requires_edge_to_the_named_prerequisite(self):
        os.environ["FAKE_TRIAGE"] = json.dumps({"action": "prerequisite", "reason": "waits on the agent existing",
                                                "nodes": [{"key": "p", "existing": True}]})
        rc, d, api, text, launches = self.run_dispatch()
        edges = [w[1] for w in api.writes if w[0] == "edge"]
        self.assertEqual(edges, [{"from_node_id": "id-o", "to_node_id": "id-p", "type": "requires"}], api.writes)
        self.assertIn("requires edge o -> p (existing)", text)
        # a new prerequisite node gets its edge too
        os.environ["FAKE_TRIAGE"] = json.dumps({"action": "prerequisite", "reason": "needs an agent",
                                                "nodes": [{"key": "new-p", "title": "t", "acceptance": ["x"]}]})
        rc, d, api, text, launches = self.run_dispatch()
        edges = [w[1] for w in api.writes if w[0] == "edge"]
        self.assertEqual(edges, [{"from_node_id": "id-o", "to_node_id": "id-new-p", "type": "requires"}], api.writes)

    def test_outcome_a_retypes_and_rewrites_acceptance(self):
        os.environ["FAKE_TRIAGE"] = json.dumps({"action": "revise", "reason": "merged and applied; only verification left",
                                                "type": "task", "acceptance": ["the applied change is verified live"]})
        rc, d, api, text, launches = self.run_dispatch()
        patches = [w for w in api.writes if w[0] == "patch" and w[2].get("type")]
        self.assertEqual(len(patches), 1, api.writes)
        _, nid, body = patches[0]
        self.assertEqual((nid, body["type"]), ("id-o", "task"))
        self.assertEqual(body["data"]["revised_by"], "triage")
        self.assertEqual(body["data"]["acceptance"], ["the applied change is verified live"])

    def test_outcome_c_points_at_an_existing_gate(self):
        os.environ["FAKE_TRIAGE"] = json.dumps({"action": "gate", "reason": "human apply", "decision": "apply?",
                                                "gate_key": "p"})
        rc, d, api, text, launches = self.run_dispatch()
        self.assertEqual([w[1]["to_node_id"] for w in api.writes if w[0] == "edge"], ["id-p"])
        self.assertEqual([w for w in api.writes if w[0] == "node" and w[1]["key"] == "p"], [])


class LeaseAPI(TriageAPI):
    pass


class DispatcherService(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def disp(self, api, **kw):
        a = args(state_dir=self.tmp, stop_file=os.path.join(self.tmp, "STOP"), no_lease=False, **kw)
        out = io.StringIO()
        return gd.Dispatcher(api, a, out), out

    def test_second_dispatcher_refuses_unless_takeover(self):
        api = LeaseAPI([node("a", status="done")])
        d1, _ = self.disp(api)
        self.assertTrue(d1.acquire_lease())
        created = [w for w in api.writes if w[0] == "node"][0][1]
        self.assertEqual(created["key"], "dispatcher-lease")  # visible on the graph
        held = created["data"]["dispatcher"]
        self.assertEqual(held["pid"], os.getpid())
        other = dict(held, pid=os.getpid() + 1)
        lease = node("dispatcher-lease", type="ops", status="done", dispatcher=other)
        api2 = LeaseAPI([lease])
        d2, out = self.disp(api2)
        self.assertEqual(d2.run(), 3)
        self.assertIn("another graph-dispatch holds graph g1", out.getvalue())
        self.assertIn("--takeover", out.getvalue())
        d3, out = self.disp(api2, takeover=True)
        self.assertTrue(d3.acquire_lease())
        self.assertIn("TAKEOVER", out.getvalue())
        patched = [w for w in api2.writes if w[0] == "patch"][0]
        self.assertEqual(patched[2]["data"]["dispatcher"]["pid"], os.getpid())

    def test_expired_lease_is_taken_and_lease_node_is_never_work(self):
        old = {"owner": "x", "host": "h", "pid": os.getpid() + 1, "until": "2020-01-01T00:00:00+00:00"}
        lease = node("dispatcher-lease", type="ops", status="failed", dispatcher=old)
        d, out = self.disp(LeaseAPI([lease]))
        self.assertTrue(d.acquire_lease())
        self.assertEqual(d.candidates([lease]), [])

    def test_defaults_include_scout_milestone_ops_not_gate(self):
        ts = set(gd.DEFAULT_TYPES.split(","))
        self.assertTrue({"scout", "milestone", "ops", "task", "bug", "chore", "merge"} <= ts)
        self.assertNotIn("gate", ts)

    def test_api_retries_transient_errors_then_succeeds(self):
        import urllib.error
        import urllib.request
        api = gd.API("http://x", None, "k")
        api.sleep = lambda s: None
        calls = []

        class R:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return b'{"data": [1]}'

        def fake(req, timeout=0):
            calls.append(1)
            if len(calls) < 3:
                raise urllib.error.URLError("[Errno -3] Temporary failure in name resolution")
            return R()
        orig = urllib.request.urlopen
        urllib.request.urlopen = fake
        try:
            self.assertEqual(api.call("GET", "/x"), {"data": [1]})
            self.assertEqual(len(calls), 3)
            calls.clear()
            urllib.request.urlopen = lambda req, timeout=0: (_ for _ in ()).throw(urllib.error.URLError("down"))
            with self.assertRaises(gd.APIError) as c:
                api.call("GET", "/x")
            self.assertEqual(c.exception.status, "network")
        finally:
            urllib.request.urlopen = orig

    def test_network_error_never_crashes_a_pass(self):
        class Flaky(LeaseAPI):
            n = 0
            def nodes(s, g):
                s.n += 1
                if s.n == 1:
                    raise gd.APIError("network", "URLError: dns")
                return super().nodes(g)
        d, out = self.disp(Flaky([node("a", status="done")]), interval=0.01)
        d.args.no_lease = True
        self.assertEqual(d.run(), 0)
        self.assertIn("API error (pass skipped, retrying)", out.getvalue())

    def test_sh_retries_transient_gh_failure(self):
        d, _ = self.disp(LeaseAPI([]))
        d.retry_sleep = 0
        flag = os.path.join(self.tmp, "f")
        cmd = ["sh", "-c", "if [ -e %s ]; then echo ok; else touch %s; echo 'Temporary failure in name resolution'; exit 1; fi" % (flag, flag)]
        self.assertEqual(d._sh(cmd, self.tmp), (0, "ok"))

    def test_triage_waits_grace_and_rechecks_status(self):
        recent = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=30)).isoformat()
        old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=30)).isoformat()
        f = node("o", type="ops", status="failed")

        class G(LeaseAPI):
            end = recent
            fresh = "failed"
            def runs(s, g, n): return [{"status": "failed", "ended_at": s.end}]
            def node(s, g, n): return dict(f, status=s.fresh)
        api = G([f])
        d, out = self.disp(api, triage_grace=10, types="task")
        self.assertEqual(d.candidates([f]), [])
        self.assertIn("waits", out.getvalue())
        api.end = old
        self.assertEqual([c["key"] for c in d.candidates([f])], ["o"])
        api.fresh = "done"  # the coordinator reported it done meanwhile
        d.launch_triage(dict(f, _triage=True, _triage_any=True))
        self.assertIn("no longer failed", out.getvalue())
        self.assertEqual([w for w in api.writes if w[0] == "node"], [])


if __name__ == "__main__":
    unittest.main()

