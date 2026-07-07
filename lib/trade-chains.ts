// Trade chain reconstruction + classification.
//
// A CHAIN is one campaign on a (symbol, broker): sequential option
// positions linked by roll adjacency (a position opening within 2
// trading days of a prior one closing) plus the stock lots minted by
// assignment (assignment_source_id). Chain grouping is what makes
// Layer 2 honest — per-position stats book each assignment premium as
// a "win" while the offsetting stock loss sits in an invisible row
// (ZS: 89% per-position win rate on a campaign that lost $4,184).
//
// Types:
//   clean         — standard CSP: single-position chain, entered OTM.
//                   Wins AND losses (incl. a dumped assignment) count;
//                   the strategy was played as designed.
//   rolled        — multi-position chain, re-entries still near the
//                   money: recovery via patience.
//   recovery_play — any member entered DEEP ITM (selling ~intrinsic is
//                   a synthetic long, not a CSP) or the chain wheels
//                   through assignment into a deep-ITM re-entry, or a
//                   position was held ≥3 days after the stock traded
//                   ≥8% through the strike.
import { randomUUID } from "node:crypto";
import { createServerClient } from "@/lib/supabase";

export type TradeType = "clean" | "rolled" | "recovery_play";

export type ChainPosition = {
  id: string;
  symbol: string;
  broker: string | null;
  strike: number;
  expiry: string;
  status: string;
  position_type: string | null;
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | null;
  total_contracts: number | null;
  assignment_source_id: string | null;
  entry_stock_price: number | null;
};

export type Chain = {
  chainId: string;
  members: ChainPosition[];
  optionCount: number;
  tradeType: TradeType;
  chainPnl: number;
  peakCapital: number | null;
  reasons: string[];
};

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000,
  );
}

// Roll adjacency: successor opens 0-2 trading days after predecessor
// closes. Approximated on the calendar: ≤2 days always qualifies; 3-4
// days qualifies when the gap spans a weekend (Thu/Fri close).
function rollAdjacent(closedDate: string, openedDate: string): boolean {
  const diff = daysBetween(closedDate, openedDate);
  if (diff < 0) return false;
  if (diff <= 2) return true;
  if (diff <= 4) {
    const dow = new Date(closedDate + "T00:00:00Z").getUTCDay();
    return dow === 4 || dow === 5; // Thu/Fri close → Mon/Tue reopen
  }
  return false;
}

function isStock(p: ChainPosition): boolean {
  return p.position_type === "stock_long" || p.position_type === "stock_short";
}

// Deep-ITM-at-entry: the strongest recovery_play fingerprint. Exact
// test when entry_stock_price is stamped (premium covers ≥80% of a
// ≥5% intrinsic gap); premium/strike ≥ 8% as the proxy for legacy rows
// (OTM weekly CSP premiums run 0.3-3% of strike; the observed
// recovery entries run 10-16%).
export function deepItmAtEntry(p: {
  strike: number;
  entry_stock_price: number | null;
  openPremium: number | null;
}): boolean {
  if (p.openPremium === null || p.openPremium <= 0 || p.strike <= 0) return false;
  const spot = p.entry_stock_price;
  if (spot !== null && spot > 0 && spot < p.strike) {
    const intrinsic = p.strike - spot;
    if (intrinsic / p.strike >= 0.05 && p.openPremium >= intrinsic * 0.8) return true;
  }
  return p.openPremium / p.strike >= 0.08;
}

type FillLite = { position_id: string; fill_type: string; contracts: number; premium: number };

