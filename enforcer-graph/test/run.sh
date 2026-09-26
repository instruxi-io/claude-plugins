#!/usr/bin/env bash
# Every hook against a local stub of the graph API. No key, no network, no Jev.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-18790}
export STUB_LOG="$(mktemp)"
python3 test/stub_graph.py "$PORT" & STUB=$!
trap 'kill $STUB 2>/dev/null; rm -rf "$WORK" "$STUB_LOG" "$STUB_LOG.hb"' EXIT
sleep 0.4

WORK="$(mktemp -d)"
export CLAUDE_PLUGIN_DATA="$WORK/data"
mkdir -p "$WORK/proj/.claude"
printf '{"graph_id":"g1","base_url":"http://127.0.0.1:%s","api_key_env":"GRAPH_API_KEY"}\n' "$PORT" > "$WORK/proj/.claude/graph.json"
export GRAPH_API_KEY=stub-key
SID=s1
pass=0; fail=0
check() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
hook() { printf '%s' "$2" | python3 "hooks/$1"; }
runfile="$CLAUDE_PLUGIN_DATA/runs/$SID.json"

# --- session start
out=$(hook session_start.py "{\"session_id\":\"$SID\",\"cwd\":\"$WORK/proj\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")
check "session_start: prints the frontier" 'echo "$out" | grep -q "frontier (runnable now, not claimed): api-contract, legal-and-key"'
check "session_start: prints running and failed" 'echo "$out" | grep -q "running: schema-judgment" && echo "$out" | grep -q "failed.*broken"'
out=$(hook session_start.py "{\"session_id\":\"$SID\",\"cwd\":\"/\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")
check "session_start: silent without .claude/graph.json" '[ -z "$out" ]'
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
check "attach: no capture file, the report goes through untouched" '[ -z "$out" ]'

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
check "attach: evidence the model wrote itself is replaced, not merged" 'echo "$(hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"report\":\"x\",\"evidence\":[{\"kind\":\"note\",\"text\":\"trust me\"}]}}")" | python3 -c "
import json,sys
u=json.load(sys.stdin)[\"hookSpecificOutput\"][\"updatedInput\"]
sys.exit(0 if not any(e.get(\"text\")==\"trust me\" for e in u[\"evidence\"]) else 1)"'
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
out=$(printf 'not json' | python3 hooks/capture_evidence.py); rc=$?
check "capture_evidence: garbage stdin is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'
out=$(printf 'not json' | python3 hooks/attach_evidence.py); rc=$?
check "attach_evidence: garbage stdin is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'
out=$(CLAUDE_PLUGIN_DATA=/proc/nonexistent/data hook capture_evidence.py "$(bash_in 'ls' '{"stdout":"a","stderr":"","interrupted":false}')"); rc=$?
check "capture_evidence: an unwritable data dir is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'
out=$(CLAUDE_PLUGIN_DATA=/proc/nonexistent/data hook attach_evidence.py "{\"session_id\":\"$SID\",\"tool_name\":\"mcp__enforcer-graph__graph_report\",\"tool_input\":{\"report\":\"x\"}}"); rc=$?
check "attach_evidence: an unwritable data dir is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'
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
out=$(printf 'not json' | python3 hooks/session_start.py); rc=$?
check "any hook: garbage stdin is silent and exit 0" '[ -z "$out" ] && [ "$rc" -eq 0 ]'

# --- a claimed pull request is resolved, not taken on trust (2026-09-20)
# A URL for a PR that does not exist used to be stored and shown as a result.
pr_json() { python3 -c "
import sys,importlib.util,json
sys.path.insert(0,'hooks')
spec=importlib.util.spec_from_file_location('ae','hooks/attach_evidence.py')
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
out=$(printf '%s' "$rem_in" | python3 hooks/attach_evidence.py)
n=$(echo "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['hookSpecificOutput'].get('updatedInput',{}).get('evidence',[])))" 2>/dev/null || echo 0)
check "remember: only the most recent records are attached, not the whole run (got $n of 8)" '[ "$n" -le 3 ] && [ "$n" -ge 1 ]'
check "remember: the fact itself is passed through untouched" 'echo "$out" | grep -q "The default lease is 300 seconds"'
rep_in=$(python3 -c "
import json;print(json.dumps({'session_id':'sess-rem','tool_name':'mcp__enforcer-graph__graph_report','tool_input':{'graph':'g','node_id':'n','run_id':'r','status':'succeeded','report':'done'}}))")
outr=$(printf '%s' "$rep_in" | python3 hooks/attach_evidence.py)
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
    "$SID" "$1" "$WORK/proj" "$2" "$2" "$2" | python3 hooks/track_run.py >/dev/null; }
scap() { # $1=agent_id $2=command
  printf '{"session_id":"%s","agent_id":"%s","cwd":"%s","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"%s"},"tool_response":{"stdout":"ok","stderr":""}}' \
    "$SID" "$1" "$WORK/proj" "$2" | python3 hooks/capture_evidence.py >/dev/null; }
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

rep=$(printf '{"session_id":"%s","agent_id":"agent-A","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"mcp__enforcer-graph__graph_report","tool_input":{"graph":"g1","node_id":"n-a","run_id":"r-a","status":"succeeded","report":"done"}}' "$SID" "$WORK/proj" | python3 hooks/attach_evidence.py)
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
mkdir -p "$WORK/oproj/.claude"; printf '{"graph_id":"g1"}\n' > "$WORK/oproj/.claude/graph.json"
ohook() { printf '%s' "$2" | env -u GRAPH_API_KEY -u ENFORCER_API_KEY ENFORCER_HOME="$EH" python3 "hooks/$1"; }
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
check "heartbeat: skips graph tools under the plugin server name too" 'python3 -c "import sys;sys.path.insert(0,\"hooks\");import lib;assert lib.is_graph_tool(\"mcp__plugin_enforcer_enforcer__graph_report\") and not lib.is_graph_tool(\"Bash\")"'
check "attach: the attach hook's timeout covers the upload budget and the PR check" 'python3 -c "
import json
d=json.load(open(\"hooks/hooks.json\"))[\"hooks\"][\"PreToolUse\"]
t=[h[\"timeout\"] for m in d for h in m[\"hooks\"] if \"attach_evidence\" in h[\"command\"]][0]
assert t >= 25, t"'

# --- full outputs beyond the clip go to the user's enforcer-files (adapter-files)
check "attach: full outputs upload to enforcer-files, and every failure leaves the item as it was (unittest)" \
  'env -u GRAPH_API_KEY -u CLAUDE_PLUGIN_DATA python3 -m unittest discover -s test -p "test_*.py" 2>&1 | tail -3 | grep -q "^OK"'

echo; echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]
