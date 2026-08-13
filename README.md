# claude-limits

Local dashboard showing Claude usage limits (5h session + weekly windows) and reset times across multiple OAuth accounts.

## Setup

```bash
cp accounts.example.json accounts.json   # then paste tokens in
./import-local.sh personal               # or: pull this Mac's Claude Code account from Keychain
node server.mjs                          # http://localhost:10460  (PORT env overrides)
```

## Always-on (LaunchAgent)

Installed as `com.richcollins.claude-limits` (`~/Library/LaunchAgents/com.richcollins.claude-limits.plist`, KeepAlive + RunAtLoad; logs at `~/Library/Logs/claude-limits.log`). After editing server code:

```bash
launchctl kickstart -k gui/$(id -u)/com.richcollins.claude-limits
```

`accounts.json` is gitignored. Each entry: `name`, `accessToken` (`sk-ant-oat01-…`), optional `refreshToken` (`sk-ant-ort01-…`) and `expiresAt` (ms epoch). Two kinds of tokens work:

- **Full login credentials** (from a machine's Claude Code credential store: macOS Keychain item `Claude Code-credentials`, or `~/.claude/.credentials.json` on Linux): full per-model limit breakdown from the usage endpoint; the server auto-refreshes expired access tokens and writes the new pair back.
- **`claude setup-token` tokens** (`accessToken` only, valid ~1 year, no refresh token): inference-only scope, so the usage endpoint rejects them — the server falls back to reading `anthropic-ratelimit-unified-*` headers off minimal 1-token inference probes (haiku for the base windows, `claude-fable-5` for the Fable weekly, cached 5 min). Cards on this path are tagged "via inference headers".

## How it works

- `GET /api/usage` on the server fans out to `GET https://api.anthropic.com/api/oauth/usage` per account (`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`) — the same endpoint Claude Code's `/usage` uses. Proxied server-side because CORS blocks it from the browser.
- Token refresh: `POST https://console.anthropic.com/v1/oauth/token` with `grant_type=refresh_token` and Claude Code's public client id.
- The page polls every 60s. Zero npm dependencies.

## Dock app

The page ships a web-app manifest and icons: Safari **File → Add to Dock** (or Chrome → Install page as app) gives a standalone dock app. Requires the LaunchAgent so the server is always up.
