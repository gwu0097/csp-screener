import { createServerClient, SchwabAccountTokenRow } from "@/lib/supabase";

// OAuth + Trader API client for the "Account Data" Schwab app
// (Accounts and Trading Production) — a SEPARATE registered app from
// the "Earnings Research Engine" market-data app in lib/schwab.ts.
// Deliberately does not import anything from lib/schwab.ts and does
// not share a single function, constant, or DB row with it: a failure
// or invalidation here must be structurally unable to touch the
// market-data token, which the rest of the app depends on. Every
// function below operates on its own env vars (SCHWAB_ACCT_*) and its
// own table (schwab_account_tokens).
//
// READ-ONLY BY CONSTRUCTION, NOT BY CONVENTION. Schwab's Accounts and
// Trading product has no read-only scope — grant is all-or-nothing,
// so nothing at the API level stops this connection from placing an
// order. The guard is entirely ours, enforced two ways:
//   1. This file exposes GET functions only. There is no
//      place-order/replace-order/cancel-order function anywhere in
//      this module (or this codebase).
//   2. The one transport primitive every exported function funnels
//      through (schwabAcctFetch) takes an explicit method argument and
//      calls assertReadOnlyMethod() on it before any network I/O — so
//      even a future edit that copy-pastes a POST call through this
//      same primitive throws immediately rather than silently working.
// See Test/test-schwab-account-readonly.ts.
//
// SECRETS: SCHWAB_ACCT_CLIENT_ID / SCHWAB_ACCT_CLIENT_SECRET are never
// logged, echoed, or included in any error message anywhere in this
// file — only their PRESENCE (a boolean) is ever surfaced, matching
// lib/schwab.ts's own existing convention for the market-data app's
// credentials.

const SCHWAB_BASE_URL = "https://api.schwabapi.com";
const OAUTH_BASE = `${SCHWAB_BASE_URL}/v1/oauth`;
const TRADER_BASE = `${SCHWAB_BASE_URL}/trader/v1`;

const CLIENT_ID = process.env.SCHWAB_ACCT_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SCHWAB_ACCT_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.SCHWAB_ACCT_REDIRECT_URI ?? "";

const ACCESS_TTL_SECONDS = 30 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

// Reports whether the two secrets and the redirect URI are present —
// never their values — plus which deployment environment this process
// is running in, so a caller can tell "empty in prod" apart from
// "empty in preview" apart from "running locally against .env.local".
// Vercel sets VERCEL_ENV to "production" | "preview" | "development"
// on deployed instances; it's unset when running locally (npm run dev
// / tsx), which is itself useful signal.
export function checkAcctEnv(): {
  clientIdPresent: boolean;
  clientSecretPresent: boolean;
  redirectUriPresent: boolean;
  vercelEnv: string | null;
  nodeEnv: string;
} {
  return {
    clientIdPresent: Boolean(CLIENT_ID),
    clientSecretPresent: Boolean(CLIENT_SECRET),
    redirectUriPresent: Boolean(REDIRECT_URI),
    vercelEnv: process.env.VERCEL_ENV ?? null,
    nodeEnv: process.env.NODE_ENV ?? "unknown",
  };
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

// Re-exported so both legs of "Reconnect both" use the identical
// marker — see lib/schwab.ts's own copy of this constant for the
// full explanation. Kept as a separate literal (not imported from
// lib/schwab.ts) to preserve the zero-shared-code isolation between
// these two connections.
export const CHAIN_BOTH_STATE = "chain_both";

export function getSchwabAcctAuthUrl(state?: string): string {
  // 2026-08-21: tried adding scope=readonly to match lib/schwab.ts's
  // working market-data request — reverted. It didn't fix the "unable
  // to complete your request" error and correlated with a regression
  // (could reach the login form before, couldn't after), so it wasn't
  // the right lead. Evidence now points at something on Schwab's side
  // (the error page reads "For institutional use only" and serves from
  // sws-gateway.schwab.com — not obviously the standard individual-
  // trader OAuth login), not a request-shape problem here.
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
  });
  if (state) params.set("state", state);
  return `${OAUTH_BASE}/authorize?${params.toString()}`;
}

