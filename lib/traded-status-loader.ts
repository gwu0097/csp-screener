// I/O half of the screener's Position column: loads one user's short
// puts, their campaigns, open-contract counts and manual marks, then
// hands them to the pure matcher in lib/traded-status.ts. Throws on any
// failed read (the route turns that into a 500) — never returns an
// empty map for a failed source.
import { createServerClient } from "@/lib/supabase";
import { remainingContracts, type Fill } from "@/lib/positions";
import {
  resolveTradedStatus,
  tradedKey,
  type TradedEvent,
  type TradedPositionRow,
  type TradedStatus,
} from "@/lib/traded-status";

// Positions opened this long before the earliest requested print can't
// span it on a weekly/monthly CSP; bounds the read well under the
// wrapper's ~1000-row cap.
const POSITION_LOOKBACK_DAYS = 60;

export async function loadTradedStatuses(
  userId: string,
  events: readonly TradedEvent[],
): Promise<Map<string, TradedStatus>> {
  if (events.length === 0) return new Map();
  const symbols = Array.from(new Set(events.map((e) => e.symbol)));
  const earliest = events.map((e) => e.earningsDate).sort()[0];
  const floor = new Date(Date.parse(earliest + "T00:00:00Z") - POSITION_LOOKBACK_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);

  const sb = createServerClient();
  const [posRes, markRes] = await Promise.all([
    sb
      .from("positions")
      .select("id,symbol,status,broker,strike,expiry,opened_date,total_contracts,option_type,direction,position_type,campaign_id")
      .eq("user_id", userId)
      .in("symbol", symbols)
      .eq("option_type", "put")
      .eq("direction", "short")
      .gte("opened_date", floor),
    sb
      .from("screener_traded_marks")
      .select("symbol,earnings_date,created_at")
      .eq("user_id", userId)
      .in("symbol", symbols),
  ]);
  if (posRes.error) throw new Error(`positions: ${posRes.error.message}`);
  if (markRes.error) throw new Error(`screener_traded_marks: ${markRes.error.message}`);

  const positions = (posRes.data ?? []) as Array<
    Omit<TradedPositionRow, "campaign_earnings_date" | "open_contracts"> & { id: string; campaign_id: string | null }
  >;
  // Open contracts = opened minus closed fills, same count the Positions
  // page uses. Only open positions need it (closed ones hold no capital).
  const openIds = positions.filter((p) => p.status === "open").map((p) => p.id);
  const fillsByPosition = new Map<string, Fill[]>();
  if (openIds.length > 0) {
    const fillRes = await sb.from("fills").select("position_id,fill_type,contracts").in("position_id", openIds);
    if (fillRes.error) throw new Error(`fills: ${fillRes.error.message}`);
    for (const f of (fillRes.data ?? []) as Array<{ position_id: string; fill_type: Fill["fill_type"]; contracts: number }>) {
      const arr = fillsByPosition.get(f.position_id) ?? [];
      arr.push({ fill_type: f.fill_type, contracts: Number(f.contracts), premium: 0, fill_date: "" });
      fillsByPosition.set(f.position_id, arr);
    }
  }
  const campaignIds = Array.from(new Set(positions.map((p) => p.campaign_id).filter((id): id is string => !!id)));
  const campaignDate = new Map<string, string>();
  if (campaignIds.length > 0) {
    const campRes = await sb
      .from("campaigns")
      .select("id,earnings_date")
      .eq("user_id", userId)
      .in("id", campaignIds);
    if (campRes.error) throw new Error(`campaigns: ${campRes.error.message}`);
    for (const c of (campRes.data ?? []) as Array<{ id: string; earnings_date: string }>) {
      campaignDate.set(c.id, c.earnings_date);
    }
  }

  const rows: TradedPositionRow[] = positions.map(({ campaign_id, id, ...p }) => ({
    ...p,
    open_contracts:
      p.status !== "open" ? 0 : fillsByPosition.has(id) ? remainingContracts(fillsByPosition.get(id)!) : null,
    campaign_earnings_date: campaign_id ? campaignDate.get(campaign_id) ?? null : null,
  }));
  const marks = new Map(
    ((markRes.data ?? []) as Array<{ symbol: string; earnings_date: string; created_at: string }>).map((m) => [
      tradedKey(m.symbol, m.earnings_date),
      m.created_at,
    ]),
  );
  return resolveTradedStatus(events, rows, marks, new Date().toISOString().slice(0, 10));
}
