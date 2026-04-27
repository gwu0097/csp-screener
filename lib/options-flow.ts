// Options flow analytics for the CSP screener expanded row. Pulls the
// full ALL-side chain (calls + puts) for the candidate's expiry and
// derives:
//   - put/call volume + OI ratios + a coarse bias label
//   - unusual-activity strikes (vol/OI > 3, OI ≥ 30)
//   - deep-OTM put cluster between 1× and 2.5× EM below spot
//   - flow at the suggested put strike
//
// Standalone helper — does not mutate the chain caller passes in. Lives
// here (not lib/screener.ts) so the screener pipeline stays focused on
// grading + the per-symbol Schwab fetch shape can evolve independently.

import {
  schwabGet,
  type SchwabOptionContract,
  type SchwabOptionsChain,
} from "@/lib/schwab";

const MARKETDATA_BASE = "/marketdata/v1";

const VOL_OI_UNUSUAL_THRESHOLD = 3;
const MIN_OI_FOR_UNUSUAL = 30;
const PC_BULLISH_BELOW = 0.8;
const PC_BEARISH_ABOVE = 1.3;
const DEEP_OTM_CLUSTER_PCT_THRESHOLD = 25;

export type UnusualStrike = {
  type: "call" | "put";
  strike: number;
  volume: number;
  oi: number;
  volOiRatio: number;
  delta: number;
  mark: number;
  note:
    | "upside lottery"
    | "directional bet"
    | "ATM hedge"
    | "tail hedge"
    | "unusual";
};

export type DeepOtmPutCluster = {
  // Strike band = 1× EM to 2.5× EM below spot.
  upperStrike: number; // 1× EM below spot
  lowerStrike: number; // 2.5× EM below spot
  totalVolume: number;
  totalOI: number;
  pctOfTotalPutVolume: number;
  interpretation: string;
};

export type YourStrikeFlow = {
  strike: number;
  volume: number;
  oi: number;
  volOiRatio: number | null;
  mark: number;
  delta: number;
  interpretation: string;
};

export type OptionsFlow = {
  expiry: string;
  spot: number;
  callVolume: number;
  putVolume: number;
  callOI: number;
  putOI: number;
  putCallRatio: number; // putVolume / callVolume
  putCallOI: number; // putOI / callOI
  flowBias: "bullish" | "bearish" | "neutral";
  unusualStrikes: UnusualStrike[];
  deepOtmPutCluster: DeepOtmPutCluster;
  yourStrikeFlow: YourStrikeFlow | null;
};

function flatten(
  map: SchwabOptionsChain["putExpDateMap"] | undefined,
  expiry: string,
): SchwabOptionContract[] {
  if (!map) return [];
  const out: SchwabOptionContract[] = [];
  for (const expKey of Object.keys(map)) {
    if (!expKey.startsWith(expiry)) continue;
    for (const strikeKey of Object.keys(map[expKey])) {
      for (const c of map[expKey][strikeKey]) out.push(c);
    }
  }
  return out;
}

function classifyNote(c: SchwabOptionContract): UnusualStrike["note"] {
  const d = c.delta ?? 0;
  if (c.putCall === "PUT") {
    if (d < -0.3) return "ATM hedge";
    if (d >= -0.15) return "tail hedge";
    return "unusual";
  }
  // CALL
  if (d > 0.3) return "directional bet";
  if (d <= 0.2) return "upside lottery";
  return "unusual";
}

function biasForRatio(pcRatio: number): OptionsFlow["flowBias"] {
  if (pcRatio < PC_BULLISH_BELOW) return "bullish";
  if (pcRatio > PC_BEARISH_ABOVE) return "bearish";
  return "neutral";
}

// Picks the contract closest to `targetStrike` from the put list.
// Lets us still report flow at "your strike" even when Schwab's grid
// snaps the suggested strike to a 2.5/5/10 step.
function pickStrikeFlow(
  puts: SchwabOptionContract[],
  targetStrike: number,
): YourStrikeFlow | null {
  if (puts.length === 0 || targetStrike <= 0) return null;
  const best = puts.reduce(
    (acc, c) => {
      const d = Math.abs((c.strikePrice ?? 0) - targetStrike);
      return d < acc.d ? { c, d } : acc;
    },
    { c: puts[0], d: Math.abs((puts[0].strikePrice ?? 0) - targetStrike) },
  ).c;
  const vol = best.totalVolume ?? 0;
  const oi = best.openInterest ?? 0;
  const ratio = oi > 0 ? vol / oi : null;
  const interpretation =
    ratio !== null && ratio > 2 && oi >= MIN_OI_FOR_UNUSUAL
      ? `High activity at your strike — ${vol} contracts traded vs ${oi} OI (${ratio.toFixed(1)}×)`
      : `Normal activity at your strike (${vol} vol / ${oi} OI)`;
  return {
    strike: best.strikePrice,
    volume: vol,
    oi,
    volOiRatio: ratio,
    mark: best.mark ?? 0,
    delta: best.delta ?? 0,
    interpretation,
  };
}