function basicAuthHeader(): string {
  const encoded = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  return `Basic ${encoded}`;
}

export class SchwabAcctAuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SchwabAcctAuthError";
    this.status = status;
  }
}

export class SchwabAcctApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SchwabAcctApiError";
    this.status = status;
  }
}

async function postTokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const grantType = body.get("grant_type");
  console.log("[schwab-acct-token] POST", `${OAUTH_BASE}/token`, {
    grant_type: grantType,
    redirect_uri: body.get("redirect_uri"),
    clientIdPresent: Boolean(CLIENT_ID),
    clientSecretPresent: Boolean(CLIENT_SECRET),
  });
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });
  const text = await res.text();
  console.log("[schwab-acct-token] response status:", res.status, "body length:", text.length);
  if (!res.ok) {
    // Schwab's token-error bodies don't echo the client secret back,
    // but never log this body at a level above what's needed to
    // diagnose — status + message only, same as lib/schwab.ts.
    console.error("[schwab-acct-token] error body:", text);
    throw new SchwabAcctAuthError(res.status, `Schwab acct token request failed: ${res.status} ${text}`);
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Schwab acct token response not JSON: ${text.slice(0, 200)}`);
  }
}

async function persistAcctTokens(tokens: TokenResponse): Promise<void> {
  const supabase = createServerClient();
  const now = Date.now();
  const accessExpiresAt = new Date(now + (tokens.expires_in ?? ACCESS_TTL_SECONDS) * 1000);

  const { data: existing } = await supabase
    .from("schwab_account_tokens")
    .select("id,refresh_token,refresh_token_expires_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const existingRow = existing as
    | { id: string; refresh_token: string; refresh_token_expires_at: string }
    | null;

  // Same healing logic as lib/schwab.ts::persistTokens — see that
  // function's comment for the full reasoning. Duplicated rather than
  // shared so this file has zero import-time coupling to lib/schwab.ts.
  const refreshTokenChanged = !existingRow || existingRow.refresh_token !== tokens.refresh_token;
  const existingExpiryStillFuture =
    !!existingRow && new Date(existingRow.refresh_token_expires_at).getTime() > now;
  const refreshExpiresAt =
    refreshTokenChanged || !existingExpiryStillFuture
      ? new Date(now + REFRESH_TTL_SECONDS * 1000)
      : new Date(existingRow.refresh_token_expires_at);

  const payload = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_token_expires_at: accessExpiresAt.toISOString(),
    refresh_token_expires_at: refreshExpiresAt.toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (existingRow?.id) {
    const { error } = await supabase.from("schwab_account_tokens").update(payload).eq("id", existingRow.id);
    if (error) throw new Error(`Failed to update Schwab account tokens: ${error.message}`);
  } else {
    const { error } = await supabase.from("schwab_account_tokens").insert(payload);
    if (error) throw new Error(`Failed to insert Schwab account tokens: ${error.message}`);
  }
}

export async function exchangeAcctCodeForTokens(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  const tokens = await postTokenRequest(body);
  await persistAcctTokens(tokens);
}

// Same manual-paste escape hatch as lib/schwab.ts::saveManualTokens,
// for testing this connection before/without a working callback URL.
export async function saveManualAcctTokens(params: {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds?: number;
}): Promise<void> {
  const accessToken = params.accessToken.trim();
  const refreshToken = params.refreshToken.trim();
  if (!accessToken) throw new Error("access_token is required");
  if (!refreshToken) throw new Error("refresh_token is required");
  await persistAcctTokens({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: params.expiresInSeconds ?? ACCESS_TTL_SECONDS,
  });
}

async function refreshAcctAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return postTokenRequest(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One retry before a token-endpoint 400/401 is treated as proof the
// refresh token is dead. Added after a 2026-08-24 incident: Schwab
// returned "unsupported_token_type ... Failed to resolve access
// token" — a backend token-lookup error, not the standard
// invalid_grant "your refresh token is expired/revoked" response —
// and the then-instant invalidateSchwabAcctToken() call permanently
// poisoned a connection that had been reconnected days earlier and
// was very likely still valid. A short retry survives a one-off
// Schwab-side hiccup like that one while still poisoning promptly on
// a genuinely dead token, which fails on both attempts, not just one.
async function refreshAcctAccessTokenWithRetry(refreshToken: string): Promise<TokenResponse> {
  try {
    return await refreshAcctAccessToken(refreshToken);
  } catch (e) {
    if (!(e instanceof SchwabAcctAuthError) || (e.status !== 400 && e.status !== 401)) throw e;
    console.warn(`[schwab-acct-token] refresh failed (${e.status}), retrying once in 3s before invalidating`);
    await sleep(3000);
    return await refreshAcctAccessToken(refreshToken);
  }
}

async function loadLatestAcctTokenRow(): Promise<SchwabAccountTokenRow | null> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("schwab_account_tokens")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as SchwabAccountTokenRow) ?? null;
}

export async function isSchwabAcctConnected(): Promise<{ connected: boolean; lastRefresh: string | null }> {
  const row = await loadLatestAcctTokenRow();
  if (!row) return { connected: false, lastRefresh: null };
  const refreshExpiry = new Date(row.refresh_token_expires_at).getTime();
  return { connected: refreshExpiry > Date.now(), lastRefresh: row.updated_at };
}

// Mirrors lib/schwab.ts::invalidateSchwabToken — backdates
// refresh_token_expires_at on THIS table's latest row only. Cannot
// reach schwab_tokens: there is no code path in this file that
// references that table name anywhere.
export async function invalidateSchwabAcctToken(): Promise<void> {
  const row = await loadLatestAcctTokenRow();
  if (!row) return;
  const supabase = createServerClient();
  const { error } = await supabase
    .from("schwab_account_tokens")
    .update({ refresh_token_expires_at: new Date(0).toISOString() })
    .eq("id", row.id);
  if (error) {
    console.error("[schwab-acct] invalidateSchwabAcctToken failed:", error.message);
  } else {
    console.warn("[schwab-acct] account token marked invalid — reconnect required");
  }
}

export type AcctForceRefreshResult =
  | { ok: true; refreshTokenChanged: boolean; newRefreshExpiresAt: string }
  | { ok: false; error: string; hadStoredExpiry: string | null; daysRemainingBeforeAttempt: number | null };

export async function forceRefreshAcctToken(): Promise<AcctForceRefreshResult> {
  const row = await loadLatestAcctTokenRow();
  if (!row) {
    return { ok: false, error: "not_connected", hadStoredExpiry: null, daysRemainingBeforeAttempt: null };
  }
  const hadStoredExpiry = row.refresh_token_expires_at;
  const daysRemainingBeforeAttempt = (new Date(hadStoredExpiry).getTime() - Date.now()) / 86_400_000;
  try {
    const fresh = await refreshAcctAccessTokenWithRetry(row.refresh_token);
    await persistAcctTokens(fresh);
    const updated = await loadLatestAcctTokenRow();
    return {
      ok: true,
      refreshTokenChanged: fresh.refresh_token !== row.refresh_token,
      newRefreshExpiresAt: updated?.refresh_token_expires_at ?? hadStoredExpiry,
    };
  } catch (e) {
    if (e instanceof SchwabAcctAuthError && (e.status === 400 || e.status === 401)) {
      await invalidateSchwabAcctToken();
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      hadStoredExpiry,
      daysRemainingBeforeAttempt: Number(daysRemainingBeforeAttempt.toFixed(2)),
    };
  }
}

export async function disconnectSchwabAcct(): Promise<void> {
  const supabase = createServerClient();
  await supabase.from("schwab_account_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

export async function getValidAcctAccessToken(): Promise<string> {
  const row = await loadLatestAcctTokenRow();
  if (!row) throw new Error("Schwab Account Data is not connected.");

  const accessExpiry = new Date(row.access_token_expires_at).getTime();
  const skewMs = 60_000;
  if (accessExpiry - skewMs > Date.now()) {
    return row.access_token;
  }

  const refreshExpiry = new Date(row.refresh_token_expires_at).getTime();
  if (refreshExpiry <= Date.now()) {
    throw new Error("Schwab Account Data refresh token expired. Reconnect required.");
  }

  let fresh: TokenResponse;
  try {
    fresh = await refreshAcctAccessTokenWithRetry(row.refresh_token);
  } catch (e) {
    if (e instanceof SchwabAcctAuthError && (e.status === 400 || e.status === 401)) {
      await invalidateSchwabAcctToken();
    }
    throw e;
  }
  await persistAcctTokens(fresh);
  return fresh.access_token;
}

// ---------- Read-only transport ----------

const READ_ONLY_TRANSPORT_MESSAGE =
  "lib/schwab-account.ts is a GET-only transport. This module has no " +
  "place-order/replace-order/cancel-order function anywhere in this " +
  "codebase — if something needs to send anything other than GET here, " +
  "this is deliberately the wrong file to add it to.";

// Exported so Test/test-schwab-account-readonly.ts can exercise it
// directly, with no live network call and no valid token required.
// schwabAcctFetch below calls this unconditionally, before any I/O, on
// every single request this module ever makes — so this isn't "we
// happen to only call GET," it's "a non-GET call cannot leave this
// file without throwing first."
export function assertReadOnlyMethod(method: string): void {
  if (method.toUpperCase() !== "GET") {
    throw new Error(`${READ_ONLY_TRANSPORT_MESSAGE} (attempted: ${method})`);
  }
}

async function schwabAcctFetch<T>(
  method: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  assertReadOnlyMethod(method);
  const token = await getValidAcctAccessToken();
  const url = new URL(path.startsWith("http") ? path : `${SCHWAB_BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) {
      await invalidateSchwabAcctToken();
    }
    throw new SchwabAcctApiError(res.status, `Schwab acct GET ${url.pathname} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// The only network primitive exported for actual use — always GET,
// no method parameter for a caller to override.
async function schwabAcctGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  return schwabAcctFetch<T>("GET", path, params);
}

// ---------- Trader API reads ----------
//
// Deliberately loosely typed (unknown / minimal shape) rather than
// full response types — this is the inspection phase; real types get
// written once the actual response shape has been seen and reported,
// not guessed at ahead of time.

export type AccountNumberHash = { accountNumber: string; hashValue: string };

export async function getAccountNumbers(): Promise<AccountNumberHash[]> {
  return schwabAcctGet<AccountNumberHash[]>(`${TRADER_BASE}/accounts/accountNumbers`);
}

export async function getAccount(accountHash: string): Promise<unknown> {
  return schwabAcctGet<unknown>(`${TRADER_BASE}/accounts/${accountHash}`, { fields: "positions" });
}

export async function getAccountTransactions(
  accountHash: string,
  params: { startDate: string; endDate: string; types?: string; symbol?: string },
): Promise<unknown[]> {
  return schwabAcctGet<unknown[]>(`${TRADER_BASE}/accounts/${accountHash}/transactions`, params);
}

export async function getAccountOrders(
  accountHash: string,
  params: { fromEnteredTime: string; toEnteredTime: string; maxResults?: number; status?: string },
): Promise<unknown[]> {
  return schwabAcctGet<unknown[]>(`${TRADER_BASE}/accounts/${accountHash}/orders`, params);
}
