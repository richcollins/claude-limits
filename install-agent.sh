#!/bin/bash
# Install (or remove) a LaunchAgent that keeps the claude-limits server running:
# starts at login, restarts if it exits. macOS only — Linux users can run
# `node server.mjs` directly or wrap it in a systemd user unit.
#
# Usage: ./install-agent.sh [--label LABEL] [--port PORT] [--uninstall]
set -euo pipefail
cd "$(dirname "$0")"
REPO="$PWD"

LABEL="local.claude-limits"
PORT=""
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$(uname)" != "Darwin" ]; then
  echo "this script is macOS-only (launchd); run 'node server.mjs' instead" >&2
  exit 1
fi

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "$UNINSTALL" = 1 ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found on PATH" >&2; exit 1; }
LOG="$HOME/Library/Logs/claude-limits.log"

# A second agent running this same server would fight over the port.
for other in "$HOME"/Library/LaunchAgents/*.plist; do
  [ -e "$other" ] || continue
  [ "$other" = "$PLIST" ] && continue
  if grep -qF "$REPO/server.mjs" "$other" 2>/dev/null; then
    echo "warning: $(basename "$other" .plist) also runs this repo — remove it first" >&2
  fi
done

ENV_BLOCK=""
if [ -n "$PORT" ]; then
  ENV_BLOCK="  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>$PORT</string>
  </dict>
"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
${ENV_BLOCK}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

echo "installed $LABEL"
echo "  dashboard: http://localhost:${PORT:-10460}"
echo "  logs:      $LOG"
echo "  restart:   launchctl kickstart -k $DOMAIN/$LABEL"
echo "  remove:    ./install-agent.sh --uninstall${LABEL:+ --label $LABEL}"