// Wraps schwabGet directly. We can't reuse getOptionsChain because it
// hard-codes contractType=PUT and a narrow strikeCount=30. Flow needs
// both sides AND a wide strike grid (catastrophe-hedge puts can sit
// 20% below spot).
async function fetchFullChain(
  symbol: string,
  expiry: string,
): Promise<SchwabOptionsChain | null> {
  try {
    return await schwabGet<SchwabOptionsChain>(`${MARKETDATA_BASE}/chains`, {
      symbol,
      contractType: "ALL",
      strikeCount: 200,
      includeUnderlyingQuote: true,
      strategy: "SINGLE",
      fromDate: expiry,
      toDate: expiry,
    });
  } catch (e) {
    console.warn(
      `[options-flow] ${symbol} ${expiry} chain fetch failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

// Computes the OptionsFlow object for a single candidate. Spot price +
// EM are caller-supplied (we already have them from stage 3), so this
// helper only needs the expiry and the suggested strike. Returns null
// when we couldn't fetch a usable chain — caller should treat as an
// optional UI section, not a hard failure.
export async function computeOptionsFlow(args: {
  symbol: string;
  expiry: string;
  spotPrice: number;
  emPct: number; // fractional, e.g. 0.038 for 3.8%
  suggestedStrike: number | null;
}): Promise<OptionsFlow | null> {
  const { symbol, expiry, spotPrice, emPct, suggestedStrike } = args;
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;
  if (!Number.isFinite(emPct) || emPct <= 0) return null;

  const chain = await fetchFullChain(symbol, expiry);
  if (!chain) return null;

  const calls = flatten(chain.callExpDateMap, expiry);
  const puts = flatten(chain.putExpDateMap, expiry);
  if (calls.length === 0 && puts.length === 0) return null;

  const callVolume = calls.reduce((s, c) => s + (c.totalVolume ?? 0), 0);
  const putVolume = puts.reduce((s, c) => s + (c.totalVolume ?? 0), 0);
  const callOI = calls.reduce((s, c) => s + (c.openInterest ?? 0), 0);
  const putOI = puts.reduce((s, c) => s + (c.openInterest ?? 0), 0);

  const putCallRatio = callVolume > 0 ? putVolume / callVolume : 0;
  const putCallOI = callOI > 0 ? putOI / callOI : 0;
  const flowBias = biasForRatio(putCallRatio);

  // Unusual: vol/OI > 3 AND OI >= 30. Sort by ratio desc, top 8.
  const unusualStrikes: UnusualStrike[] = [...calls, ...puts]
    .filter(
      (c) =>
        (c.openInterest ?? 0) >= MIN_OI_FOR_UNUSUAL &&
        (c.totalVolume ?? 0) > 0 &&
        (c.totalVolume ?? 0) / (c.openInterest ?? 1) > VOL_OI_UNUSUAL_THRESHOLD,
    )
    .map((c) => ({
      type: c.putCall === "CALL" ? ("call" as const) : ("put" as const),
      strike: c.strikePrice,
      volume: c.totalVolume ?? 0,
      oi: c.openInterest ?? 0,
      volOiRatio: (c.totalVolume ?? 0) / (c.openInterest ?? 1),
      delta: c.delta ?? 0,
      mark: c.mark ?? 0,
      note: classifyNote(c),
    }))
    .sort((a, b) => b.volOiRatio - a.volOiRatio)
    .slice(0, 8);

  // Deep-OTM put cluster: 1× to 2.5× EM below spot.
  const upperStrike = spotPrice * (1 - emPct);
  const lowerStrike = spotPrice * (1 - emPct * 2.5);
  const cluster = puts.filter(
    (c) => c.strikePrice >= lowerStrike && c.strikePrice <= upperStrike,
  );
  const clusterVol = cluster.reduce((s, c) => s + (c.totalVolume ?? 0), 0);
  const clusterOI = cluster.reduce((s, c) => s + (c.openInterest ?? 0), 0);
  const clusterPct = putVolume > 0 ? (clusterVol / putVolume) * 100 : 0;
  const clusterInterpretation =
    clusterPct > DEEP_OTM_CLUSTER_PCT_THRESHOLD
      ? `Elevated tail-risk hedging — ${clusterPct.toFixed(0)}% of put volume below $${upperStrike.toFixed(0)}`
      : `Normal put distribution (${clusterPct.toFixed(0)}% in 1×–2.5× EM band)`;
  const deepOtmPutCluster: DeepOtmPutCluster = {
    upperStrike,
    lowerStrike,
    totalVolume: clusterVol,
    totalOI: clusterOI,
    pctOfTotalPutVolume: clusterPct,
    interpretation: clusterInterpretation,
  };

  const yourStrikeFlow = pickStrikeFlow(puts, suggestedStrike ?? 0);

  return {
    expiry,
    spot: spotPrice,
    callVolume,
    putVolume,
    callOI,
    putOI,
    putCallRatio,
    putCallOI,
    flowBias,
    unusualStrikes,
    deepOtmPutCluster,
    yourStrikeFlow,
  };
}
