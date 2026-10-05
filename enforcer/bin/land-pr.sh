#!/usr/bin/env bash
# land-pr.sh <pr> [-R owner/repo] [--timeout SECONDS]
#
# Lands one pull request with no model in the loop: queue a squash auto-merge,
# keep the branch current while the base moves, and stop with a code that says
# exactly what is left. Made for a base branch that requires branches to be up
# to date, where GitHub itself refuses a stale or red merge.
#
#   0  merged — prints the end-state evidence (gh pr view + merge-base check)
#   2  CI failed on the PR's head — prints the failing checks; needs a fix
#   3  conflicts with the base — needs a rebase by someone who reads both sides
#   4  timed out still waiting
#   5  usage / gh error
#
# Polling here costs nothing; it is a shell loop, not an agent re-reading state.
set -uo pipefail

pr="" repo=() timeout=3600
while [ $# -gt 0 ]; do
  case "$1" in
    -R) repo=(-R "$2"); shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) pr="$1"; shift ;;
  esac
done
[ -n "$pr" ] || { echo "usage: land-pr.sh <pr> [-R owner/repo] [--timeout s]" >&2; exit 5; }

view() { gh pr view "$pr" "${repo[@]}" --json "$1" --jq "$2" 2>/dev/null; }

state=$(view state .state) || { echo "land-pr: cannot read PR $pr" >&2; exit 5; }

# GitHub enforces "green before merge" only on a branch whose protection
# requires checks; everywhere else `--auto` is refused or merges at once. So
# queue --auto only where it is enforced, and otherwise merge ourselves once
# every check on the head commit has finished green — never before. (A repo
# with no protection merged a red PR on 2026-10-01 through the old fallback.)
manual=1
if [ "$state" = "OPEN" ]; then
  nwo=$(gh repo view "${repo[@]:1}" --json nameWithOwner --jq .nameWithOwner 2>/dev/null)
  base=$(view baseRefName .baseRefName)
  required=$(gh api "repos/$nwo/branches/$base/protection" --jq '.required_status_checks.checks | length' 2>/dev/null)
  case "$required" in ''|*[!0-9]*) required=0 ;; esac  # 404 = unprotected; its body is not a count
  if [ "$required" -gt 0 ] && gh pr merge "$pr" "${repo[@]}" --squash --auto --delete-branch >/dev/null 2>&1; then
    manual=0
  fi
elif [ "$state" != "MERGED" ]; then
  echo "land-pr: PR $pr is $state" >&2; exit 5
fi

# Checks on the head commit, from both check runs and commit statuses.
ROLLUP='.statusCheckRollup // [] | map({n: (.name // .context), done: ((.status // "COMPLETED") == "COMPLETED" and (.state // "") != "PENDING" and (.state // "") != "EXPECTED"), bad: ((.conclusion // .state // "") as $c | ["FAILURE","CANCELLED","TIMED_OUT","ACTION_REQUIRED","ERROR","STARTUP_FAILURE"] | index($c) != null)})'

start=$(date +%s); deadline=$(( start + timeout ))
last=""
while :; do
  state=$(view state .state)
  [ "$state" = "MERGED" ] && break
  ms=$(view mergeStateStatus .mergeStateStatus)
  if [ "$ms" != "$last" ]; then echo "land-pr: #$pr $state / $ms"; last="$ms"; fi
  case "$ms" in
    DIRTY)
      echo "land-pr: #$pr conflicts with its base; rebase, resolve by reading both sides, re-verify, push, then run this again" >&2
      exit 3 ;;
    BEHIND)
      if ! gh pr update-branch "$pr" "${repo[@]}" >/dev/null 2>&1; then
        # A queued --auto merge can land between our read and the update; that
        # is success, not a conflict.
        [ "$(view state .state)" = "MERGED" ] && break
        echo "land-pr: #$pr is behind and could not be updated cleanly (conflict); rebase by hand" >&2; exit 3
      fi ;;
  esac
  failed=$(view statusCheckRollup "$ROLLUP | map(select(.bad) | .n) | join(\", \")")
  if [ -n "$failed" ]; then
    echo "land-pr: #$pr CI failed: $failed" >&2
    gh pr checks "$pr" "${repo[@]}" 2>&1 | grep -iv "pass\|skipping" >&2
    exit 2
  fi
  if [ "$manual" = 1 ] && [ "$ms" != "BEHIND" ] && [ "$ms" != "BLOCKED" ]; then
    total=$(view statusCheckRollup "$ROLLUP | length")
    pending=$(view statusCheckRollup "$ROLLUP | map(select(.done | not)) | length")
    # A fresh push has no checks yet; give them 90s to register before
    # treating "no checks" as "nothing to wait for".
    if [ "${pending:-1}" = 0 ] && { [ "${total:-0}" -gt 0 ] || [ $(( $(date +%s) - start )) -ge 90 ]; }; then
      head=$(view headRefOid .headRefOid)
      gh pr merge "$pr" "${repo[@]}" --squash --delete-branch --match-head-commit "$head" >/dev/null 2>&1 || true
    fi
  fi
  [ "$(date +%s)" -lt "$deadline" ] || { echo "land-pr: #$pr still $ms after ${timeout}s" >&2; exit 4; }
  sleep 15
done

# End-state evidence: what a merge node's acceptance is judged on.
gh pr view "$pr" "${repo[@]}" --json number,state,mergedAt,mergeCommit,baseRefName \
  --jq '{number,state,mergedAt,mergeCommit:.mergeCommit.oid,base:.baseRefName}'
sha=$(view mergeCommit .mergeCommit.oid); base=$(view baseRefName .baseRefName)
if git rev-parse --git-dir >/dev/null 2>&1 && git fetch -q origin "$base" 2>/dev/null; then
  if git merge-base --is-ancestor "$sha" "origin/$base"; then
    echo "git merge-base --is-ancestor $sha origin/$base -> exit 0"
  else
    echo "git merge-base --is-ancestor $sha origin/$base -> not an ancestor" >&2; exit 5
  fi
fi
exit 0
