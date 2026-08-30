#!/usr/bin/env node
// Claude limits dashboard — zero-dependency Node server.
// Reads OAuth accounts from accounts.json, proxies GET /api/usage to
// https://api.anthropic.com/api/oauth/usage per account (CORS blocks doing
// this from the browser), auto-refreshes expired access tokens, serves the
// static dashboard.

import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.join(ROOT, "accounts.json");
const PORT = Number(process.env.PORT) || 10460;

const API_ORIGIN = "https://api.anthropic.com";
const USAGE_PATH = "/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
// Claude Code's public OAuth client id (used only for refresh_token grants).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

async function loadAccounts() {
  let raw;
  try {
    raw = await readFile(ACCOUNTS_PATH, "utf8");
  } catch {
    return null; // missing file
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("accounts.json must be an array");
  return parsed;
}

async function saveAccounts(accounts) {
  await writeFile(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2) + "\n");
}

// Returns a valid access token, refreshing (and persisting) if needed.
async function ensureToken(account, accounts) {
  const skewMs = 60_000;
  if (account.accessToken && (!account.expiresAt || Date.now() < account.expiresAt - skewMs)) {
    return account.accessToken;
  }
  if (!account.refreshToken) {
    if (account.accessToken) return account.accessToken; // expired but nothing better; let the API 401
    throw new Error("no accessToken or refreshToken");
  }
  const res = await fetch(account.tokenUrl || TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
      client_id: account.clientId || CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const tok = await res.json();
  account.accessToken = tok.access_token;
  if (tok.refresh_token) account.refreshToken = tok.refresh_token;
  if (tok.expires_in) account.expiresAt = Date.now() + tok.expires_in * 1000;
  await saveAccounts(accounts);
  return account.accessToken;
}

// Fallback for inference-only tokens (claude setup-token / CLAUDE_CODE_OAUTH_TOKEN):
// those lack the user:profile scope the usage endpoint needs, but every
// /v1/messages response carries anthropic-ratelimit-unified-* headers. Make the
// cheapest possible request (max_tokens: 1) and read the headers — the same
// quota probe Claude Code itself uses.
const HEADER_WINDOWS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_overage_included", "7d_oi"],
  ["overage", "overage"],
];

async function probeModel(token, model) {
  const res = await fetch(API_ORIGIN + "/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      // Premium models reject bare OAuth inference without the Claude Code
      // identity; harmless on the others.
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: "quota" }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  // A 429 still carries the unified limit headers (that's the point).
  if (!res.ok && res.status !== 429) {
    throw new Error(`probe(${model}) HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const windows = {};
  for (const [key, abbrev] of HEADER_WINDOWS) {
    const util = res.headers.get(`anthropic-ratelimit-unified-${abbrev}-utilization`);
    const reset = res.headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`);
    if (util === null && reset === null) continue;
    windows[key] = {
      utilization: util === null ? null : Number(util) * 100, // headers are 0–1 fractions
      resets_at: reset === null ? null : new Date(Number(reset) * 1000).toISOString(),
    };
  }
  return { status: res.headers.get("anthropic-ratelimit-unified-status"), windows };
}

// Probes cost real (tiny) inference; don't re-probe on every 60s poll.
const PROBE_TTL_MS = 5 * 60_000;
const probeCache = new Map(); // account name → {at, usage}

async function probeHeaders(account) {
  const cached = probeCache.get(account.name);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.usage;

  const base = await probeModel(account.accessToken, "claude-haiku-4-5");
  const usage = { source: "headers", status: base.status, ...base.windows };

  // A Fable-targeted request reports the Fable weekly window as 7d_oi.
  try {
    const fable = await probeModel(account.accessToken, "claude-fable-5");
    if (fable.windows.seven_day_overage_included) {
      usage.seven_day_fable = fable.windows.seven_day_overage_included;
      if (fable.status === "rejected" || (fable.status === "allowed_warning" && usage.status === "allowed")) {
        usage.status = fable.status;
      }
    }
  } catch {
    // account has no Fable access — base windows only
  }

  probeCache.set(account.name, { at: Date.now(), usage });
  return usage;
}

