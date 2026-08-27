// Covered-call roll-chain linking. Deliberately separate from
// lib/trade-chains.ts's CSP chain builder — that classifier exists
// specifically to detect CSP-put recovery patterns (deep-ITM entries,
// assignment wheels) and, as of 2026-08-27, explicitly excludes
// covered calls (option_type='call' AND direction='short') from
// classification entirely, since a normal covered-call roll was
// tripping the same "2+ legs -> rolled" branch a real CSP recovery
// would. This module reuses the proven roll-adjacency ALGORITHM but
// carries none of the CSP-recovery classification logic, and writes
// its own dedicated column (positions.covered_call_chain_id, not
// trade_chain_id) so a covered call can never surface to the CSP-only
// readers that already explicitly exclude broker='covered_calls'
// (app/api/intelligence/route.ts, lib/screener.ts).
//
// No stock-lot linking (unlike the CSP wheel sweep): the same shares
// back every leg of a covered-call roll until final assignment, so
// there's no separate stock position to union in.
//
// Scope: any short call, any broker (option_type='call' AND
// direction='short') — same broker-agnostic definition already used
// to exclude covered calls from CSP classification in
// lib/trade-chains.ts. Deliberately NOT restricted to
// broker='covered_calls': rolls are placed directly at Schwab/
// Robinhood, which have no concept of that pseudo-account, so the
// new leg lands auto-imported under broker='schwab'/'schwab2'/
// 'robinhood'. Restricting to covered_calls would require a manual
// "Move Account" on every single rolled leg for the chain to link,
// defeating auto-detection entirely.
import { randomUUID } from "node:crypto";
import { createServerClient } from "@/lib/supabase";

export type CoveredCallPosition = {
  id: string;
  symbol: string;
  broker: string;
  strike: number;
  expiry: string;
  status: string;
  opened_date: string;
  closed_date: string | null;
  realized_pnl: number | null;
};

export type CoveredCallChain = {
  chainId: string;
  members: CoveredCallPosition[];
  // Sum of realized_pnl across every CLOSED member. Already nets
  // correctly per leg — assignment always closes at synthetic $0
  // (full premium kept, lib/expire-positions.ts::recordAssignment's
  // Option A accounting), and a voluntary buy-back-to-roll uses the
  // real realizedPnl() formula, so a net-debit roll shows as a real
  // cost here, not hidden.
  totalPremium: number;
  // True when the most recent member (by opened_date) is still open —
  // the chain could still roll again.
  stillOpen: boolean;
  // Set only once the most recent member reaches a terminal state
  // with no further leg opened after it.
  resolution: "assigned" | "expired_worthless" | null;
};

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// Identical window to lib/trade-chains.ts::rollAdjacent — duplicated,
// not imported, per this module's zero-coupling header comment.
function rollAdjacent(closedDate: string, openedDate: string): boolean {
  const diff = daysBetween(closedDate, openedDate);
  if (diff < 0) return false;
  if (diff <= 2) return true;
  if (diff <= 4) {
    const dow = new Date(closedDate + "T00:00:00Z").getUTCDay();
    return dow === 4 || dow === 5; // Thu/Fri close -> Mon/Tue reopen
  }
  return false;
}

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

// Pure computation over the rows passed in — caller fetches. Callers
// must pre-filter to short calls only; this function doesn't re-check
// option_type/direction so it can be exercised directly against a
// symbol's worth of already-scoped rows. Broker IS re-checked here
// (see the same-broker guard below), since the caller now fetches
// across all brokers.
export function buildCoveredCallChains(positions: CoveredCallPosition[]): CoveredCallChain[] {
  const uf = new UF();
  const byGroup = new Map<string, CoveredCallPosition[]>();
  for (const p of positions) {
    const arr = byGroup.get(p.symbol) ?? [];
    arr.push(p);
    byGroup.set(p.symbol, arr);
  }
  for (const group of Array.from(byGroup.values())) {
    for (const a of group) {
      if (!a.closed_date) continue;
      for (const b of group) {
        if (a.id === b.id) continue;
        // Same-broker guard: a roll happens within one account, so
        // don't link a close in one broker to an open in another —
        // that's two independent covered-call sequences on the same
        // underlying coinciding in time, not a roll.
        if (a.broker !== b.broker) continue;
        // Same "succeeds its predecessor" guard as the CSP builder —
        // b must open at/after a's close AND strictly after a's open,
        // so two same-day parallel strikes don't chain into a
        // phantom roll.
        if (rollAdjacent(a.closed_date, b.opened_date) && b.opened_date > a.opened_date) {
          uf.union(a.id, b.id);
        }
      }
    }
  }

  const membersByRoot = new Map<string, CoveredCallPosition[]>();
  for (const p of positions) {
    const root = uf.find(p.id);
    const arr = membersByRoot.get(root) ?? [];
    arr.push(p);
    membersByRoot.set(root, arr);
  }

  const chains: CoveredCallChain[] = [];
  for (const members of Array.from(membersByRoot.values())) {
    members.sort((a, b) => a.opened_date.localeCompare(b.opened_date));
    const totalPremium =
      Math.round(
        members
          .filter((p) => p.status !== "open")
          .reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0) * 100,
      ) / 100;
    const latest = members[members.length - 1];
    const stillOpen = latest.status === "open";
    const resolution: CoveredCallChain["resolution"] = stillOpen
      ? null
      : latest.status === "assigned"
        ? "assigned"
        : latest.status === "expired_worthless"
          ? "expired_worthless"
          : null;
    chains.push({ chainId: randomUUID(), members, totalPremium, stillOpen, resolution });
  }
  return chains;
}

// Fetches, builds, and persists covered_call_chain_id for one user
// (optionally scoped to one symbol). Purely mechanical linking — no
// "user override" concept needed the way trade_type has one: there's
// no ambiguous judgment call here to protect from being clobbered by
// a retroactive re-run, so every call simply overwrites.
export async function classifyAndPersistCoveredCallChains(
  userId: string,
  symbol?: string,
): Promise<{ chainsWritten: number; membersUpdated: number }> {
  const sb = createServerClient();
  let q = sb
    .from("positions")
    .select("id,symbol,broker,strike,expiry,status,opened_date,closed_date,realized_pnl")
    .eq("user_id", userId)
    .eq("position_type", "option")
    .eq("option_type", "call")
    .eq("direction", "short");
  if (symbol) q = q.eq("symbol", symbol.toUpperCase());
  const res = await q;
  if (res.error) throw new Error(`covered-call positions fetch failed: ${res.error.message}`);
  const positions = (res.data ?? []) as CoveredCallPosition[];
  if (positions.length === 0) return { chainsWritten: 0, membersUpdated: 0 };

  const chains = buildCoveredCallChains(positions);
  let membersUpdated = 0;
  let chainsWritten = 0;
  for (const chain of chains) {
    // Single-position "chains" are the common (never-rolled) case —
    // leave covered_call_chain_id null so the UI has nothing extra to
    // show for the majority of covered calls.
    if (chain.members.length < 2) continue;
    chainsWritten += 1;
    for (const m of chain.members) {
      const upd = await sb
        .from("positions")
        .update({ covered_call_chain_id: chain.chainId })
        .eq("id", m.id)
        .eq("user_id", userId);
      if (!upd.error) membersUpdated += 1;
    }
  }
  return { chainsWritten, membersUpdated };
}
