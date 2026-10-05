#!/usr/bin/env bash
# Every hook against a local stub of the graph API. No key, no network, no Jev.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-18790}
export STUB_LOG="$(mktemp)"
export STUB_HEALTH_FILE="$(mktemp)"
python3 test/stub_graph.py "$PORT" & STUB=$!
trap 'kill $STUB 2>/dev/null; rm -rf "$WORK" "$STUB_LOG" "$STUB_LOG.hb"' EXIT
sleep 0.4

WORK="$(mktemp -d)"
# the Claude fallback manifest directory is named in hooks/claude/ only
CPD=$(python3 -c 'import sys;sys.path.insert(0,"hooks/claude");import claude_paths;print(claude_paths.MANIFEST_DIR)')
export CLAUDE_PLUGIN_DATA="$WORK/data"
mkdir -p "$WORK/proj/.enforcer"
printf '{"graph_id":"g1","base_url":"http://127.0.0.1:%s","api_key_env":"GRAPH_API_KEY"}\n' "$PORT" > "$WORK/proj/.enforcer/graph.json"
export GRAPH_API_KEY=stub-key
# Claude Code's own plugin bookkeeping, for session_start's notices: never the real one.
export CLAUDE_CONFIG_DIR="$WORK/cc"; mkdir -p "$CLAUDE_CONFIG_DIR"
export ENFORCER_BASE_URL="http://127.0.0.1:$PORT" ENFORCER_HOME="$WORK/eh"   # version check: never the real server or credential
SID=s1
pass=0; fail=0
check() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
hook() { printf '%s' "$2" | python3 "lib/graph/$1"; }
runfile="$CLAUDE_PLUGIN_DATA/runs/$SID.json"

# --- session start
out=$(hook session_start.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")
check "session_start: prints the frontier" 'echo "$out" | grep -q "frontier (runnable now, not claimed): api-contract, legal-and-key"'
check "session_start: prints running and failed" 'echo "$out" | grep -q "running: schema-judgment" && echo "$out" | grep -q "failed.*broken"'
out=$(hook session_start.py "{\"session_id\":\"$SID\",\"cwd\":\"/\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")
check "session_start: silent without a graph config" '[ -z "$out" ]'
out=$(GRAPH_API_KEY=wrong hook session_start.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")
check "session_start: silent on 401 (fails open)" '[ -z "$out" ]'

# --- track_run: next_work writes the run file, in each tool_response shape
card='{"state":"claimed","graph_id":"g1","node":{"node_id":"n1","key":"api-contract","title":"Pin the contract"},"run":{"run_id":"r1","attempt":1,"lease_expires_at":"2030-01-01T00:00:00Z"},"acceptance":["a","b"]}'
in=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{"graph":"g1"},"tool_response":[{"type":"text","text":sys.argv[2]}]}))' "$SID" "$card")
hook track_run.py "$in"
check "track_run: content-block response writes the run file" '[ -s "$runfile" ] && grep -q "\"run_id\": \"r1\"" "$runfile"'
rm -f "$runfile"
in=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{},"tool_response":sys.argv[2]}))' "$SID" "$card")
hook track_run.py "$in"
check "track_run: string response writes the run file" '[ -s "$runfile" ]'
in=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{},"tool_response":{"state":"wait","graph_id":"g1"}}))' "$SID")
rm -f "$runfile"; hook track_run.py "$in"
check "track_run: a wait card writes nothing" '[ ! -e "$runfile" ]'

# --- heartbeat cadence and control channel
in=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{},"tool_response":sys.argv[2]}))' "$SID" "$card")
hook track_run.py "$in"
: > "$STUB_LOG"
for i in 1 2 3 4 5 6 7 8 9; do hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Bash\",\"tool_input\":{}}" >/dev/null; done
check "heartbeat: nine tool calls, no HTTP" '! grep -q heartbeat "$STUB_LOG"'
start=$(date +%s%N)
out=$(hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Bash\",\"tool_input\":{}}")
ms=$(( ($(date +%s%N) - start) / 1000000 ))
check "heartbeat: tenth call heartbeats over HTTP" 'grep -q "/nodes/n1/runs/r1/heartbeat" "$STUB_LOG"'
check "heartbeat: silent on ok" '[ -z "$out" ]'
check "heartbeat: under 200ms ($ms ms)" '[ "$ms" -lt 200 ]'
out=$(hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"mcp__enforcer-graph__graph_plan_status\",\"tool_input\":{}}")
check "heartbeat: graph tools do not count or heartbeat" '[ -z "$out" ]'
for i in 1 2 3 4 5 6 7 8 9; do hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Read\",\"tool_input\":{}}" >/dev/null; done
echo cancel_requested > "$STUB_LOG.hb"
out=$(hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Read\",\"tool_input\":{}}")
check "heartbeat: cancel_requested says so in one line" 'echo "$out" | grep -q "systemMessage" && echo "$out" | grep -q "cancellation was requested for node api-contract"'
check "heartbeat: cancel_requested keeps the run file" '[ -s "$runfile" ]'
for i in 1 2 3 4 5 6 7 8 9; do hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Read\",\"tool_input\":{}}" >/dev/null; done
echo reclaimed > "$STUB_LOG.hb"
out=$(hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Read\",\"tool_input\":{}}")
check "heartbeat: reclaimed tells the model to stop" 'echo "$out" | grep -q "another harness now owns it"'
check "heartbeat: reclaimed forgets the run" '[ ! -e "$runfile" ]'

# --- remember on compact
hook track_run.py "$in"
printf '%s\n' '{"type":"user","message":{"role":"user","content":"work the plan"}}' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Contract drafted; two shapes left to pin."}]}}' > "$WORK/transcript.jsonl"
: > "$STUB_LOG"
hook remember_on_compact.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"transcript_path\":\"$WORK/transcript.jsonl\",\"hook_event_name\":\"PreCompact\",\"trigger\":\"auto\"}"
check "remember_on_compact: posts one observation on the held node" 'grep -q "/nodes/n1/observations" "$STUB_LOG"'
check "remember_on_compact: body carries the last assistant message" 'grep -q "two shapes left to pin" "$STUB_LOG"'
check "remember_on_compact: source names the session" 'grep -q "claude-code:compact:s1" "$STUB_LOG"'
: > "$STUB_LOG"
hook remember_on_compact.py "{\"session_id\":\"nobody\",\"cwd\":\"$WORK/proj\",\"transcript_path\":\"$WORK/transcript.jsonl\",\"hook_event_name\":\"PreCompact\",\"trigger\":\"auto\"}"
check "remember_on_compact: no run held, no HTTP" '[ ! -s "$STUB_LOG" ]'