// Union-find
class UF {
  parent = new Map<string, string>();
  find(x: string): string {
    let r = this.parent.get(x) ?? x;
    if (r !== x) {
      r = this.find(r);
      this.parent.set(x, r);
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export type ClassifiedChains = { chains: Chain[] };

// Build + classify chains for one user's positions on one symbol (or
// all symbols when symbol is null). Pure computation over the rows
// passed in — callers fetch.
export function buildChains(
  positions: ChainPosition[],
  openPremiumByPosition: Map<string, number | null>,
  deepSnapshotPositions: Set<string>,
): Chain[] {
  const uf = new UF();
  const byId = new Map(positions.map((p) => [p.id, p]));

  // 1. Assignment links: stock lot ↔ source put.
  for (const p of positions) {
    if (p.assignment_source_id && byId.has(p.assignment_source_id)) {
      uf.union(p.id, p.assignment_source_id);
    }
  }

  // 2. Roll adjacency within (symbol, broker): any member (option or
  //    stock) closing, followed by an option opening within the window.
  const byGroup = new Map<string, ChainPosition[]>();
  for (const p of positions) {
    const k = `${p.symbol}|${(p.broker ?? "").toLowerCase()}`;
    const arr = byGroup.get(k) ?? [];
    arr.push(p);
    byGroup.set(k, arr);
  }
  for (const group of Array.from(byGroup.values())) {
    for (const a of group) {
      if (!a.closed_date) continue;
      for (const b of group) {
        if (a.id === b.id || isStock(b)) continue;
        // A roll SUCCEEDS its predecessor: b must open at/after a's
        // close AND strictly after a's open. Without the second test,
        // parallel same-day strikes (e.g. 410P + 412.5P both opened and
        // closed on the same day) chain into a phantom "roll".
        if (
          rollAdjacent(a.closed_date, b.opened_date) &&
          b.opened_date > a.opened_date
        ) {
          uf.union(a.id, b.id);
        }
      }
    }
  }

  // 3. Materialize chains.
  const membersByRoot = new Map<string, ChainPosition[]>();
  for (const p of positions) {
    const root = uf.find(p.id);
    const arr = membersByRoot.get(root) ?? [];
    arr.push(p);
    membersByRoot.set(root, arr);
  }

  const chains: Chain[] = [];
  for (const members of Array.from(membersByRoot.values())) {
    members.sort((a, b) => a.opened_date.localeCompare(b.opened_date));
    const options = members.filter((p) => !isStock(p));
    const reasons: string[] = [];

    // ---- classify ----
    let tradeType: TradeType = "clean";
    const deepEntry = options.filter((p) =>
      deepItmAtEntry({
        strike: Number(p.strike),
        entry_stock_price:
          p.entry_stock_price !== null ? Number(p.entry_stock_price) : null,
        openPremium: openPremiumByPosition.get(p.id) ?? null,
      }),
    );
    const heldDeep = options.filter((p) => deepSnapshotPositions.has(p.id));
    const wheeled =
      members.some(
        (p) =>
          isStock(p) &&
          Number(p.realized_pnl ?? 0) < 0 &&
          p.assignment_source_id !== null,
      ) && options.length >= 2;

    if (deepEntry.length > 0) {
      tradeType = "recovery_play";
      reasons.push(
        `deep ITM at entry: ${deepEntry.map((p) => `$${p.strike}P ${p.expiry}`).join(", ")}`,
      );
    } else if (heldDeep.length > 0) {
      tradeType = "recovery_play";
      reasons.push(
        `held ≥3d with stock ≥8% through strike: ${heldDeep.map((p) => `$${p.strike}P ${p.expiry}`).join(", ")}`,
      );
    } else if (wheeled) {
      tradeType = "recovery_play";
      reasons.push("assignment wheel: stock lot sold at a loss, new put re-sold");
    } else if (options.length >= 2) {
      tradeType = "rolled";
      reasons.push(`${options.length} sequential positions (roll adjacency)`);
    } else {
      reasons.push("single position, entered OTM");
    }

    // ---- chain P&L ----
    const chainPnl =
      Math.round(members.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0) * 100) /
      100;

    // ---- peak capital: day-swept max of concurrent collateral ----
    // Options: strike × contracts × 100 (total_contracts = ever-opened;
    // slight overcount after partial closes, acceptable). Stock lots:
    // cost basis × opened shares (shares from the open fill would be
    // exact; entry_stock_price × parent-contract shares approximates
    // when total_contracts has been decremented to remaining=0).
    let peakCapital: number | null = null;
    const spans = members
      .map((p) => {
        const start = p.opened_date;
        const end = p.closed_date ?? p.opened_date;
        let capital = 0;
        if (isStock(p)) {
          const basis = Number(p.entry_stock_price ?? 0);
          // stock total_contracts tracks REMAINING shares (0 once sold)
          // — recover opened shares from the source put when linked.
          const parent = p.assignment_source_id
            ? byId.get(p.assignment_source_id)
            : null;
          const shares =
            Number(p.total_contracts ?? 0) > 0
              ? Number(p.total_contracts)
              : parent
                ? Number(parent.total_contracts ?? 0) * 100
                : 0;
          capital = basis * shares;
        } else {
          capital = Number(p.strike) * Number(p.total_contracts ?? 0) * 100;
        }
        return { start, end, capital };
      })
      .filter((s) => s.capital > 0);
    if (spans.length > 0) {
      const days = new Set<string>();
      for (const s of spans) {
        let cursor = s.start;
        let guard = 0;
        while (cursor <= s.end && guard < 400) {
          days.add(cursor);
          const d = new Date(cursor + "T00:00:00Z");
          d.setUTCDate(d.getUTCDate() + 1);
          cursor = d.toISOString().slice(0, 10);
          guard += 1;
        }
      }
      let max = 0;
      for (const day of Array.from(days)) {
        const total = spans.reduce(
          (sum, s) => (s.start <= day && day <= s.end ? sum + s.capital : sum),
          0,
        );
        if (total > max) max = total;
      }
      peakCapital = Math.round(max * 100) / 100;
    }

    chains.push({
      chainId: randomUUID(),
      members,
      optionCount: options.length,
      tradeType,
      chainPnl,
      peakCapital,
      reasons,
    });
  }
  return chains;
}

// Fetch everything needed and classify one user's positions (optionally
// one symbol). Returns chains without writing anything.
export async function classifyUserChains(
  userId: string,
  symbol?: string,
): Promise<Chain[]> {
  const sb = createServerClient();
  let q = sb
    .from("positions")
    .select(
      "id,symbol,broker,strike,expiry,status,position_type,opened_date,closed_date,realized_pnl,total_contracts,assignment_source_id,entry_stock_price",
    )
    .eq("user_id", userId);
  if (symbol) q = q.eq("symbol", symbol.toUpperCase());
  const posRes = await q;
  if (posRes.error) throw new Error(`positions fetch failed: ${posRes.error.message}`);
  const positions = (posRes.data ?? []) as ChainPosition[];
  if (positions.length === 0) return [];

  const ids = positions.map((p) => p.id);

  // Contracts-weighted average open premium per position.
  const openPremiumByPosition = new Map<string, number | null>();
  {
    const acc = new Map<string, { v: number; c: number }>();
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150));
    for (const chunk of chunks) {
      const fr = await sb
        .from("fills")
        .select("position_id,fill_type,contracts,premium")
        .in("position_id", chunk)
        .eq("fill_type", "open");
      for (const f of (fr.data ?? []) as FillLite[]) {
        const a = acc.get(f.position_id) ?? { v: 0, c: 0 };
        a.v += Number(f.premium) * Number(f.contracts);
        a.c += Number(f.contracts);
        acc.set(f.position_id, a);
      }
    }
    for (const [pid, a] of Array.from(acc.entries())) {
      openPremiumByPosition.set(pid, a.c > 0 ? a.v / a.c : null);
    }
  }

