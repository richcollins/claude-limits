#!/bin/bash
# Append this Mac's Claude Code account (from the macOS Keychain) to accounts.json.
# Usage: ./import-local.sh [account-name]   (default name: "local")
set -euo pipefail
cd "$(dirname "$0")"

NAME="${1:-local}"
CREDS="$(security find-generic-password -s "Claude Code-credentials" -w)"

[ -f accounts.json ] || echo "[]" > accounts.json

jq --arg name "$NAME" --argjson creds "$CREDS" '
  . + [{
    name: $name,
    accessToken: $creds.claudeAiOauth.accessToken,
    refreshToken: $creds.claudeAiOauth.refreshToken,
    expiresAt: $creds.claudeAiOauth.expiresAt
  }]
' accounts.json > accounts.json.tmp && mv accounts.json.tmp accounts.json

echo "added \"$NAME\" to accounts.json"
