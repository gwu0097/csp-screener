// Shared SEC EDGAR client — ticker->CIK resolution, rate limiting,
// User-Agent, and a common fall-through result shape. Two thin callers
// are built on top of this file: lib/edgar-fiscal-period.ts (the
// companyconcept API, resolving fiscal_quarter/fiscal_year/period_end —
// used by the 2026-09-04 eps-quarter repair) and
// lib/edgar-earnings-date.ts (the submissions API, resolving/confirming
// earnings_date — for the separate queued earnings-date-resolution
// work). Both share this file's CIK map, rate limiter, and User-Agent
// so a symbol only ever resolves to a CIK once per process, and both
// callers honor the same SEC rate-limit discipline instead of each
// re-inventing it.
//
// SEC's developer guidance (https://www.sec.gov/os/webmaster-faq#developers)
// asks for a descriptive User-Agent identifying the requester, and a
// conservative request rate (SEC's own stated ceiling is 10 req/s across
// all their APIs) — this client paces every call well under that,
// independent of caller.
import { createServerClient } from "./supabase";

const EDGAR_CONTACT_EMAIL = process.env.EDGAR_CONTACT_EMAIL;
const USER_AGENT = EDGAR_CONTACT_EMAIL
  ? `csp-screener-personal-use ${EDGAR_CONTACT_EMAIL}`
  : null;

const RATE_DELAY_MS = 150;
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86_400_000);
}

async function throttledFetch(url: string): Promise<Response> {
  // No hardcoded fallback — a fake/missing contact would be dishonest
  // to SEC and risks the requester's IP getting rate-limited or blocked
  // for the whole app, not just this feature. See ROBINHOOD_ACCOUNT_NUMBER
  // for the same "no default in a public repo" convention.
  if (!USER_AGENT) {
    throw new Error("EDGAR_CONTACT_EMAIL not set in .env.local — required for a compliant SEC User-Agent");
  }
  const wait = RATE_DELAY_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  return fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
}

export type EdgarResult<T> = { resolved: true; value: T } | { resolved: false; reason: string };

export async function edgarGet<T>(url: string): Promise<EdgarResult<T>> {
  try {
    const res = await throttledFetch(url);
    if (!res.ok) return { resolved: false, reason: `http_${res.status}` };
    const json = (await res.json()) as T;
    return { resolved: true, value: json };
  } catch (e) {
    return { resolved: false, reason: e instanceof Error ? e.message : "fetch_error" };
  }
}

type TickerEntry = { cik_str: number; ticker: string; title: string };

let cikMapPromise: Promise<Map<string, string>> | null = null;

async function loadCikMap(): Promise<Map<string, string>> {
  const res = await edgarGet<Record<string, TickerEntry>>("https://www.sec.gov/files/company_tickers.json");
  if (!res.resolved) throw new Error(`company_tickers.json fetch failed: ${res.reason}`);
  const map = new Map<string, string>();
  for (const entry of Object.values(res.value)) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
  }
  return map;
}

// company_tickers.json only lists CURRENTLY active filers — a ticker
// whose company has since been acquired, merged, or taken private drops
// out of it even though SEC still has its full CIK and filing history
// intact. Ported from the identical fix in lib/sec-edgar.ts's getCIK
// (confirmed 2026-09-05: resolveFiscalPeriod/resolveNearestEightK both
// route through THIS file's resolveCik, not lib/sec-edgar.ts's getCIK —
// those are two separate, independent EDGAR clients, not one shared
// chokepoint, so the earlier fix never reached this population).
// Duplicated rather than unified into one client: that's a larger
// refactor than this fix needs. Tested against the 527 distinct symbols
// in the earnings-date target population: 512 resolve without this
// fallback, 526 with it.
//
// browse-edgar's action=getcompany accepts a ticker directly in the
// CIK= param (a long-standing EDGAR quirk, not a documented API
// contract) and searches the full historical company index, not just
// active listings. Reuses this file's own throttledFetch so the
// fallback shares the same rate limit as every other call here, rather
// than opening a second pacing clock.
async function resolveCikForDelistedTicker(symbol: string): Promise<string | null> {
  try {
    const res = await throttledFetch(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol.toUpperCase())}&type=10-K&dateb=&owner=include&count=1&output=atom`,
    );
    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/<cik>(\d{10})<\/cik>/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Fetched once per process — company_tickers.json is one file covering
// every US-listed ticker (a few thousand rows), not worth re-fetching
// per symbol. Both edgar-fiscal-period.ts and edgar-earnings-date.ts
// call this, sharing the same in-flight/cached promise.
export async function resolveCik(symbol: string): Promise<EdgarResult<string>> {
  if (!cikMapPromise) cikMapPromise = loadCikMap();
  const map = await cikMapPromise;
  const cik = map.get(symbol.toUpperCase());
  if (cik) return { resolved: true, value: cik };
  const fallback = await resolveCikForDelistedTicker(symbol);
  return fallback ? { resolved: true, value: fallback } : { resolved: false, reason: "cik_not_found" };
}

// Shared with both EDGAR callers so a repair/backfill script logs its
// attempts the same way eps-sweep already does (recordAncillaryAttempt),
// making "when was this row last checked" queryable regardless of which
// EDGAR caller did the checking.
export type EdgarAttemptPhase = "edgar-fiscal-period" | "edgar-earnings-date";

export async function recordEdgarAttempt(opts: {
  earningsHistoryId: string;
  symbol: string;
  earningsDate: string;
  phase: EdgarAttemptPhase;
  outcome: string;
  errorMessage?: string;
}): Promise<void> {
  const sb = createServerClient();
  try {
    await sb.from("earnings_capture_attempts").insert({
      earnings_history_id: opts.earningsHistoryId,
      symbol: opts.symbol,
      earnings_date: opts.earningsDate,
      capture_phase: opts.phase,
      outcome: opts.outcome,
      error_message: opts.errorMessage ?? null,
    });
  } catch {
    // best-effort logging — never let a logging failure break the caller
  }
}
