#!/bin/bash
# Add this machine's logged-in Claude Code account to accounts.json, reading the
# credentials Claude Code already stored (macOS Keychain, else
# ~/.claude/.credentials.json). Re-running with the same name updates that entry.
#
# Usage: ./import-local.sh [account-name]     (default name: "local")
set -euo pipefail
cd "$(dirname "$0")"

NAME="${1:-local}"

command -v jq >/dev/null || { echo "jq is required (brew install jq / apt install jq)" >&2; exit 1; }

CREDS=""
if [ "$(uname)" = "Darwin" ] && CREDS="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)"; then
  :
elif [ -f "$HOME/.claude/.credentials.json" ]; then
  CREDS="$(cat "$HOME/.claude/.credentials.json")"
else
  echo "no Claude Code credentials found on this machine — log in with 'claude' first," >&2
  echo "or paste a token into accounts.json by hand (see accounts.example.json)" >&2
  exit 1
fi

echo "$CREDS" | jq -e '.claudeAiOauth.accessToken' >/dev/null 2>&1 || {
  echo "credentials found but not in the expected shape (.claudeAiOauth.accessToken)" >&2
  exit 1
}

[ -f accounts.json ] || echo "[]" > accounts.json

jq --arg name "$NAME" --argjson creds "$CREDS" '
  map(select(.name != $name)) + [{
    name: $name,
    accessToken: $creds.claudeAiOauth.accessToken,
    refreshToken: $creds.claudeAiOauth.refreshToken,
    expiresAt: $creds.claudeAiOauth.expiresAt
  }]
' accounts.json > accounts.json.tmp && mv accounts.json.tmp accounts.json

chmod 600 accounts.json
echo "saved \"$NAME\" to accounts.json"
