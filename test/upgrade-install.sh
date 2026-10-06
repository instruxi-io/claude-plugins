#!/usr/bin/env bash
# An EXISTING install (enforcer only, from the catalog before enforcer depended
# on enforcer-graph) updated to this checkout: the update pulls the hooks in.
# Then the case that fails closed: enforcer-graph turned off by hand.
# Throwaway CLAUDE_CONFIG_DIR and marketplace copy; never touches ~/.claude.
#   bash test/upgrade-install.sh [old-ref]    default: origin/main
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; OLD="${1:-origin/main}"
export CLAUDE_CONFIG_DIR="$(mktemp -d /tmp/cc-upgrade-XXXX)"; MK="$(mktemp -d /tmp/mk-upgrade-XXXX)"
trap 'rm -rf "$CLAUDE_CONFIG_DIR" "$MK"' EXIT
git -C "$REPO" archive "$OLD" | tar -x -C "$MK"
claude plugin marketplace add "$MK" >/dev/null 2>&1
echo "\$ claude plugin install enforcer@instruxi   # catalog at $OLD"; claude plugin install enforcer@instruxi 2>&1 | tail -1
claude plugin list 2>&1 | grep -A3 "❯"
# The marketplace moves to this checkout (as a marketplace update would bring it).
rm -rf "$MK"/* "$MK"/.claude-plugin; (cd "$REPO" && tar -c --exclude=.git .) | tar -x -C "$MK"
claude plugin marketplace update instruxi >/dev/null 2>&1 || true
echo "\$ claude plugin update enforcer@instruxi"; claude plugin update enforcer@instruxi 2>&1 | tail -1
echo "\$ claude plugin list"; claude plugin list 2>&1 | grep -A4 "❯"
# `plugin update` does not install a NEW dependency; re-running install does
# (as do /reload-plugins and the marketplace's auto-update, per the docs).
echo "\$ claude plugin install enforcer@instruxi"; claude plugin install enforcer@instruxi 2>&1 | tail -1
echo "\$ claude plugin list"; claude plugin list 2>&1 | grep -A4 "❯"
node -e "
const fs=require('fs'),p=require('path').join(process.env.CLAUDE_CONFIG_DIR,'settings.json');const d=JSON.parse(fs.readFileSync(p,'utf8'));
(d.enabledPlugins??={})['enforcer-graph@instruxi']=false;fs.writeFileSync(p,JSON.stringify(d,null,2))"
echo "# enforcer-graph@instruxi set to false by hand in settings.json"
echo "\$ claude plugin list"; claude plugin list 2>&1 | grep -A4 "❯"
