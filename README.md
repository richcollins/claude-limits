# claude-limits

A local dashboard for your Claude usage limits — the 5-hour session window, the weekly
windows, and when each one resets — across **multiple accounts** at once.

It's the data behind Claude Code's `/usage`, for every account you're logged into, on one
always-on page you can leave in a dock or a browser tab.

Zero dependencies, no build step, no npm install: one Node file (`server.mjs`) and one
HTML file (`public/index.html`).

## Requirements

- **Node 18+** (uses built-in `fetch`). `node -v` to check.
- **jq** — only for `import-local.sh` (`brew install jq`).
- macOS or Linux. The always-on LaunchAgent step is macOS-only; everything else is portable.

## Quick start

```bash
git clone <your fork> claude-limits && cd claude-limits
./import-local.sh personal    # pulls this machine's Claude Code login, names it "personal"
node server.mjs               # http://localhost:10460
```

`import-local.sh` reads the credentials Claude Code already stored on the machine (macOS
Keychain item `Claude Code-credentials`, otherwise `~/.claude/.credentials.json`) and
appends them to `accounts.json`. Run it once per name; re-running with a name that already
exists updates that entry instead of duplicating it.

## Adding more accounts

`accounts.json` is a plain array (see `accounts.example.json`). It is gitignored, and it
holds live OAuth tokens — treat it like a password file and never commit or paste it.

Each entry needs `name` + `accessToken`, optionally `refreshToken` and `expiresAt`. Two
kinds of token work, with different fidelity:

- **A full login** (`accessToken` + `refreshToken` + `expiresAt`, what `import-local.sh`
  imports) — full per-model breakdown from the usage endpoint, and the server refreshes
  the token itself when it expires, writing the new pair back to `accounts.json`.
- **A `claude setup-token` token** (`accessToken` only, valid ~1 year) — inference-only
  scope, so the usage endpoint rejects it. The server falls back to reading rate-limit
  headers off a minimal 1-token inference request. Those cards are labelled
  *via inference headers* and show slightly less detail.

To add an account from **another machine**, run `import-local.sh` there and copy the
resulting entry over, or run `claude setup-token` on that machine and paste the token in
with a `name`.

## Always-on (macOS)

```bash
./install-agent.sh            # loads a LaunchAgent: starts at login, restarts if it dies
```

It writes `~/Library/LaunchAgents/local.claude-limits.plist` pointing at wherever you
cloned the repo, and logs to `~/Library/Logs/claude-limits.log`. Options:
`--port 10461` to move the port, `--label com.you.claude-limits` to rename it,
`--uninstall` to remove it.

After editing `server.mjs`, restart it:

```bash
launchctl kickstart -k gui/$(id -u)/local.claude-limits
```

Frontend edits (`public/index.html`) need only a page reload.

On Linux, run `node server.mjs` yourself or wrap it in a systemd user unit.

## Dock / home-screen app

The page ships a web-app manifest and icons, so Safari's **File → Add to Dock** (or
Chrome's **Install page as app**) turns it into a standalone window. That needs the server
always up, i.e. the LaunchAgent above.

## Port

Defaults to **10460**; `PORT=… node server.mjs` overrides it. If you change it, update
`.claude/launch.json` too (that's a Claude Code preview config — harmless to delete if you
don't use Claude Code).

## How it works

- `GET /api/usage` fans out to `GET https://api.anthropic.com/api/oauth/usage` per account
  (`Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`) — the same endpoint
  Claude Code's `/usage` uses. It's proxied server-side because CORS blocks calling it
  from the browser, and because the tokens should never reach the page.
- Token refresh: `POST https://console.anthropic.com/v1/oauth/token` with
  `grant_type=refresh_token` and Claude Code's public client id.
- Header fallback: `POST /v1/messages` with `max_tokens: 1`, reading the
  `anthropic-ratelimit-unified-*` response headers. These probes cost a few tokens of real
  inference, so results are cached for 5 minutes.
- The page polls `/api/usage` every 60s. Each card has a `raw` disclosure with the
  untransformed payload.

## Troubleshooting

- **"accounts.json not found"** — run `./import-local.sh`.
- **A card shows an error instead of bars** — the message is the API's own. `401`/`403`
  usually means an expired token with no refresh token: re-run `import-local.sh`.
- **Nothing on the page at all** — check the server is up: `curl -s localhost:10460/api/usage`.
  Under the LaunchAgent, see `~/Library/Logs/claude-limits.log`.

Unofficial and unsupported: it reads undocumented endpoints that Anthropic can change
without notice.
