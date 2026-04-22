import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export function createServerClient(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase server credentials are missing");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

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
