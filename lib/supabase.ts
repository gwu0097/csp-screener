// PostgREST-backed Supabase client. Replaces @supabase/supabase-js on the
// server because that library silently returns `data: []` on reads from
// Vercel's serverless runtime (diagnosed 2026-04-22 — raw fetch to the same
// URL with the same service-role key returns 29 rows, the client returns 0).
//
// The builder below mirrors just the supabase-js surface our routes use:
//   .from(t).select(cols?).eq/.neq/.is/.in/.gt/.gte/.lt/.lte/.order/.limit/.single()
//   .from(t).insert(row).select?().single?()
//   .from(t).update(patch).eq(...).select?().single?()
//   .from(t).delete().eq/.neq(...)
//   .from(t).upsert(row)
//
// Await semantics match supabase-js: resolves to `{ data, error }` where
// error is a `{ message: string }` on non-2xx, otherwise null. `.single()`
// errors if the result isn't exactly one row.
//
// The browser client (anon key) is left alone — RLS-gated reads from the
// browser continue to use supabase-js since that's a different code path.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export type PgError = { message: string; code?: string; details?: string; hint?: string };
export type PgResult<T> = { data: T | null; error: PgError | null };

// PostgREST filter value encoding. Strings can contain commas/parens that
// break the URL shape; we quote them when needed.
function fvalue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  // If the string contains any of ,()" or leading whitespace, quote it.
  if (/[,()"\s]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

type Verb = "GET" | "POST" | "PATCH" | "DELETE";

// Default T=any so `data.length` / `data.map(...)` on an untyped .from()
// call compile. Callers can tighten with .from<MyRow>("t") when they want
// a narrower type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
class Query<T = any> implements PromiseLike<PgResult<T>> {
  private verb: Verb = "GET";
  private filters: string[] = [];
  private orderSpec: string | null = null;
  private limitN: number | null = null;
  private selectCols: string | null = null;
  private body: unknown = undefined;
  private prefer: string[] = [];
  // .single() errors on 0 or >1 rows. .maybeSingle() returns null for 0
  // rows and errors only on >1.
  private expectSingle = false;
  private expectMaybeSingle = false;
  private wantReturn = false;
  private onConflictCol: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly table: string,
  ) {}

  // ---- select / write verbs ----
  select(cols = "*"): this {
    this.selectCols = cols;
    // If we've already switched to a write verb, this means "return the
    // modified rows" — PostgREST does that via Prefer: return=representation.
    if (this.verb !== "GET") {
      this.wantReturn = true;
      this.prefer.push("return=representation");
    }
    return this;
  }

  insert(row: unknown): this {
    this.verb = "POST";
    this.body = row;
    return this;
  }

  update(patch: unknown): this {
    this.verb = "PATCH";
    this.body = patch;
    return this;
  }

  delete(): this {
    this.verb = "DELETE";
    return this;
  }

  upsert(row: unknown, opts?: { onConflict?: string }): this {
    this.verb = "POST";
    this.body = row;
    this.prefer.push("resolution=merge-duplicates");
    if (opts?.onConflict) this.onConflictCol = opts.onConflict;
    return this;
  }

  // ---- filters ----
  eq(col: string, val: unknown): this {
    this.filters.push(`${col}=eq.${encodeURIComponent(fvalue(val))}`);
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push(`${col}=neq.${encodeURIComponent(fvalue(val))}`);
    return this;
  }
  is(col: string, val: unknown): this {
    this.filters.push(`${col}=is.${encodeURIComponent(fvalue(val))}`);
    return this;
  }
  in(col: string, arr: readonly unknown[]): this {
    const inner = arr.map((v) => fvalue(v)).join(",");
    this.filters.push(`${col}=in.(${encodeURIComponent(inner)})`);
    return this;
  }
  gt(col: string, v: unknown): this {
    this.filters.push(`${col}=gt.${encodeURIComponent(fvalue(v))}`);
    return this;
  }
  gte(col: string, v: unknown): this {
    this.filters.push(`${col}=gte.${encodeURIComponent(fvalue(v))}`);
    return this;
  }
  lt(col: string, v: unknown): this {
    this.filters.push(`${col}=lt.${encodeURIComponent(fvalue(v))}`);
    return this;
  }
  lte(col: string, v: unknown): this {
    this.filters.push(`${col}=lte.${encodeURIComponent(fvalue(v))}`);
    return this;
  }

  // ---- modifiers ----
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderSpec = `${col}.${opts?.ascending === false ? "desc" : "asc"}`;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  single(): this {
    // supabase-js single() enforces exactly 1 row. We fetch 2 and error if !=1.
    this.expectSingle = true;
    if (this.limitN === null) this.limitN = 2;
    return this;
  }

  // 0 rows → data:null, no error. >1 rows → error. 1 row → that row.
  maybeSingle(): this {
    this.expectMaybeSingle = true;
    if (this.limitN === null) this.limitN = 2;
    return this;
  }

  // ---- execute ----
  private buildUrl(): string {
    const parts: string[] = [];
    if (this.verb === "GET" || this.wantReturn) {
      parts.push(`select=${this.selectCols ?? "*"}`);
    }
    parts.push(...this.filters);
    if (this.orderSpec) parts.push(`order=${this.orderSpec}`);
    if (this.limitN !== null) parts.push(`limit=${this.limitN}`);
    if (this.onConflictCol) parts.push(`on_conflict=${encodeURIComponent(this.onConflictCol)}`);
    const qs = parts.length > 0 ? `?${parts.join("&")}` : "";
    return `${this.baseUrl}/rest/v1/${this.table}${qs}`;
  }

  private async execute(): Promise<PgResult<T>> {
    const url = this.buildUrl();
    const headers: Record<string, string> = {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.prefer.length > 0) headers["Prefer"] = this.prefer.join(",");

    const init: RequestInit = { method: this.verb, headers, cache: "no-store" };
    if (this.body !== undefined) init.body = JSON.stringify(this.body);

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : String(e) },
      };
    }

    const bodyText = await res.text();
    if (!res.ok) {
      let pg: PgError = { message: `HTTP ${res.status}: ${bodyText.slice(0, 300)}` };
      try {
        const parsed = JSON.parse(bodyText) as PgError;
        if (parsed.message) pg = parsed;
      } catch {
        /* bodyText kept as message */
      }
      return { data: null, error: pg };
    }

    // A write with no `Prefer: return=representation` returns empty body.
    if (bodyText.length === 0) {
      return { data: null, error: null };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (e) {
      return {
        data: null,
        error: {
          message: `Non-JSON response: ${e instanceof Error ? e.message : e}`,
        },
      };
    }

    if (this.expectSingle) {
      if (!Array.isArray(parsed) || parsed.length !== 1) {
        const n = Array.isArray(parsed) ? parsed.length : "n/a";
        return {
          data: null,
          error: {
            message: `single() expected exactly 1 row, got ${n}`,
            code: "PGRST116",
          },
        };
      }
      return { data: parsed[0] as T, error: null };
    }

    if (this.expectMaybeSingle) {
      if (!Array.isArray(parsed)) {
        return { data: parsed as T, error: null };
      }
      if (parsed.length === 0) return { data: null, error: null };
      if (parsed.length === 1) return { data: parsed[0] as T, error: null };
      return {
        data: null,
        error: {
          message: `maybeSingle() expected 0 or 1 rows, got ${parsed.length}`,
          code: "PGRST116",
        },
      };
    }

    return { data: parsed as T, error: null };
  }

  then<R1 = PgResult<T>, R2 = never>(
    onFulfilled?: ((v: PgResult<T>) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onFulfilled, onRejected);
  }
}

