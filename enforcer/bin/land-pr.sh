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
#   5  gh error, PR closed unmerged, or merge not found on the base
#      (a usage error exits 2)
#
# Polling here costs nothing; it is a shell loop, not an agent re-reading state.
set -uo pipefail

usage() { echo "usage: land-pr.sh <pr> [-R owner/repo] [--timeout s]" >&2; exit 2; }
pr="" R=() timeout=3600 poll="${LAND_PR_POLL:-15}"
while [ $# -gt 0 ]; do
  case "$1" in
    -R) [ $# -ge 2 ] || usage; R=(-R "$2"); shift 2 ;;
    --timeout) [ $# -ge 2 ] || usage; timeout="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    -*) usage ;;
    *) pr="$1"; shift ;;
  esac
done
[ -n "$pr" ] || usage
case "$timeout" in ''|*[!0-9]*) usage ;; esac

# ${R[@]+...} keeps an empty array legal under set -u on bash < 4.4.
view() { gh pr view "$pr" ${R[@]+"${R[@]}"} --json "$1" --jq "$2" 2>/dev/null; }

state=$(view state .state) || { echo "land-pr: cannot read PR $pr" >&2; exit 5; }
nwo=$(gh repo view ${R[@]+"${R[1]}"} --json nameWithOwner --jq .nameWithOwner 2>/dev/null)

# Pick a merge method the repo allows: squash, then merge commit, then rebase.
method=--squash
flags=$(gh repo view ${R[@]+"${R[1]}"} --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed \
  --jq '[.squashMergeAllowed, .mergeCommitAllowed, .rebaseMergeAllowed] | map(tostring) | join(" ")' 2>/dev/null)
case "$flags" in
  "true "*) method=--squash ;;
  "false true "*) method=--merge ;;
  "false false true") method=--rebase ;;
esac

# GitHub enforces "green before merge" only on a branch whose protection
# requires checks; everywhere else `--auto` is refused or merges at once. So
# queue --auto only where it is enforced, and otherwise merge ourselves once
# every check on the head commit has finished green — never before. (A repo
# with no protection merged a red PR on 2026-10-01 through the old fallback.)
manual=1
if [ "$state" = "OPEN" ]; then
  base=$(view baseRefName .baseRefName)
  required=$(gh api "repos/$nwo/branches/$base/protection" --jq '.required_status_checks.checks | length' 2>/dev/null)
  case "$required" in ''|*[!0-9]*) required=0 ;; esac  # 404 = unprotected; its body is not a count
  if [ "$required" -gt 0 ] && gh pr merge "$pr" ${R[@]+"${R[@]}"} "$method" --auto --delete-branch >/dev/null 2>&1; then
    manual=0
  fi
elif [ "$state" != "MERGED" ]; then
  echo "land-pr: PR $pr is $state" >&2; exit 5
fi

# Checks on the head commit, from both check runs and commit statuses.
# shellcheck disable=SC2016  # jq program, not shell
ROLLUP='.statusCheckRollup // [] | map({n: (.name // .context), done: ((.status // "COMPLETED") == "COMPLETED" and (.state // "") != "PENDING" and (.state // "") != "EXPECTED"), canc: ((.conclusion // .state // "") == "CANCELLED"), bad: ((.conclusion // .state // "") as $c | ["FAILURE","TIMED_OUT","ACTION_REQUIRED","ERROR","STARTUP_FAILURE"] | index($c) != null)})'

