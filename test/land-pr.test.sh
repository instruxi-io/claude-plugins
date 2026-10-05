#!/usr/bin/env bash
# Tests enforcer/bin/land-pr.sh against a fake `gh` driven by env vars.
set -u
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$here/enforcer/bin/land-pr.sh"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin" "$tmp/cwd"

cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Fake gh. Env: FAKE_STATE (pr state; MERGED once merged), FAKE_ROLLUP (json),
# FAKE_RUNS (run-list answer), FAKE_SQUASH, FAKE_COMPARE, FAKE_LOG.
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "pr view")
    case "$*" in
      *"--json number"*) echo '{"number":1,"state":"MERGED"}' ;;
      *"--json state "*) cat "$FAKE_DIR/state" ;;
      *mergeStateStatus*) echo CLEAN ;;
      *statusCheckRollup*) jq -r "${@: -1}" <<<"{\"statusCheckRollup\": $FAKE_ROLLUP}" ;;
      *headRefOid*) echo headsha ;;
      *mergeCommit*) echo mergesha ;;
      *baseRefName*) echo main ;;
    esac ;;
  "pr merge")
    if [ "$FAKE_SQUASH" = false ] && [[ "$*" == *--squash* ]]; then echo "squash disallowed" >&2; exit 1; fi
    echo MERGED > "$FAKE_DIR/state" ;;
  "repo view")
    case "$*" in
      *nameWithOwner*) echo o/r ;;
      *) echo "$FAKE_SQUASH true true" ;;
    esac ;;
  "run list") echo "${FAKE_RUNS:-0}" ;;
  "api repos/o/r/compare/main...mergesha") echo "$FAKE_COMPARE" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"

fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }
run() { # name; env set by caller; args after --
  (cd "$tmp/cwd" && PATH="$tmp/bin:$PATH" FAKE_DIR="$tmp" FAKE_LOG="$tmp/log" LAND_PR_POLL=1 \
    timeout 20 bash "$script" "$@" >"$tmp/out" 2>"$tmp/err"); echo $? > "$tmp/rc"; }
reset() { : > "$tmp/log"; echo "${1:-OPEN}" > "$tmp/state"
  export FAKE_ROLLUP='[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS"}]' FAKE_SQUASH=true FAKE_COMPARE=identical FAKE_RUNS=0; }

reset CLOSED
start=$SECONDS; run 1 -R o/r --timeout 100
[ "$(cat "$tmp/rc")" = 5 ] && [ $((SECONDS-start)) -lt 5 ] && ok "CLOSED exits 5 within one poll" || bad "CLOSED exits 5 within one poll (rc=$(cat "$tmp/rc"))"

reset
run 1 -R o/r --timeout 30
[ "$(cat "$tmp/rc")" = 0 ] && grep -q "compare/main...mergesha -> identical" "$tmp/out" \
  && ok "-R PR verifies via the compare API from an unrelated cwd" || bad "-R compare ($(cat "$tmp/rc")): $(cat "$tmp/err")"

reset
export FAKE_ROLLUP='[{"name":"ci","status":"COMPLETED","conclusion":"CANCELLED"},{"name":"ci2","status":"COMPLETED","conclusion":"SUCCESS"}]' FAKE_RUNS=1
run 1 -R o/r --timeout 30
[ "$(cat "$tmp/rc")" = 0 ] && ok "CANCELLED superseded check is tolerated" || bad "CANCELLED tolerated ($(cat "$tmp/rc")): $(cat "$tmp/err")"

reset
export FAKE_SQUASH=false
run 1 -R o/r --timeout 30
[ "$(cat "$tmp/rc")" = 0 ] && grep -q "pr merge 1 -R o/r --merge" "$tmp/log" \
  && ok "squash disallowed falls back to merge" || bad "merge fallback ($(cat "$tmp/rc")): $(cat "$tmp/err")"

reset
run 1 --timeout
[ "$(cat "$tmp/rc")" = 2 ] && grep -q usage "$tmp/err" \
  && ok "--timeout with no value exits 2 with usage" || bad "--timeout usage ($(cat "$tmp/rc"))"

exit $fail