export type RestClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: <T = any>(table: string) => Query<T>;
};

function makeRestClient(url: string, key: string): RestClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from: <T = any>(table: string) => new Query<T>(url, key, table),
  };
}

// Returns a PostgREST-backed client that keeps the supabase-js call shape.
// Writes go through the same REST transport — @supabase/supabase-js is no
// longer invoked on the server side.
export function createServerClient(): RestClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase server credentials are missing");
  }
  return makeRestClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

// Browser client still uses supabase-js — RLS-gated anon reads, and the
// supabase-js auth helpers are the path of least resistance there.
export function createBrowserClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase public credentials are missing");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}

export type SchwabTokenRow = {
  id: string;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  refresh_token_expires_at: string;
  updated_at: string;
};

export type TradeAction = "open" | "close";

export type TradeRow = {
  id: string;
  symbol: string;
  trade_date: string;
  earnings_date: string;
  entry_stock_price: number | null;
  strike: number;
  expiry: string;
  premium_sold: number;
  premium_bought: number | null;
  closed_at: string | null;
  outcome: string | null;
  crush_grade: string | null;
  opportunity_grade: string | null;
  notes: string | null;
  created_at: string;
  // Added in migration 004 — trades_and_market_context.sql.
  broker: string | null;
  contracts: number | null;
  action: TradeAction | null;
  parent_trade_id: string | null;
  stock_price_at_entry: number | null;
  stock_price_at_close: number | null;
  delta_at_entry: number | null;
  em_pct_at_entry: number | null;
  strike_multiple: number | null;
};

export type MarketContextRow = {
  id: string;
  date: string;
  vix: number | null;
  spy_price: number | null;
  market_regime: string | null;
  created_at: string;
};
