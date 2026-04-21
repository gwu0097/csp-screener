import { createServerClient, SchwabTokenRow } from "@/lib/supabase";

const SCHWAB_BASE_URL = "https://api.schwabapi.com";
const OAUTH_BASE = `${SCHWAB_BASE_URL}/v1/oauth`;
const MARKETDATA_BASE = `${SCHWAB_BASE_URL}/marketdata/v1`;

const CLIENT_ID = process.env.SCHWAB_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.SCHWAB_REDIRECT_URI ?? "";

// Schwab access tokens live 30 minutes, refresh tokens live 7 days.
const ACCESS_TTL_SECONDS = 30 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

export function getSchwabAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "readonly",
  });
  return `${OAUTH_BASE}/authorize?${params.toString()}`;
}

function basicAuthHeader(): string {
  const encoded = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  return `Basic ${encoded}`;
}

async function postTokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const grantType = body.get("grant_type");
  console.log("[schwab-token] POST", `${OAUTH_BASE}/token`, {
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
  console.log("[schwab-token] response status:", res.status, "body length:", text.length);
  if (!res.ok) {
    console.error("[schwab-token] error body:", text);
    throw new Error(`Schwab token request failed: ${res.status} ${text}`);
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Schwab token response not JSON: ${text.slice(0, 200)}`);
  }
}

async function persistTokens(tokens: TokenResponse): Promise<void> {
  const supabase = createServerClient();
  const now = Date.now();
  const accessExpiresAt = new Date(now + (tokens.expires_in ?? ACCESS_TTL_SECONDS) * 1000);
  const refreshExpiresAt = new Date(now + REFRESH_TTL_SECONDS * 1000);

  const { data: existing } = await supabase
    .from("schwab_tokens")
    .select("id")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const payload = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_token_expires_at: accessExpiresAt.toISOString(),
    refresh_token_expires_at: refreshExpiresAt.toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await supabase.from("schwab_tokens").update(payload).eq("id", existing.id);
    if (error) throw new Error(`Failed to update Schwab tokens: ${error.message}`);
  } else {
    const { error } = await supabase.from("schwab_tokens").insert(payload);
    if (error) throw new Error(`Failed to insert Schwab tokens: ${error.message}`);
  }
}

export async function exchangeCodeForTokens(code: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  const tokens = await postTokenRequest(body);
  await persistTokens(tokens);
}

// Temporary workaround: persist tokens the user pastes in manually from a
// browser session or out-of-band OAuth flow while the Schwab callback URL is
// being modified. Takes an access_token + refresh_token, assumes the standard
// Schwab TTLs (access 30 min, refresh 7 days from now).
export async function saveManualTokens(params: {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds?: number;
}): Promise<void> {
  const accessToken = params.accessToken.trim();
  const refreshToken = params.refreshToken.trim();
  if (!accessToken) throw new Error("access_token is required");
  if (!refreshToken) throw new Error("refresh_token is required");
  await persistTokens({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: params.expiresInSeconds ?? ACCESS_TTL_SECONDS,
  });
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return postTokenRequest(body);
}

async function loadLatestTokenRow(): Promise<SchwabTokenRow | null> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("schwab_tokens")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Table may not exist yet or no rows — caller handles null.
    return null;
  }
  return (data as SchwabTokenRow) ?? null;
}

export async function isSchwabConnected(): Promise<{ connected: boolean; lastRefresh: string | null }> {
  const row = await loadLatestTokenRow();
  if (!row) return { connected: false, lastRefresh: null };
  const refreshExpiry = new Date(row.refresh_token_expires_at).getTime();
  return { connected: refreshExpiry > Date.now(), lastRefresh: row.updated_at };
}

export async function disconnectSchwab(): Promise<void> {
  const supabase = createServerClient();
  await supabase.from("schwab_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

export async function getValidAccessToken(): Promise<string> {
  const row = await loadLatestTokenRow();
  if (!row) throw new Error("Schwab is not connected. Visit /settings to authorize.");

  const accessExpiry = new Date(row.access_token_expires_at).getTime();
  const skewMs = 60_000;
  if (accessExpiry - skewMs > Date.now()) {
    return row.access_token;
  }

  const refreshExpiry = new Date(row.refresh_token_expires_at).getTime();
  if (refreshExpiry <= Date.now()) {
    throw new Error("Schwab refresh token expired. Reconnect at /settings.");
  }

  const fresh = await refreshAccessToken(row.refresh_token);
  await persistTokens(fresh);
  return fresh.access_token;
}

export async function schwabGet<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const token = await getValidAccessToken();
  const url = new URL(path.startsWith("http") ? path : `${SCHWAB_BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Schwab GET ${url.pathname} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export type SchwabOptionContract = {
  putCall: "PUT" | "CALL";
  symbol: string;
  description?: string;
  bid: number;
  ask: number;
  last: number;
  mark: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  volatility: number; // implied vol, percent
  strikePrice: number;
  daysToExpiration: number;
  expirationDate: string;
  openInterest?: number;
  totalVolume?: number;
};

export type SchwabOptionsChain = {
  symbol: string;
  status?: string;
  underlying?: {
    symbol: string;
    last?: number;
    mark?: number;
    close?: number;
    bid?: number;
    ask?: number;
  };
  underlyingPrice?: number;
  putExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
  callExpDateMap: Record<string, Record<string, SchwabOptionContract[]>>;
};

export async function getOptionsChain(
  symbol: string,
  expirationDate?: string,
): Promise<SchwabOptionsChain> {
  const params: Record<string, string | number | boolean> = {
    symbol,
    contractType: "PUT",
    strikeCount: 30,
    includeUnderlyingQuote: true,
    strategy: "SINGLE",
  };
  if (expirationDate) {
    const d = new Date(expirationDate);
    if (!Number.isNaN(d.getTime())) {
      params.fromDate = expirationDate;
      params.toDate = expirationDate;
      const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
      params.expMonth = month;
    }
  }
  return schwabGet<SchwabOptionsChain>(`${MARKETDATA_BASE}/chains`, params);
}

// Range variant — returns every expiration inside [fromDate, toDate] for the
// symbol. Used for the monthly IV lookup, where targeting a single day is
// unreliable (3rd-Friday expiries only rarely coincide with any particular
// day N days out).
export async function getOptionsChainRange(
  symbol: string,
  fromDate: string,
  toDate: string,
): Promise<SchwabOptionsChain> {
  return schwabGet<SchwabOptionsChain>(`${MARKETDATA_BASE}/chains`, {
    symbol,
    contractType: "PUT",
    strikeCount: 30,
    includeUnderlyingQuote: true,
    strategy: "SINGLE",
    fromDate,
    toDate,
  });
}

export type SchwabQuote = {
  symbol: string;
  quote?: {
    lastPrice?: number;
    mark?: number;
    bidPrice?: number;
    askPrice?: number;
    closePrice?: number;
    netChange?: number;
    totalVolume?: number;
  };
};

export async function getQuote(symbol: string): Promise<SchwabQuote | null> {
  try {
    const resp = await schwabGet<Record<string, SchwabQuote>>(`${MARKETDATA_BASE}/${encodeURIComponent(symbol)}/quotes`);
    return resp[symbol] ?? null;
  } catch {
    return null;
  }
}

// Batch quote — one HTTP call for up to ~500 symbols. Schwab accepts comma-separated symbols.
export async function getBatchQuotes(symbols: string[]): Promise<Record<string, SchwabQuote>> {
  if (symbols.length === 0) return {};
  try {
    const resp = await schwabGet<Record<string, SchwabQuote>>(`${MARKETDATA_BASE}/quotes`, {
      symbols: symbols.join(","),
    });
    return resp ?? {};
  } catch (e) {
    console.error("[schwab] getBatchQuotes failed:", e instanceof Error ? e.message : e);
    return {};
  }
}