  // Positions whose snapshots show the stock ≥8% through the strike
  // with the position still open ≥3 days after that observation.
  const deepSnapshotPositions = new Set<string>();
  {
    const posById = new Map(positions.map((p) => [p.id, p]));
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150));
    for (const chunk of chunks) {
      const sr = await sb
        .from("position_snapshots")
        .select("position_id,stock_price,snapshot_time")
        .in("position_id", chunk);
      for (const s of (sr.data ?? []) as Array<{
        position_id: string;
        stock_price: number | null;
        snapshot_time: string;
      }>) {
        const p = posById.get(s.position_id);
        if (!p || isStock(p) || s.stock_price === null) continue;
        if (Number(s.stock_price) < Number(p.strike) * 0.92) {
          const snapDay = s.snapshot_time.slice(0, 10);
          const end = p.closed_date ?? new Date().toISOString().slice(0, 10);
          if (daysBetween(snapDay, end) >= 3) deepSnapshotPositions.add(p.id);
        }
      }
    }
  }

  return buildChains(positions, openPremiumByPosition, deepSnapshotPositions);
}

// Persist chain assignments. skipConfirmed leaves user-confirmed rows
// untouched (retroactive re-runs must not clobber manual overrides).
// NOTE: implemented by pre-reading sources rather than a .neq filter —
// PostgREST's neq excludes NULL rows, which would skip every
// still-unclassified position.
export async function persistChains(
  chains: Chain[],
  source: "auto" | "user",
  opts?: { skipConfirmed?: boolean },
): Promise<number> {
  const sb = createServerClient();
  const confirmed = new Set<string>();
  if (opts?.skipConfirmed) {
    const allIds = chains.flatMap((c) => c.members.map((m) => m.id));
    for (let i = 0; i < allIds.length; i += 150) {
      const r = await sb
        .from("positions")
        .select("id,trade_type_source")
        .in("id", allIds.slice(i, i + 150));
      for (const row of (r.data ?? []) as Array<{ id: string; trade_type_source: string | null }>) {
        if (row.trade_type_source === "user") confirmed.add(row.id);
      }
    }
  }
  let updated = 0;
  for (const chain of chains) {
    for (const m of chain.members) {
      if (confirmed.has(m.id)) continue;
      const r = await sb
        .from("positions")
        .update({
          trade_chain_id: chain.chainId,
          trade_type: chain.tradeType,
          trade_type_source: source,
          chain_pnl: chain.chainPnl,
          peak_capital: chain.peakCapital,
        })
        .eq("id", m.id);
      if (!r.error) updated += 1;
    }
  }
  return updated;
}
