#!/usr/bin/env bash
# No-credential proof of the remote MCP OAuth path (no Claude client involved).
set -euo pipefail
BASE="${MCP_BASE:-https://api.instruxi.dev}"
fail() { echo "FAIL: $*" >&2; exit 1; }

hdrs=$(curl -si -X POST "$BASE/mcp" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | tr -d '\r')
echo "$hdrs" | head -1 | grep -q ' 401' || fail "initialize without credential is not 401"
wa=$(echo "$hdrs" | grep -i '^www-authenticate:') || fail "no WWW-Authenticate"
echo "$wa"
echo "$wa" | grep -q 'resource_metadata="' || fail "WWW-Authenticate lacks resource_metadata"

prm=$(curl -sf "$BASE/.well-known/oauth-protected-resource/mcp") || fail "protected-resource metadata"
echo "$prm"
asm=$(curl -sf "$BASE/.well-known/oauth-authorization-server") || fail "authorization-server metadata"
echo "$asm"

for k in resource authorization_servers; do echo "$prm" | jq -e ".$k" >/dev/null || fail "resource metadata lacks $k"; done
echo "$prm" | jq -e '.scopes_supported|index("enforcer:read")' >/dev/null || fail "resource metadata lacks enforcer scopes"
for k in authorization_endpoint token_endpoint; do echo "$asm" | jq -e ".$k" >/dev/null || fail "AS metadata lacks $k"; done
echo "$asm" | jq -e '.scopes_supported|map(select(startswith("enforcer:")))|length>0' >/dev/null || fail "AS metadata lacks enforcer scopes"
echo "OK"