# --- stop guard
out=$(hook open_run_guard.py "{\"session_id\":\"$SID\",\"last_assistant_message\":\"Done for today.\",\"stop_hook_active\":false}")
check "open_run_guard: blocks a stop with a run open and unreported" 'echo "$out" | grep -q "\"decision\": \"block\"" && echo "$out" | grep -q "api-contract"'
out=$(hook open_run_guard.py "{\"session_id\":\"$SID\",\"last_assistant_message\":\"Done for today.\",\"stop_hook_active\":true}")
check "open_run_guard: never blocks twice" '[ -z "$out" ]'
out=$(hook open_run_guard.py "{\"session_id\":\"$SID\",\"last_assistant_message\":\"I am leaving the run open; progress is in graph_remember.\",\"stop_hook_active\":false}")
check "open_run_guard: an explicit leave-open passes" '[ -z "$out" ]'
in=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_report","tool_input":{"node_id":"n1","run_id":"r1","status":"succeeded"},"tool_response":"{\"run\":{}}"}))' "$SID")
hook track_run.py "$in"
check "track_run: graph_report clears the run file" '[ ! -e "$runfile" ]'
out=$(hook open_run_guard.py "{\"session_id\":\"$SID\",\"last_assistant_message\":\"Done for today.\",\"stop_hook_active\":false}")
check "open_run_guard: silent once the run is reported" '[ -z "$out" ]'

# --- evidence capture: what actually ran, recorded as it happens
evfile="$CLAUDE_PLUGIN_DATA/evidence/$SID.jsonl"
lib.clear() { rm -f "$evfile"; }
cap() { hook capture_evidence.py "$1"; }
bash_in() { python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"Bash","tool_input":{"command":sys.argv[2]},"tool_response":json.loads(sys.argv[3])}))' "$SID" "$1" "$2"; }

lib.clear; lib.clear 2>/dev/null
rm -f "$runfile" "$evfile"
cap "$(bash_in 'go test ./...' '{"stdout":"ok enforcer-graph/internal/nodes","stderr":"","interrupted":false}')"
check "capture: no run open, nothing captured" '[ ! -e "$evfile" ]'
out=$(hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"node_id\":\"n1\",\"report\":\"done\"}}")
check "attach: no capture file, the report goes through untouched but for the client stamp" 'echo "$out" | python3 -c "
import json,sys; u=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"]
sys.exit(0 if u=={\"node_id\":\"n1\",\"report\":\"done\",\"client\":u[\"client\"]} and \"evidence\" not in u else 1)"'

claim_in=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{},"tool_response":sys.argv[2]}))' "$SID" "$card")
hook track_run.py "$claim_in"                 # run open again
cap "$(bash_in 'go build ./...' '{"stdout":"","stderr":"","interrupted":false}')"
check "capture: a run is open, the command is captured" '[ -s "$evfile" ] && grep -q "go build ./..." "$evfile"'
check "capture: a zero-exit command records exit 0" 'python3 -c "import json,sys;r=[json.loads(l) for l in open(sys.argv[1])];sys.exit(0 if r[-1][\"kind\"]==\"command\" and r[-1][\"exit\"]==0 else 1)" "$evfile"'
cap "{\"session_id\":\"$SID\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/x/y.go\"},\"tool_response\":{\"file\":{\"content\":\"package x\"}}}"
cap "{\"session_id\":\"$SID\",\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"func\"},\"tool_response\":{\"numFiles\":3}}"
check "capture: a Read and a Grep are not evidence of doing" '[ "$(wc -l < "$evfile")" -eq 1 ]'

