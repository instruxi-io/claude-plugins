#!/usr/bin/env bash
# Run a command under a private HOME/TMPDIR with no harness or sign-in environment.
# Usage: test/isolated.sh cmd args...
D="$(mktemp -d)"; mkdir -p "$D/home"
trap 'rm -r -f "$D"' EXIT
for k in $(env | cut -d= -f1 | grep -E '^(ENFORCER_|JEV_HOOKS_|GRAPH_|CLAUDE_PLUGIN_|TYPESAFE_)'); do unset "$k"; done
export HOME="$D/home" TMPDIR="$D" npm_config_cache="$D/npm-cache"
export ISOLATED_TEST_RUN="${ISOLATED_TEST_RUN:-}"
"$@"