async function fetchUsage(account, accounts) {
  const token = await ensureToken(account, accounts);
  const res = await fetch(API_ORIGIN + USAGE_PATH, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  // 401/403: inference-only token (setup-token) lacks the user:profile scope.
  // 429: the endpoint rate-limits some tokens too — but a rate-limited
  // /v1/messages response still carries the unified limit headers.
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    return probeHeaders(account);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// One shared fetch for all clients: the dashboard polls every 60s, and other
// local apps poll /api/status too. Without this cache each extra client
// multiplies calls to the usage endpoint, which rate-limits (429) under load —
// and a 429 falls back to the inference probe, which costs real tokens.
const USAGE_TTL_MS = 30_000;
let usageCache = null; // {at, promise}

function getUsage() {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.promise;
  const at = Date.now();
  const promise = (async () => {
    const accounts = await loadAccounts();
    if (accounts === null) {
      return { error: "accounts.json not found — run ./import-local.sh, or copy accounts.example.json and add your tokens" };
    }
    if (accounts.length === 0) {
      return { error: "accounts.json has no accounts yet — run ./import-local.sh to add this machine's login" };
    }
    const results = await Promise.all(
      accounts.map(async (account) => {
        const name = account.name || "unnamed";
        try {
          const usage = await fetchUsage(account, accounts);
          return { name, ok: true, usage, fetchedAt: Date.now() };
        } catch (err) {
          return { name, ok: false, error: String(err.message || err) };
        }
      })
    );
    return { accounts: results };
  })();
  usageCache = { at, promise };
  promise.catch(() => { if (usageCache?.promise === promise) usageCache = null; });
  return promise;
}

function sendJson(res, data) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    // Local service consumed by other local apps (browser pages included).
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

async function handleUsage(res) {
  sendJson(res, await getUsage());
}

// --- /api/status: normalized summary for other apps ---------------------------
// Both upstream shapes (endpoint limits[] and probe header windows) reduce to
// the same window list, so consumers don't care which kind of token an account
// uses. Stable ids: "session", "weekly_all", "weekly_<scope>", "overage".

const HEADER_WINDOW_IDS = {
  five_hour: "session",
  seven_day: "weekly_all",
  seven_day_opus: "weekly_opus",
  seven_day_sonnet: "weekly_sonnet",
  seven_day_fable: "weekly_fable",
  seven_day_oauth_apps: "weekly_apps",
  seven_day_overage_included: "weekly_overage_included",
  overage: "overage",
};

const WINDOW_LABELS = {
  session: "Session (5h)",
  weekly_all: "Week — all models",
  weekly_overage_included: "Week — incl. extra usage",
  overage: "Extra usage",
};

function normalizeWindows(usage) {
  const windows = [];
  if (usage.limits?.length) {
    for (const lim of usage.limits) {
      const scopeName = lim.scope?.model?.display_name || lim.scope?.surface?.display_name;
      const id = scopeName
        ? "weekly_" + scopeName.toLowerCase().replace(/[^a-z0-9]+/g, "_")
        : lim.kind;
      windows.push({
        id,
        label: scopeName ? `Week — ${scopeName}` : (WINDOW_LABELS[lim.kind] || lim.kind),
        percent: lim.percent ?? null,
        resetsAt: lim.resets_at ?? null,
      });
    }
  } else {
    for (const [key, id] of Object.entries(HEADER_WINDOW_IDS)) {
      const w = usage[key];
      if (!w || w.utilization == null) continue;
      windows.push({
        id,
        label: WINDOW_LABELS[id] || `Week — ${id.replace(/^weekly_/, "")}`,
        percent: w.utilization,
        resetsAt: w.resets_at ?? null,
      });
    }
  }
  return windows;
}

// Same thresholds as the dashboard's bar colors (70 warn / 90 critical);
// "limited" means the API itself says requests are being rejected.
function statusOf(windows, headerStatus) {
  if (headerStatus === "rejected") return "limited";
  const max = Math.max(0, ...windows.map((w) => w.percent ?? 0));
  if (max >= 100) return "limited";
  if (max >= 90) return "critical";
  if (max >= 70 || headerStatus === "allowed_warning") return "warning";
  return "ok";
}

const STATUS_RANK = { ok: 0, warning: 1, critical: 2, limited: 3 };

async function handleStatus(res) {
  const data = await getUsage();
  if (data.error) {
    sendJson(res, { error: data.error });
    return;
  }
  const accounts = data.accounts.map((acct) => {
    if (!acct.ok) return { name: acct.name, ok: false, error: acct.error };
    const windows = normalizeWindows(acct.usage);
    return {
      name: acct.name,
      ok: true,
      source: acct.usage.source === "headers" ? "headers" : "endpoint",
      status: statusOf(windows, acct.usage.status),
      windows,
      fetchedAt: acct.fetchedAt,
    };
  });
  const status = accounts
    .filter((a) => a.ok)
    .reduce((worst, a) => (STATUS_RANK[a.status] > STATUS_RANK[worst] ? a.status : worst), "ok");
  sendJson(res, { status, accounts });
}

async function handleStatic(urlPath, res) {
  const file = urlPath === "/" ? "index.html" : urlPath.slice(1);
  if (file.includes("..") || file === "accounts.json") {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(path.join(ROOT, "public", file));
    const type = file.endsWith(".html") ? "text/html; charset=utf-8"
      : file.endsWith(".js") ? "text/javascript"
      : file.endsWith(".css") ? "text/css"
      : file.endsWith(".png") ? "image/png"
      : file.endsWith(".svg") ? "image/svg+xml"
      : file.endsWith(".webmanifest") ? "application/manifest+json"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
      });
      res.end();
    }
    else if (url.pathname === "/api/usage") await handleUsage(res);
    else if (url.pathname === "/api/status") await handleStatus(res);
    else await handleStatic(url.pathname, res);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}).listen(PORT, () => {
  console.log(`claude-limits dashboard: http://localhost:${PORT}`);
});