start=$(date +%s); deadline=$(( start + timeout ))
last=""
while :; do
  state=$(view state .state)
  [ "$state" = "MERGED" ] && break
  if [ "$state" = "CLOSED" ]; then echo "land-pr: PR $pr was closed without merging" >&2; exit 5; fi
  ms=$(view mergeStateStatus .mergeStateStatus)
  if [ "$ms" != "$last" ]; then echo "land-pr: #$pr $state / $ms"; last="$ms"; fi
  case "$ms" in
    DIRTY)
      echo "land-pr: #$pr conflicts with its base; rebase, resolve by reading both sides, re-verify, push, then run this again" >&2
      exit 3 ;;
    BEHIND)
      if ! gh pr update-branch "$pr" ${R[@]+"${R[@]}"} >/dev/null 2>&1; then
        # A queued --auto merge can land between our read and the update; that
        # is success, not a conflict.
        [ "$(view state .state)" = "MERGED" ] && break
        echo "land-pr: #$pr is behind and could not be updated cleanly (conflict); rebase by hand" >&2; exit 3
      fi ;;
  esac
  failed=$(view statusCheckRollup "$ROLLUP | map(select(.bad) | .n) | join(\", \")")
  cancelled=$(view statusCheckRollup "$ROLLUP | map(select(.canc) | .n) | join(\", \")")
  if [ -n "$cancelled" ]; then
    # A cancelled check is a superseded run when a newer, non-cancelled run
    # exists for the same head; otherwise it is a real failure.
    head=$(view headRefOid .headRefOid)
    # shellcheck disable=SC2016
    newer=$(gh run list ${R[@]+"${R[@]}"} --commit "$head" --json conclusion,createdAt \
      --jq '(map(select(.conclusion=="cancelled") | .createdAt) | max) as $c | map(select(.conclusion!="cancelled" and .createdAt>$c)) | length' 2>/dev/null)
    if [ "${newer:-0}" = 0 ]; then failed="${failed:+$failed, }$cancelled"; fi
  fi
  if [ -n "$failed" ]; then
    echo "land-pr: #$pr CI failed: $failed" >&2
    gh pr checks "$pr" ${R[@]+"${R[@]}"} 2>&1 | grep -iv "pass\|skipping" >&2
    exit 2
  fi
  if [ "$manual" = 1 ] && [ "$ms" != "BEHIND" ] && [ "$ms" != "BLOCKED" ]; then
    total=$(view statusCheckRollup "$ROLLUP | length")
    pending=$(view statusCheckRollup "$ROLLUP | map(select(.done | not)) | length")
    # A fresh push has no checks yet; give them 90s to register before
    # treating "no checks" as "nothing to wait for".
    if [ "${pending:-1}" = 0 ] && { [ "${total:-0}" -gt 0 ] || [ $(( $(date +%s) - start )) -ge 90 ]; }; then
      head=$(view headRefOid .headRefOid)
      gh pr merge "$pr" ${R[@]+"${R[@]}"} "$method" --delete-branch --match-head-commit "$head" >/dev/null 2>&1 || true
    fi
  fi
  [ "$(date +%s)" -lt "$deadline" ] || { echo "land-pr: #$pr still $ms after ${timeout}s" >&2; exit 4; }
  sleep "$poll"
done

# End-state evidence: what a merge node's acceptance is judged on.
gh pr view "$pr" ${R[@]+"${R[@]}"} --json number,state,mergedAt,mergeCommit,baseRefName \
  --jq '{number,state,mergedAt,mergeCommit:.mergeCommit.oid,base:.baseRefName}'
sha=$(view mergeCommit .mergeCommit.oid); base=$(view baseRefName .baseRefName)
if [ ${#R[@]} -gt 0 ]; then
  # A -R PR may have no local checkout: ask the PR's own repo, not the cwd's.
  cmp=$(gh api "repos/$nwo/compare/$base...$sha" --jq .status 2>/dev/null)
  case "$cmp" in
    identical|behind) echo "gh api repos/$nwo/compare/$base...$sha -> $cmp" ;;
    *) echo "gh api repos/$nwo/compare/$base...$sha -> '$cmp' (merge not on $base)" >&2; exit 5 ;;
  esac
elif git rev-parse --git-dir >/dev/null 2>&1 && git fetch -q origin "$base" 2>/dev/null; then
  if git merge-base --is-ancestor "$sha" "origin/$base"; then
    echo "git merge-base --is-ancestor $sha origin/$base -> exit 0"
  else
    echo "git merge-base --is-ancestor $sha origin/$base -> not an ancestor" >&2; exit 5
  fi
fi
exit 0
