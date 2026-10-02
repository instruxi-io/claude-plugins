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


if __name__ == "__main__":
    unittest.main()
