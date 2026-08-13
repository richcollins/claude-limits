# claude-limits

Local dashboard for Claude usage limits across multiple OAuth accounts. Zero-dependency Node: `server.mjs` (proxy + static) and `public/index.html` (single-file frontend). No build step, no npm.

## Runs under launchd — restart after server edits

The server runs as LaunchAgent `com.richcollins.claude-limits` (KeepAlive), not from a terminal. Edits to `server.mjs` do nothing until:

```bash
launchctl kickstart -k gui/$(id -u)/com.richcollins.claude-limits
```

Frontend edits need only a page reload. Logs: `~/Library/Logs/claude-limits.log`. Port **10460** — don't move it (dock web-app and launch.json attach configs point there), and never use 10450 (wt-tree).

## accounts.json

Gitignored; contains live OAuth tokens — never commit, print, or paste its values into commands. Two entry kinds:

- Full-scope login credentials (`accessToken` + `refreshToken` + `expiresAt`, from Keychain item `Claude Code-credentials` via `./import-local.sh`): server auto-refreshes and writes the new pair back.
- `claude setup-token` tokens (`accessToken` only): inference-only scope, valid ~1 year, no refresh token exists.

## API facts (verified against Claude Code 2.1.228 binary + live API, 2026-08)

- **Usage endpoint**: `GET api.anthropic.com/api/oauth/usage` with `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`. Requires `user:profile` scope — full-scope tokens only. Response's `limits[]` array is authoritative (session / weekly_all / weekly_scoped per-model entries, `percent` 0–100).
- **Setup-token accounts get 429 (not 401/403) from that endpoint.** Server falls back to the header probe on 401/403/429.
- **Header probe**: `POST /v1/messages`, `max_tokens: 1`, body `"quota"`. Limits come back in `anthropic-ratelimit-unified-{5h,7d,7d_oi,overage}-{utilization,reset}` headers — utilization is a **0–1 fraction** (endpoint JSON uses 0–100), reset is epoch seconds. A 429 response still carries the headers.
- **Premium-model identity gate**: OAuth inference to fable-tier models rejects with a bare no-header 429 unless the request's system prompt is exactly `You are Claude Code, Anthropic's official CLI for Claude.` Haiku works without it; the probe always sends it.
- **Fable weekly window**: only via a probe that targets `claude-fable-5` — it arrives as the `7d_oi` header on that request (matches the endpoint's `weekly_scoped` Fable row). Not present on haiku-targeted probes; not available at all from headers for other scoped models unless probed per-model the same way.
- Probes cost real inference (~15 input + 1 output tokens each); `probeCache` TTL is 5 min. Don't lower it or probe in a loop.

## Verifying changes

`curl -s localhost:10460/api/usage | jq` after kickstart. Frontend renders `limits[]` when present (endpoint accounts), else named windows (header accounts, tagged "via inference headers"). Each card has a `raw` disclosure showing the untransformed payload.