# a failing Bash reaches the hook as the string "Error: Exit code N\n<output>"
cap "$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"Bash","tool_input":{"command":"go vet ./..."},"tool_response":"Error: Exit code 1\ninternal/nodes/x.go:12: unreachable code"}))' "$SID")"
check "capture: a Bash failure keeps its exit code and its output" 'python3 -c "
import json,sys
r=[json.loads(l) for l in open(sys.argv[1])][-1]
sys.exit(0 if r[\"exit\"]==1 and \"unreachable code\" in r[\"output\"] and r[\"cmd\"]==\"go vet ./...\" else 1)" "$evfile"'
cap "{\"session_id\":\"$SID\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/w/nodes.go\",\"old_string\":\"a\",\"new_string\":\"b := runnable(ctx)\"},\"tool_response\":{\"filePath\":\"/w/nodes.go\"}}"
check "capture: an Edit records the path and what it wrote" 'python3 -c "
import json,sys
r=[json.loads(l) for l in open(sys.argv[1])][-1]
sys.exit(0 if r[\"kind\"]==\"file\" and r[\"path\"]==\"/w/nodes.go\" and \"runnable(ctx)\" in r[\"excerpt\"] else 1)" "$evfile"'
bigout=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"Bash","tool_input":{"command":"cat big"},"tool_response":{"stdout":"x"*9000,"stderr":"and a tail on stderr"}}))' "$SID")
cap "$bigout"
check "capture: output is clipped, never unbounded" 'python3 -c "
import json,sys
r=[json.loads(l) for l in open(sys.argv[1])][-1]
sys.exit(0 if len(r[\"output\"])==4000 else 1)" "$evfile"'
check "capture: a clipped output keeps its END, where the verdict is" 'python3 -c "
import json,sys
o=[json.loads(l) for l in open(sys.argv[1])][-1][\"output\"]
sys.exit(0 if o.endswith(\"and a tail on stderr\") and o.startswith(\"xxx\") and \"characters elided]\" in o else 1)" "$evfile"'
gotest=$(python3 -c '
import json,sys
lines=["=== RUN   TestCase%d\n--- PASS: TestCase%d (0.01s)" % (i,i) for i in range(400)]
out="\n".join(lines)+"\nPASS\nok  \tenforcer-graph/internal/stream\t6.812s"
print(json.dumps({"session_id":sys.argv[1],"tool_name":"Bash","tool_input":{"command":"go test -v ./internal/stream/"},"tool_response":{"stdout":out,"stderr":""}}))' "$SID")
cap "$gotest"
check "capture: a long go test -v keeps its ok line" 'python3 -c "
import json,sys
o=[json.loads(l) for l in open(sys.argv[1])][-1][\"output\"]
sys.exit(0 if len(o)==4000 and o.rstrip().endswith(\"6.812s\") and \"=== RUN   TestCase0\" in o else 1)" "$evfile"'

# --- selection at report time
out=$(hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"node_id\":\"n1\",\"run_id\":\"r1\",\"status\":\"succeeded\",\"report\":\"1. done\"}}")
check "attach: rewrites the arguments through updatedInput" 'echo "$out" | python3 -c "
import json,sys
o=json.load(sys.stdin)[\"hookSpecificOutput\"]
u=o[\"updatedInput\"]
sys.exit(0 if o[\"hookEventName\"]==\"PreToolUse\" and u[\"report\"]==\"1. done\" and u[\"node_id\"]==\"n1\" and isinstance(u[\"evidence\"],list) and u[\"evidence\"] else 1)"'
# updatedInput REPLACES the whole argument object, so a key this hook does not
# echo is lost on the way to the server. `outputs` (declared output values,
# typed-outputs-and-links) is the newest argument graph_report takes: it must
# arrive exactly as the model wrote it, beside the attached evidence.
out=$(hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"node_id\":\"n1\",\"run_id\":\"r1\",\"status\":\"succeeded\",\"report\":\"1. done\",\"outputs\":{\"variance\":0.004,\"chosen\":\"ENG-7\"}}}")
check "attach: an outputs argument survives the rewrite unchanged" 'echo "$out" | python3 -c "
import json,sys
u=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"]
sys.exit(0 if u.get(\"outputs\")=={\"variance\":0.004,\"chosen\":\"ENG-7\"} and u[\"evidence\"] and u[\"report\"]==\"1. done\" else 1)"'
# CHANGED in 0.19.0 (was "evidence the model wrote itself is replaced, not merged"): the worker's
# verbatim command records are now MERGED with the capture; only prose notes are still dropped.
check "attach: a worker's verbatim command record is merged, a prose note is not" 'echo "$(hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"report\":\"x\",\"evidence\":[{\"kind\":\"note\",\"text\":\"trust me\"},{\"kind\":\"command\",\"cmd\":\"worker-cmd\",\"exit\":0,\"output\":\"theirs\"}]}}")" | python3 -c "
import json,sys
u=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"]
sys.exit(0 if not any(e.get(\"text\")==\"trust me\" for e in u[\"evidence\"]) and any(e.get(\"cmd\")==\"worker-cmd\" and e.get(\"output\")==\"theirs\" for e in u[\"evidence\"]) and any(\"go vet\" in str(e.get(\"cmd\")) for e in u[\"evidence\"]) else 1)"'
check "attach: context mode hands the capture over verbatim instead" 'GRAPH_EVIDENCE_MODE=context hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"report\":\"x\"}}" | python3 -c "
import json,sys
o=json.load(sys.stdin)[\"hookSpecificOutput\"]
sys.exit(0 if \"updatedInput\" not in o and \"VERBATIM\" in o[\"additionalContext\"] and \"go vet\" in o[\"additionalContext\"] else 1)"'

# thirty commands, one of them failing early: the cap keeps the failure and puts it first
rm -f "$evfile"
for i in $(seq 1 30); do
  if [ "$i" = 3 ]; then
    cap "$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"Bash","tool_input":{"command":"go test ./internal/traverse"},"tool_response":"Error: Exit code 2\nFAIL bounds"}))' "$SID")"
  else
    cap "$(bash_in "echo step-$i" '{"stdout":"ok","stderr":"","interrupted":false}')"
  fi
done
cap "{\"session_id\":\"$SID\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"/w/late.go\",\"content\":\"package late\"},\"tool_response\":{\"filePath\":\"/w/late.go\"}}"
out=$(hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"report\":\"x\"}}")
check "attach: capped at the twenty the server accepts" 'echo "$out" | python3 -c "
import json,sys
sys.exit(0 if len(json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"])==20 else 1)"'
check "attach: the cap keeps the failing command, and first" 'echo "$out" | python3 -c "
import json,sys
e=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"]
sys.exit(0 if e[0][\"exit\"]==2 and e[0][\"cmd\"]==\"go test ./internal/traverse\" else 1)"'
check "attach: the most recent commands survive the cap" 'echo "$out" | python3 -c "
import json,sys
e=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"]
cmds=[i.get(\"cmd\") for i in e]
sys.exit(0 if \"echo step-30\" in cmds and \"echo step-1\" not in cmds else 1)"'

# --- the capture is cleared when the run closes
in_report=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_report","tool_input":{},"tool_response":"{\"run\":{}}"}))' "$SID")
hook track_run.py "$in_report"
check "capture: the file is cleared when the run is reported" '[ ! -e "$evfile" ] && [ ! -e "$runfile" ]'
hook track_run.py "$claim_in"
cap "$(bash_in 'ls' '{"stdout":"a","stderr":"","interrupted":false}')"
echo reclaimed > "$STUB_LOG.hb"
for i in 1 2 3 4 5 6 7 8 9; do hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Read\",\"tool_input\":{}}" >/dev/null; done
hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Read\",\"tool_input\":{}}" >/dev/null
check "capture: a reclaimed lease clears the capture too" '[ ! -e "$evfile" ]'
echo ok > "$STUB_LOG.hb"

# --- both new hooks fail open
out=$(printf 'not json' | python3 lib/graph/capture_evidence.py); rc=$?
check "capture_evidence: garbage stdin is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'
out=$(printf 'not json' | python3 lib/graph/attach_evidence.py); rc=$?
check "attach_evidence: garbage stdin is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'
out=$(CLAUDE_PLUGIN_DATA=/proc/nonexistent/data hook capture_evidence.py "$(bash_in 'ls' '{"stdout":"a","stderr":"","interrupted":false}')"); rc=$?
check "capture_evidence: an unwritable data dir is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'
out=$(CLAUDE_PLUGIN_DATA=/proc/nonexistent/data hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"report\":\"x\"}}"); rc=$?
check "attach_evidence: an unwritable data dir still only stamps the client, exit 0" '[ "$rc" -eq 0 ] && echo "$out" | python3 -c "
import json,sys; u=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"]; sys.exit(0 if set(u)=={\"report\",\"client\"} else 1)"'
start=$(date +%s%N)
cap "$(bash_in 'echo hi' '{"stdout":"hi","stderr":"","interrupted":false}')" >/dev/null
ms=$(( ($(date +%s%N) - start) / 1000000 ))
check "capture_evidence: runs on every tool call, under 200ms ($ms ms)" '[ "$ms" -lt 200 ]'
hook track_run.py "$in_report"

# --- fail open with the API down
hook track_run.py "$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{},"tool_response":sys.argv[2]}))' "$SID" "$card")"
for i in 1 2 3 4 5 6 7 8 9; do hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Read\",\"tool_input\":{}}" >/dev/null; done
out=$(GRAPH_BASE_URL=http://127.0.0.1:1 hook heartbeat.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Read\",\"tool_input\":{}}"); rc=$?
check "heartbeat: API down is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'
out=$(printf 'not json' | python3 lib/graph/session_start.py); rc=$?
check "any hook: garbage stdin is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'

# --- a claimed pull request is resolved, not taken on trust (2026-09-20)
# A URL for a PR that does not exist used to be stored and shown as a result.
pr_json() { python3 -c "
import sys,importlib.util,json
sys.path.insert(0,'lib/graph')
spec=importlib.util.spec_from_file_location('ae','lib/graph/attach_evidence.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
r=m.check_pr(sys.argv[1]); print(json.dumps(r) if r else '')" "$1"; }
out=$(pr_json "https://github.com/instruxi-io/enforcer-graph/pull/999999")
check "pr: a pull request that does not exist is recorded as NOT FOUND" 'echo "$out" | grep -q "NOT FOUND"'
# A PUBLIC repo's merged PR, so this resolves in the public catalog's CI too
# (enforcer-graph is private: its PRs are readable only with an org login).
out=$(pr_json "https://github.com/instruxi-io/enforcer-governor/pull/11")
check "pr: a real pull request resolves to its state and title" 'echo "$out" | grep -q "merged" && echo "$out" | grep -q "state=MERGED"'
out=$(pr_json "not a url")
check "pr: a non-URL is not a claim to check" '[ -z "$out" ]'
out=$(pr_json "https://github.com/instruxi-io/definitely-not-a-repo-xyz/pull/1")
check "pr: an unreachable repo fails open or records it, never crashes" 'true'

# --- a fact gets the RECENT record, not the whole run (2026-09-20)
ev_dir="$CLAUDE_PLUGIN_DATA/evidence"; mkdir -p "$ev_dir"
python3 -c "
import json,os,sys
d=os.environ['CLAUDE_PLUGIN_DATA']+'/evidence/sess-rem.jsonl'
recs=[{'kind':'command','cmd':f'step {i}','exit':0,'output':f'out {i}'} for i in range(8)]
open(d,'w').write('\n'.join(json.dumps(r) for r in recs)+'\n')"
mkdir -p "$CLAUDE_PLUGIN_DATA/runs"
python3 -c "
import json,os
open(os.environ['CLAUDE_PLUGIN_DATA']+'/runs/sess-rem.json','w').write(json.dumps({'graph_id':'g','node_id':'n','run_id':'r','key':'k'}))"
rem_in=$(python3 -c "
import json;print(json.dumps({'session_id':'sess-rem','tool_name':'mcp__enforcer-graph__graph_remember','tool_input':{'graph':'g','node_id':'n','body':'The default lease is 300 seconds.'}}))")
out=$(printf '%s' "$rem_in" | python3 lib/graph/attach_evidence.py)
n=$(echo "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['hookSpecificOutput'].get('updatedInput',{}).get('evidence',[])))" 2>/dev/null || echo 0)
check "remember: only the most recent records are attached, not the whole run (got $n of 8)" '[ "$n" -le 3 ] && [ "$n" -ge 1 ]'
check "remember: the fact itself is passed through untouched" 'echo "$out" | grep -q "The default lease is 300 seconds"'
rep_in=$(python3 -c "
import json;print(json.dumps({'session_id':'sess-rem','tool_name':'mcp__enforcer-graph__graph_report','tool_input':{'graph':'g','node_id':'n','run_id':'r','status':'succeeded','report':'done'}}))")
outr=$(printf '%s' "$rep_in" | python3 lib/graph/attach_evidence.py)
nr=$(echo "$outr" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['hookSpecificOutput'].get('updatedInput',{}).get('evidence',[])))" 2>/dev/null || echo 0)
check "report: still gets the whole captured run, not the recency window (got $nr)" '[ "$nr" -gt 3 ]'
rm -rf "$CLAUDE_PLUGIN_DATA/evidence" "$CLAUDE_PLUGIN_DATA/runs"

# --- two subagents in ONE session ----------------------------------------
# The failure this reproduces, measured live on 2026-09-20: hooks fire in the
# PARENT session's context for a SUBAGENT's tool call, so keying by session_id
# put both agents in one run file and one evidence file. The later claim
# overwrote the earlier; the first report attached 20 items of which 9 were the
# OTHER agent's; and clearing on that report left the second agent capturing
# nothing, so its report came back `unsupported` for work that was really done.
# Both agents here share a session_id and differ only by agent_id, which is how
# Claude Code presents them.
AK() { python3 -c "import hashlib,sys;print(hashlib.sha256(('agent_id:'+sys.argv[1]).encode()).hexdigest()[:32])" "$1"; }
sclaim() { # $1=agent_id $2=node/run suffix
  printf '{"session_id":"%s","agent_id":"%s","cwd":"%s","hook_event_name":"PostToolUse","tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{"graph":"g1"},"tool_response":{"state":"claimed","graph_id":"g1","node":{"node_id":"n-%s","key":"k-%s"},"run":{"run_id":"r-%s","lease_expires_at":"2099-01-01T00:00:00Z"}}}' \
    "$SID" "$1" "$WORK/proj" "$2" "$2" "$2" | python3 lib/graph/track_run.py >/dev/null; }
scap() { # $1=agent_id $2=command
  printf '{"session_id":"%s","agent_id":"%s","cwd":"%s","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"%s"},"tool_response":{"stdout":"ok","stderr":""}}' \
    "$SID" "$1" "$WORK/proj" "$2" | python3 lib/graph/capture_evidence.py >/dev/null; }
evlines() { f="$CLAUDE_PLUGIN_DATA/evidence/$(AK "$1").jsonl"; [ -f "$f" ] && wc -l < "$f" | tr -d ' ' || echo 0; }

sclaim agent-A a
sclaim agent-B b
nrun=$(ls "$CLAUDE_PLUGIN_DATA/runs"/*.json 2>/dev/null | wc -l | tr -d ' ')
check "two subagents in one session hold TWO run files, not one (got $nrun)" '[ "$nrun" -eq 2 ]'
check "agent A's run file still names its own node" 'grep -q "k-a" "$CLAUDE_PLUGIN_DATA/runs/$(AK agent-A).json"'
check "agent B's run file names B's node, not A's" 'grep -q "k-b" "$CLAUDE_PLUGIN_DATA/runs/$(AK agent-B).json"'

scap agent-A "go test ./a"
scap agent-A "go build ./a"
scap agent-B "go test ./b"
na=$(evlines agent-A); nb=$(evlines agent-B)
check "agent A captured only its own two records (got $na)" '[ "$na" -eq 2 ]'
check "agent B captured only its own one record (got $nb)" '[ "$nb" -eq 1 ]'

rep=$(printf '{"session_id":"%s","agent_id":"agent-A","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"mcp__enforcer-graph__graph_report","tool_input":{"graph":"g1","node_id":"n-a","run_id":"r-a","status":"succeeded","report":"done"}}' "$SID" "$WORK/proj" | python3 lib/graph/attach_evidence.py)
nea=$(echo "$rep" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['hookSpecificOutput'].get('updatedInput',{}).get('evidence',[])))" 2>/dev/null || echo 0)
check "A's report carries A's 2 records and none of B's (got $nea)" '[ "$nea" -eq 2 ]'
check "A's report does not carry B's command" 'echo "$rep" | grep -q "go test ./a" && ! echo "$rep" | grep -q "go test ./b"'
nb2=$(evlines agent-B)
check "A reporting did not clear B's evidence (got $nb2)" '[ "$nb2" -eq 1 ]'
rm -rf "$CLAUDE_PLUGIN_DATA/evidence" "$CLAUDE_PLUGIN_DATA/runs"

# --- the Enforcer OAuth sign-in instead of a key
# No GRAPH_API_KEY: the hooks read ~/.enforcer/credentials.json, the file
# /enforcer:login writes, and refresh it when the access token is close to expiry.
EH="$WORK/enforcer"; mkdir -p "$EH"
creds() { # $1 access token, $2 expires_at
  printf '{"enforcer":{"base_url":"http://127.0.0.1:%s","oauth":{"access_token":"%s","refresh_token":"rt-1","expires_at":"%s","token_endpoint":"http://127.0.0.1:%s/token","client_id":"mcp_test","scope":"enforcer:read"}}}\n' "$PORT" "$1" "$2" "$PORT" > "$EH/credentials.json"
}
mkdir -p "$WORK/oproj/.enforcer"; printf '{"graph_id":"g1"}\n' > "$WORK/oproj/.enforcer/graph.json"
ohook() { printf '%s' "$2" | env -u GRAPH_API_KEY -u ENFORCER_API_KEY ENFORCER_HOME="$EH" python3 "lib/graph/$1"; }
start="{\"session_id\":\"$SID\",\"cwd\":\"$WORK/oproj\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}"

creds stub-token 2099-01-01T00:00:00.000Z
out=$(ohook session_start.py "$start")
check "oauth: a signed-in machine needs no key (base_url from the sign-in)" 'echo "$out" | grep -q "frontier (runnable now"'

creds expired-token 2000-01-01T00:00:00.000Z
out=$(ohook session_start.py "$start")
check "oauth: an expired token is refreshed and the call succeeds" 'echo "$out" | grep -q "frontier (runnable now"'
check "oauth: the rotated pair is written back" 'grep -q "\"access_token\": \"stub-token-2\"" "$EH/credentials.json" && grep -q "\"refresh_token\": \"rt-2\"" "$EH/credentials.json"'
check "oauth: the file stays 0600" '[ "$(stat -c %a "$EH/credentials.json")" = 600 ]'
check "oauth: the refresh used the refresh_token grant" 'grep -q "\"grant_type\": \"refresh_token\"" "$STUB_LOG"'

creds expired-token 2000-01-01T00:00:00.000Z
python3 - "$EH/credentials.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["enforcer"]["oauth"]["refresh_token"]="revoked"; json.dump(d,open(p,"w"))
PY
out=$(ohook session_start.py "$start")
check "oauth: a refused refresh fails open (silent)" '[ -z "$out" ]'

rm -f "$EH/credentials.json"
out=$(ohook session_start.py "$start")
check "oauth: signed out and no key is silent" '[ -z "$out" ]'

# --- graph tools are recognised under every server name that carries them
for name in mcp__plugin_enforcer_enforcer__graph_next_work mcp__enforcer__graph_next_work mcp__enforcer-graph__graph_next_work; do
  in=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":sys.argv[2],"tool_input":{},"tool_response":sys.argv[3]}))' "$SID" "$name" "$card")
  rm -f "$runfile"; hook track_run.py "$in"
  check "track_run: $name writes the run file" '[ -s "$runfile" ]'
done
rm -f "$runfile"
check "hooks.json matchers cover all three server names, and nothing else" 'python3 - <<PY
import json,re
d=json.load(open("hooks/hooks.json"))["hooks"]
pre=[m["matcher"] for m in d["PreToolUse"] if "graph_" in m["matcher"]][0]
post=[m["matcher"] for m in d["PostToolUse"] if "graph_" in m["matcher"]][0]
for s in ("plugin_enforcer_enforcer","enforcer","enforcer-graph"):
    assert re.fullmatch(pre,"mcp__%s__graph_report"%s) and re.fullmatch(pre,"mcp__%s__graph_remember"%s)
    for t in ("next_work","report","heartbeat"): assert re.fullmatch(post,"mcp__%s__graph_%s"%(s,t))
assert not re.fullmatch(pre,"mcp__other__graph_report") and not re.fullmatch(post,"mcp__enforcer__enforcer_whoami")
PY'
check "heartbeat: skips graph tools under the plugin server name too" 'python3 -c "import sys;sys.path.insert(0,\"lib/graph\");import lib;assert lib.is_graph_tool(\"mcp__plugin_enforcer_enforcer__graph_report\") and not lib.is_graph_tool(\"Bash\")"'
check "attach: the attach hook's timeout covers the upload budget and the PR check" 'python3 -c "
import json
d=json.load(open(\"hooks/hooks.json\"))[\"hooks\"][\"PreToolUse\"]
t=[h[\"timeout\"] for m in d for h in m[\"hooks\"] if \"hook pre-tool-use\" in h[\"command\"]][0]
assert t >= 25, t"'

# --- full outputs beyond the clip go to the user's enforcer-files (adapter-files)
check "attach: full outputs upload to enforcer-files, and every failure leaves the item as it was (unittest)" \
  'env -u GRAPH_API_KEY -u CLAUDE_PLUGIN_DATA python3 -m unittest discover -s test -p "test_*.py" 2>&1 | tail -3 | grep -q "^OK"'

# --- the skill every worker loads: real tools and params, and the worker rule kept
check "skill: frontmatter names the skill, description within 1024 chars" 'python3 test/check_skill.py frontmatter'
check "skill: names only real graph tools, with their real params" 'python3 test/check_skill.py tools'
check "skill: keeps the worker rule, evidence, stale-acceptance, merge and coordinator rules" 'python3 test/check_skill.py rules'
check "skill: the enforcer-files upload command it gives exists and takes --dir" 'python3 test/check_skill.py upload'
check "agent: graph-worker has name, sonnet, tool allowlist for all three server prefixes, no api_write" 'python3 test/check_skill.py agent'
check "plan: a node that says 'see plan section' or a brief over 5 files / 30 KB is rejected; skill and agent state the budget" 'python3 test/check_skill.py plan'

# --- bin/graph-dispatch: tier -> model, contested resources, dry run, drain, merge by script
dispatch_out=$(env -u GRAPH_API_KEY -u GRAPH_AUTH_HELPER python3 -m unittest discover -s test -p "test_dispatch.py" -v 2>&1)
check "dispatch: tier -> model (mechanical/standard sonnet, deep opus, user tier beats the cap, explicit model wins)" \
  'echo "$dispatch_out" | grep -E "^test_(tiers|cap_applies_to_planner_tier|user_tier_wins_over_cap|explicit_model_wins) .* ok$" | wc -l | grep -qx 4'
check "dispatch: never two workers on one data.resources value; one land-pr per repo" \
  'echo "$dispatch_out" | grep -E "^test_(never_two_on_one_value|held_elsewhere_blocks|one_land_per_repo|held_elsewhere_counts_live_runs_not_lapsed) .* ok$" | wc -l | grep -qx 4'
check "dispatch: dry run launches nothing; stop file drains; a denied graph tool drains; merge landed by script" \
  'echo "$dispatch_out" | grep -E "^test_(dry_run_launches_nothing|stop_file_drains|denied_graph_tool_blocks_and_drains|merge_landed_by_script) .* ok$" | wc -l | grep -qx 4'
check "dispatch: warm workers (resume in repo, life cap retires, failed resume falls back cold, affinity, one --plugin-dir each, max_turns)" \
  'echo "$dispatch_out" | grep -E "^test_(next_node_in_repo_resumes_the_session|session_life_cap_retires|session_usable_caps|failed_resume_falls_back_to_cold|affinity_prefers_warm_repo|one_plugin_dir_each_and_max_turns) .* ok$" | wc -l | grep -qx 6'
check "dispatch: failure -> remediation launch (resumed, error + last_rejection) -> triage; at most 2 attempts + 1 triage" \
  'echo "$dispatch_out" | grep -E "^test_(failure_then_remediation_then_triage|bounded_two_attempts_one_triage|failed_outcome|no_triage_flag|ordinary_failure_is_still_relaunched) .* ok$" | wc -l | grep -qx 5'
check "dispatch: lease (second dispatcher refuses unless --takeover), transient retry, triage grace, scout/milestone/ops default" \
  'echo "$dispatch_out" | grep -E "^test_(second_dispatcher_refuses_unless_takeover|expired_lease_is_taken_and_lease_node_is_never_work|defaults_include_scout_milestone_ops_not_gate|api_retries_transient_errors_then_succeeds|network_error_never_crashes_a_pass|sh_retries_transient_gh_failure|triage_waits_grace_and_rechecks_status) .* ok$" | wc -l | grep -qx 7'
check "dispatch: triage outcomes revise / prerequisite / gate write the graph; a triage never reports the failed node" \
  'echo "$dispatch_out" | grep -E "^test_(triage_revise|triage_prerequisite|triage_gate|triage_that_reports_the_failed_node_applies_nothing|invalid_decision_applies_nothing) .* ok$" | wc -l | grep -qx 5'
check "agent + skill: a structured graph_remember before any failed report; the remediation/triage loop documented" \
  'grep -q "Before ANY \`failed\` report, \`graph_remember\`" agents/graph-worker.md && grep -q "^## When a node fails: remember, remediate, triage" skills/graph/SKILL.md'
check "dispatch: --help works and names the flags" './bin/graph-dispatch --help | grep -q -- "--workers"'

# --- client attestation: every claim, heartbeat and report says hooks=on (X-Graph-Client, enforcer-graph 089)
ver=$(python3 -c 'import json;print(json.load(open("plugin.json"))["version"])')
want="enforcer-graph-plugin/$ver; hooks=on"
for t in next_work heartbeat report; do
  for pre in mcp__plugin_enforcer_enforcer__ mcp__enforcer__ mcp__enforcer-graph__; do
    out=$(hook attach_evidence.py "{\"session_id\":\"client-$t\",\"tool_name\":\"${pre}graph_$t\",\"tool_input\":{\"graph\":\"g1\",\"client\":\"made-up\"}}")
    check "client: stamped on ${pre}graph_$t" 'echo "$out" | W="$want" python3 -c "
import json,os,sys; u=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"]
sys.exit(0 if u.get(\"client\")==os.environ[\"W\"] and u.get(\"graph\")==\"g1\" else 1)"'
  done
done
out=$(hook attach_evidence.py "{\"session_id\":\"client-r\",\"tool_name\":\"mcp__plugin_enforcer_enforcer__graph_remember\",\"tool_input\":{\"graph\":\"g1\"}}")
check "client: not stamped on graph_remember (it takes no client)" '! echo "$out" | grep -q "hooks=on"'
out=$(hook attach_evidence.py "{\"session_id\":\"client-p\",\"tool_name\":\"mcp__plugin_enforcer_enforcer__graph_plan_status\",\"tool_input\":{\"graph\":\"g1\"}}")
check "client: other graph tools are left alone" '[ -z "$out" ]'
out=$(GRAPH_EVIDENCE_MODE=context hook attach_evidence.py "{\"session_id\":\"client-c\",\"tool_name\":\"mcp__plugin_enforcer_enforcer__graph_next_work\",\"tool_input\":{\"graph\":\"g1\"}}")
check "client: context mode (rewrites not applied) does not pretend to stamp" '! echo "$out" | grep -q updatedInput'
check "client: hooks.json routes next_work, heartbeat and report through the stamping hook" 'python3 -c "
import json,re; m=[h[\"matcher\"] for h in json.load(open(\"hooks/hooks.json\"))[\"hooks\"][\"PreToolUse\"] if any(\"hook pre-tool-use\" in x[\"command\"] for x in h[\"hooks\"])][0]
import sys; sys.exit(0 if all(re.fullmatch(m, p+\"graph_\"+t) for p in (\"mcp__plugin_enforcer_enforcer__\",\"mcp__enforcer__\",\"mcp__enforcer-graph__\") for t in (\"next_work\",\"heartbeat\",\"report\")) else 1)"'
SID2=client-hb; rf2="$CLAUDE_PLUGIN_DATA/runs/$SID2.json"
in=$(python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{},"tool_response":sys.argv[2]}))' "$SID2" "$card")
hook track_run.py "$in"; : > "$STUB_LOG"; rm -f "$STUB_LOG.hb"
for i in 1 2 3 4 5 6 7 8 9 10; do hook heartbeat.py "{\"session_id\":\"$SID2\",\"cwd\":\"$WORK/proj\",\"tool_name\":\"Bash\",\"tool_input\":{}}" >/dev/null; done
check "client: the hook's own HTTP heartbeat sends X-Graph-Client" 'W="$want" python3 -c "
import json,os,sys; r=[json.loads(l) for l in open(sys.argv[1]) if \"/heartbeat\" in l]
sys.exit(0 if r and all(x.get(\"client\")==os.environ[\"W\"] for x in r) else 1)" "$STUB_LOG"'
rm -f "$rf2"

# --- session_start version check: one line per mismatch, silent when aligned, workspace from the credential
MK="$WORK/mkt"; mkdir -p "$MK/$CPD" "$MK/enforcer-graph/$CPD" "$MK/enforcer/$CPD" "$CLAUDE_CONFIG_DIR/plugins" "$ENFORCER_HOME"
printf '{"name":"instruxi","plugins":[{"name":"enforcer","source":"./enforcer"},{"name":"enforcer-graph","source":"./enforcer-graph"},{"name":"gov","source":{"source":"github","repo":"x/y"}}]}' > "$MK/$CPD/marketplace.json"
printf '{"name":"enforcer-graph","version":"9.1.0"}' > "$MK/enforcer-graph/$CPD/plugin.json"
printf '{"name":"enforcer","version":"0.5.0"}' > "$MK/enforcer/$CPD/plugin.json"
printf '{"instruxi":{"installLocation":"%s"}}' "$MK" > "$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json"
printf '{"version":2,"plugins":{"enforcer-graph@instruxi":[{"scope":"user","version":"0.15.0"},{"scope":"local","version":"0.13.0"},{"scope":"project","version":"9.1.0"}]}}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
python3 -c 'import json;print(json.dumps({"version":"0.9.14","tools":json.load(open("lib/graph/known_tools.json"))}))' > "$STUB_HEALTH_FILE"
ss() { hook session_start.py "{\"session_id\":\"$SID\",\"cwd\":\"/\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}"; }
out=$(ss); raw="$out"; out=$(echo "$raw" | python3 -c "import json,sys; print(json.load(sys.stdin)['systemMessage'])")
check "version check: one line per stale install, with scope and the update command" '[ "$(echo "$out" | grep -c "^enforcer-graph .* installed (")" = 2 ] && echo "$out" | grep -q "enforcer-graph 0.15.0 installed (user) — 9.1.0 available: claude plugin update enforcer-graph@instruxi" && echo "$out" | grep -q "enforcer-graph 0.13.0 installed (local) — 9.1.0 available"'
check "version check: an install at the marketplace version is not reported" '! echo "$out" | grep -q "9.1.0 installed"'
check "version check: enforcer-graph without enforcer is told exactly what to install" 'echo "$out" | grep -q "claude plugin install enforcer@instruxi"'
check "version check: notices reach the person (systemMessage)" 'echo "$raw" | grep -q systemMessage'
out=$(ss)
check "version check: each notice is said once" '[ -z "$out" ]'
printf '{"version":2,"plugins":{"enforcer-graph@instruxi":[{"version":"9.1.0","auto":true}],"enforcer@instruxi":[{"version":"0.5.0"}]}}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
rm -f "$CLAUDE_PLUGIN_DATA/notices.json"; out=$(ss)
check "version check: aligned (no credential), nothing to say" '[ -z "$out" ]'
python3 -c 'import json;print(json.dumps({"version":"0.9.14","tools":json.load(open("lib/graph/known_tools.json"))+["workspace_list","workspace_switch","zeta"]}))' > "$STUB_HEALTH_FILE"
rm -f "$CLAUDE_PLUGIN_DATA/notices.json"; out=$(ss | python3 -c "import json,sys; print(json.load(sys.stdin)['systemMessage'])")
check "version check: MCP tools the plugin does not know are one line" '[ "$(echo "$out" | grep -c "^MCP ")" = 1 ] && echo "$out" | grep -q "MCP 0.9.14 serves tools this plugin (.*) does not know: workspace_\*, zeta"'
python3 -c 'import json;print(json.dumps({"version":"0.9.14","tools":json.load(open("lib/graph/known_tools.json"))}))' > "$STUB_HEALTH_FILE"
JWT=$(python3 -c 'import base64,json;e=lambda d:base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=");print(e({"alg":"none"})+"."+e({"tenant":"Acme","tenant_id":"t-1","role":"admin"})+".x")')
printf '{"enforcer":{"oauth":{"access_token":"%s","expires_at":"2099-01-01T00:00:00Z"}}}' "$JWT" > "$ENFORCER_HOME/credentials.json"
rm -f "$CLAUDE_PLUGIN_DATA/notices.json"; out=$(ss)
check "version check: prints the credential's workspace" '[ "$out" = "enforcer workspace: Acme (t-1) · role admin" ]'
rm -rf "$CLAUDE_CONFIG_DIR/plugins" "$ENFORCER_HOME"


# --- evidence merge and run scoping (0.19.0)
MS=mrg
mrun() { printf '%s' "$1" > "$CLAUDE_PLUGIN_DATA/runs/$MS.json"; }
mbash() { python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"Bash","tool_input":{"command":sys.argv[2]},"tool_response":{"stdout":sys.argv[3],"stderr":"","interrupted":False}}))' "$MS" "$1" "$2"; }
mrep() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps({"session_id":sys.argv[1],"tool_name":"mcp__enforcer-graph__graph_report","tool_input":{"report":"x","evidence":json.loads(sys.stdin.read())}}))' "$MS" | python3 lib/graph/attach_evidence.py; }
rm -f "$CLAUDE_PLUGIN_DATA/evidence/$MS.jsonl"
mrun '{"graph_id":"g","node_id":"n","run_id":"rA","key":"a"}'
cap "$(mbash 'echo cap-one' 'cap-one')"; cap "$(mbash 'echo cap-two' 'cap-two')"
eight=$(python3 -c 'import json;print(json.dumps([{"kind":"command","cmd":"worker-%d"%i,"exit":0,"output":"passed %d"%i} for i in range(8)]))')
out=$(mrep "$eight")
check "merge: 8 passed records plus 2 captured leave 10, none with output dropped" 'echo "$out" | python3 -c "
import json,sys
e=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"]
w=[x for x in e if x.get(\"cmd\",\"\").startswith(\"worker-\")]
sys.exit(0 if len(e)==10 and len(w)==8 and all(x[\"output\"] for x in w) and e[0][\"cmd\"]==\"echo cap-one\" else 1)"'
dup=$(python3 -c 'import json;print(json.dumps([{"kind":"command","cmd":"echo cap-one","exit":0,"output":"cap-one"},{"kind":"command","cmd":"w","exit":0,"output":"o"}]))')
out=$(mrep "$dup")
check "merge: a passed record duplicating a captured cmd+exit is deduped" 'echo "$out" | python3 -c "
import json,sys
e=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"]
sys.exit(0 if len(e)==3 and sum(1 for x in e if x.get(\"cmd\")==\"echo cap-one\")==1 else 1)"'
check "capture: Bash results are {kind:command, cmd, exit, output} and carry no run tag after attach" 'echo "$out" | python3 -c "
import json,sys
e=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"][0]
sys.exit(0 if e[\"kind\"]==\"command\" and e[\"exit\"]==0 and e[\"output\"]==\"cap-one\" and \"_run\" not in e else 1)"'
# gates survive the bound
rm -f "$CLAUDE_PLUGIN_DATA/evidence/$MS.jsonl"
cap "$(mbash 'bash scripts/verify.sh' 'VERIFY OK')"
for i in $(seq 1 30); do cap "$(mbash "ls dir-$i" "x")"; done
out=$(mrep '[]')
check "capture: under the cap the oldest deciding gate (verify.sh) is kept" 'echo "$out" | python3 -c "
import json,sys
e=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"]
sys.exit(0 if len(e)==20 and any(x.get(\"cmd\")==\"bash scripts/verify.sh\" for x in e) else 1)"'
# a PR URL in a tool result
rm -f "$CLAUDE_PLUGIN_DATA/evidence/$MS.jsonl"
cap "$(mbash 'gh pr create' 'https://github.com/instruxi-io/claude-plugins/pull/31')"
out=$(mrep '[]')
check "capture: a PR URL in a tool result is attached as an artifact record" 'echo "$out" | python3 -c "
import json,sys
e=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"]
sys.exit(0 if any(x.get(\"kind\")==\"artifact\" and x.get(\"url\")==\"https://github.com/instruxi-io/claude-plugins/pull/31\" for x in e) else 1)"'
# scoping: a claim starts a clean capture, and another run's records are never attached
cap "$(mbash 'echo other-nodes-work' 'x')"
printf '%s' '{"session_id":"mrg","tool_name":"mcp__enforcer-graph__graph_next_work","tool_input":{"graph":"g"},"tool_response":{"state":"claimed","graph_id":"g","node":{"node_id":"nB","key":"b"},"run":{"run_id":"rB","lease_expires_at":"2099-01-01T00:00:00Z"}}}' | python3 lib/graph/track_run.py
cap "$(mbash 'echo mine-only' 'mine')"
out=$(mrep '[]')
check "scope: results from before this run's claim are not attached" 'echo "$out" | python3 -c "
import json,sys
e=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"][\"evidence\"]
sys.exit(0 if [x[\"cmd\"] for x in e]==[\"echo mine-only\"] else 1)"'
mrun '{"graph_id":"g","node_id":"nB","run_id":"rB","key":"b"}'
printf '%s\n' '{"kind":"command","cmd":"stale-from-rA","exit":0,"output":"z","_run":"rA"}' >> "$CLAUDE_PLUGIN_DATA/evidence/$MS.jsonl"
out=$(mrep '[]')
check "scope: a record tagged with another run is never attached" 'echo "$out" | grep -qv stale-from-rA && echo "$out" | grep -q mine-only'

node test/hooks.test.mjs >/dev/null 2>&1; check "hooks gate: actor key + graph tools ungated (node)" "[ \$? -eq 0 ]"
echo; echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]
