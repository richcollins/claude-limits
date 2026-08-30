# claude-limits

Local dashboard for Claude usage limits across multiple OAuth accounts. Zero-dependency Node: `server.mjs` (proxy + static) and `public/index.html` (single-file frontend). No build step, no npm.

The server doubles as a shared local service for other apps: `GET /api/status` returns a normalized summary (stable window ids `session`/`weekly_all`/`weekly_<model>`/`overage`, `percent` 0–100, per-account and top-level `status` of ok/warning/critical/limited) with the endpoint-vs-headers distinction erased. `/api/usage` and `/api/status` are CORS-open (`Access-Control-Allow-Origin: *`), and results are cached 30s (`usageCache`) so extra polling clients add no upstream calls — important because a 429 from the usage endpoint falls back to the paid inference probe. Consumer contract is documented in README "Using it from other apps"; don't rename window ids or status values without updating consumers (first consumer: darksided's GM account-swap resolver — it reads raw `percent`/`resetsAt` and picks accounts itself).

`GET /api/token?name=<account>` is a token broker for trusted consumers (darksided injects the result as `CLAUDE_CODE_OAUTH_TOKEN` per GM wake): returns `{name, accessToken, expiresAt}`, gated by the `x-limits-key` header matching the `LIMITS_KEY` env var, fail-closed (403 when the env var is unset), never CORS-open. This server stays the single writer of accounts.json — consumers must never read the file or run the refresh dance themselves. The same codebase deploys as independent instances (Rich's Mac + the darksided prod droplet, compose-internal, no published port), each with its own accounts.json; remote instances should hold setup tokens only (refresh rotation forks between hosts; see README "Second instance on a remote host").

## Usually runs under launchd — restart after server edits

`./install-agent.sh` installs LaunchAgent `local.claude-limits` (KeepAlive), so the server is typically not running from a terminal. Edits to `server.mjs` do nothing until:

```bash
launchctl kickstart -k gui/$(id -u)/local.claude-limits
```

(`launchctl list | grep claude-limits` if the label was customised; a machine set up before the install script may still use a different one.) Frontend edits need only a page reload. Logs: `~/Library/Logs/claude-limits.log`. Port **10460** — moving it means updating `.claude/launch.json` and re-adding any dock web-app.

## accounts.json

Gitignored; contains live OAuth tokens — never commit, print, or paste its values into commands. The server rewrites the whole file whenever it refreshes a full-login entry (dashboard polls and `/api/token` alike), so never hand-edit it while the server is live — stop it first or kickstart after. Two entry kinds:

- Full-scope login credentials (`accessToken` + `refreshToken` + `expiresAt`, imported by `./import-local.sh` from the macOS Keychain item `Claude Code-credentials`, else `~/.claude/.credentials.json`): server auto-refreshes and writes the new pair back.
- `claude setup-token` tokens (`accessToken` only): inference-only scope, valid ~1 year, no refresh token exists. Optional `tokenExpiresAt` (ISO or epoch, recorded by hand at mint + 1 year — the API offers no way to look it up): surfaces in `/api/usage` + `/api/status` per account, and the dashboard warns within 30 days of it. Distinct from `expiresAt` (access-token expiry, server-managed).

## API facts (verified against Claude Code 2.1.228 binary + live API, 2026-08)

- **Usage endpoint**: `GET api.anthropic.com/api/oauth/usage` with `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`. Requires `user:profile` scope — full-scope tokens only. Response's `limits[]` array is authoritative (session / weekly_all / weekly_scoped per-model entries, `percent` 0–100).
- **Setup-token accounts get 429 (not 401/403) from that endpoint.** Server falls back to the header probe on 401/403/429.
- **Header probe**: `POST /v1/messages`, `max_tokens: 1`, body `"quota"`. Limits come back in `anthropic-ratelimit-unified-{5h,7d,7d_oi,overage}-{utilization,reset}` headers — utilization is a **0–1 fraction** (endpoint JSON uses 0–100), reset is epoch seconds. A 429 response still carries the headers.
- **Premium-model identity gate**: OAuth inference to fable-tier models rejects with a bare no-header 429 unless the request's system prompt is exactly `You are Claude Code, Anthropic's official CLI for Claude.` Haiku works without it; the probe always sends it.
- **Fable weekly window**: only via a probe that targets `claude-fable-5` — it arrives as the `7d_oi` header on that request (matches the endpoint's `weekly_scoped` Fable row). Not present on haiku-targeted probes. **Opus has no scoped weekly window** (verified 2026-08-30: an opus-targeted probe returns no `7d_oi` at all — opus draws from the all-models weekly), so don't add it to `SCOPED_PROBE_MODELS`; check a model's headers before listing it there.
- Probes cost real inference (~15 input + 1 output tokens each); `probeCache` TTL is 5 min. Don't lower it or probe in a loop.

## Verifying changes

`curl -s localhost:10460/api/usage | jq` after kickstart. Frontend renders `limits[]` when present (endpoint accounts), else named windows (header accounts, tagged "via inference headers"). Each card has a `raw` disclosure showing the untransformed payload.
