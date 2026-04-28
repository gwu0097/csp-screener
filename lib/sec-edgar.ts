// SEC EDGAR client — free, no key. Used by the Fundamental Health
// research module and the Valuation module to pull historical
// financials directly from XBRL filings. Always send a User-Agent
// the SEC accepts (any identifier + email is fine; missing UA
// returns 403).
//
// Foreign private issuers (Spotify, Novo Nordisk, Alibaba, etc.)
// file 20-F (or 40-F for Canada) instead of 10-K and report under
// the `ifrs-full` taxonomy in their reporting currency, not
// `us-gaap` in USD. The pickers below transparently fall back from
// us-gaap to ifrs-full and from USD to whatever currency the
// company actually files in; callers that need USD-comparable
// numbers should pair the extracted rows with `fetchFxToUsd` +
// `convertAnnualToUsd` / `convertDCFExtrasToUsd`.

const EDGAR_DATA_BASE = "https://data.sec.gov";
const EDGAR_FILES_BASE = "https://www.sec.gov";
const USER_AGENT =
  process.env.SEC_USER_AGENT ?? "csp-screener research@example.com";

const DEFAULT_HEADERS: HeadersInit = {
  "User-Agent": USER_AGENT,
  Accept: "application/json",
};

// Annual filing forms we accept. 10-K = US domestic, 20-F = foreign
// private issuer, 40-F = Canadian issuer. Quarterlies (10-Q, 6-K)
// and event filings (8-K) are intentionally excluded — extractors
// only build year-over-year series from full-year filings.
const ACCEPTED_FORMS = new Set(["10-K", "20-F", "40-F"]);

// Preference order for monetary units. EDGAR returns one entry per
// unit per period; if a concept has both USD and EUR entries (rare
// but happens for some American Depositary Receipt issuers), we
// prefer USD so downstream math doesn't need conversion.
const PREFERRED_MONEY_UNITS = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "DKK",
  "SEK",
  "NOK",
  "HKD",
  "CNY",
];
const PREFERRED_SHARE_UNITS = [
  "USD/shares",
  "EUR/shares",
  "GBP/shares",
  "JPY/shares",
  "CHF/shares",
  "CAD/shares",
  "AUD/shares",
  "DKK/shares",
  "SEK/shares",
  "NOK/shares",
  "HKD/shares",
  "CNY/shares",
];

const TAXONOMIES = ["us-gaap", "ifrs-full"] as const;

// In-process cache for the company-tickers lookup. The file is ~1MB and
// every CIK lookup needs it; one fetch per cold start is enough.
let tickerMapPromise: Promise<Map<string, string>> | null = null;

async function loadTickerMap(): Promise<Map<string, string>> {
  if (tickerMapPromise) return tickerMapPromise;
  tickerMapPromise = (async () => {
    const res = await fetch(`${EDGAR_FILES_BASE}/files/company_tickers.json`, {
      headers: DEFAULT_HEADERS,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`SEC tickers fetch failed: ${res.status}`);
    }
    const json = (await res.json()) as Record<
      string,
      { cik_str: number; ticker: string; title: string }
    >;
    const out = new Map<string, string>();
    for (const v of Object.values(json)) {
      if (!v?.ticker) continue;
      out.set(v.ticker.toUpperCase(), String(v.cik_str).padStart(10, "0"));
    }
    return out;
  })().catch((e) => {
    // Reset so a transient failure doesn't permanently poison the cache.
    tickerMapPromise = null;
    throw e;
  });
  return tickerMapPromise;
}

export async function getCIK(symbol: string): Promise<string | null> {
  const map = await loadTickerMap();
  return map.get(symbol.toUpperCase()) ?? null;
}

// Raw company-facts response shape from EDGAR. Each XBRL fact lives at
// facts.<taxonomy>.<concept>.units.<unit>[].
type FactEntry = {
  end?: string; // YYYY-MM-DD period end
  start?: string; // YYYY-MM-DD period start (income-statement concepts)
  val?: number;
  form?: string; // '10-K' | '20-F' | '40-F' | '10-Q' | '8-K' | etc.
  filed?: string;
  fy?: number;
  fp?: string; // 'FY' | 'Q1' | ...
};

export type CompanyFacts = {
  cik?: number;
  entityName?: string;
  facts?: {
    "us-gaap"?: Record<
      string,
      {
        units?: Record<string, FactEntry[]>;
      }
    >;
    "ifrs-full"?: Record<
      string,
      {
        units?: Record<string, FactEntry[]>;
      }
    >;
  };
};

export async function getCompanyFacts(
  cik: string,
): Promise<CompanyFacts | null> {
  const url = `${EDGAR_DATA_BASE}/api/xbrl/companyfacts/CIK${cik}.json`;
  try {
    const res = await fetch(url, { headers: DEFAULT_HEADERS, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as CompanyFacts;
  } catch {
    return null;
  }
}

// Sort an array of available units by the preference list — units in
// the preference list come first (in their listed order), unrecognized
// units sort last in alphabetical order.
function sortUnitsByPreference(
  available: string[],
  preferred: string[],
): string[] {
  const rank = new Map<string, number>();
  preferred.forEach((u, i) => rank.set(u, i));
  return [...available].sort((a, b) => {
    const ra = rank.get(a) ?? preferred.length + a.charCodeAt(0);
    const rb = rank.get(b) ?? preferred.length + b.charCodeAt(0);
    return ra - rb;
  });
}

// Picks the best annual entries for a concept across taxonomies and
// units. Iterates: us-gaap → ifrs-full; for each taxonomy, tries each
// concept candidate in order; for each concept, tries each unit in
// preference order. Returns as soon as a non-empty year map is found,
// along with the unit and taxonomy that produced it.
function pickBestEntries(
  facts: CompanyFacts,
  concepts: string[],
  preferredUnits: string[],
): { byYear: Map<number, FactEntry>; unit: string | null; taxonomy: string | null } {
  for (const taxonomy of TAXONOMIES) {
    const tax = facts.facts?.[taxonomy];
    if (!tax) continue;
    for (const concept of concepts) {
      const c = tax[concept];
      const unitsRaw = c?.units;
      if (!unitsRaw) continue;
      const sortedUnits = sortUnitsByPreference(
        Object.keys(unitsRaw),
        preferredUnits,
      );
      for (const unit of sortedUnits) {
        const entries = unitsRaw[unit];
        if (!entries) continue;
        const byYear = new Map<number, FactEntry>();
        for (const e of entries) {
          if (!ACCEPTED_FORMS.has(e.form ?? "")) continue;
          if (!e.end || typeof e.val !== "number") continue;
          // Only annual filings — fp='FY' for the 10-K equivalent.
          // Some older 20-F entries don't have fp populated; accept
          // those iff the period spans roughly a year (we just trust
          // the form filter in that case).
          if (e.fp && e.fp !== "FY") continue;
          const year = Number(e.end.slice(0, 4));
          if (!Number.isFinite(year)) continue;
          const existing = byYear.get(year);
          if (!existing || (e.filed ?? "") > (existing.filed ?? "")) {
            byYear.set(year, e);
          }
        }
        if (byYear.size > 0) {
          return { byYear, unit, taxonomy };
        }
      }
    }
  }
  return { byYear: new Map(), unit: null, taxonomy: null };
}

export type AnnualMetrics = {
  year: number;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  cash: number | null;
  debt: number | null;
};

// Extra annual concepts the DCF needs — D&A, capex, operating cash flow,
// working-capital components.
export type DCFAnnualExtras = {
  year: number;
  da: number | null;
  capex: number | null;
  ocf: number | null;
  ar: number | null;
  inventory: number | null;
};

export type ReportingInfo = {
  // Reporting currency for monetary fields ('USD', 'EUR', 'GBP', etc.)
  // or null when no monetary entries were found.
  currency: string | null;
  // 'us-gaap' | 'ifrs-full' | null
  taxonomy: string | null;
  // '10-K' | '20-F' | '40-F' | null — the form whose figures fed the
  // extracted series.
  formType: string | null;
};

// Concept aliases — us-gaap names first, IFRS equivalents second.
// `pickBestEntries` returns the first match, so this order also
// dictates which name we trust for companies that report under both
// (rare for the same fact, but happens with dual-listed firms).
const CONCEPT_REVENUE = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "SalesRevenueNet",
  "Revenue",
  "RevenueFromContractsWithCustomers",
];
const CONCEPT_GROSS_PROFIT = ["GrossProfit"];
const CONCEPT_OPERATING_INCOME = [
  "OperatingIncomeLoss",
  "ProfitLossFromOperatingActivities",
];
const CONCEPT_NET_INCOME = ["NetIncomeLoss", "ProfitLoss"];
const CONCEPT_EPS_BASIC = ["EarningsPerShareBasic", "BasicEarningsLossPerShare"];
const CONCEPT_EPS_DILUTED = [
  "EarningsPerShareDiluted",
  "DilutedEarningsLossPerShare",
];
const CONCEPT_CASH = [
  "CashAndCashEquivalentsAtCarryingValue",
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  "CashAndCashEquivalents",
];
const CONCEPT_DEBT = [
  "LongTermDebt",
  "LongTermDebtNoncurrent",
  "LongtermBorrowings",
  "Borrowings",
];
const CONCEPT_DA = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAndAmortization",
  "Depreciation",
  "AdjustmentsForDepreciationExpense",
  "AdjustmentsForAmortisationExpense",
];
const CONCEPT_CAPEX = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "PaymentsToAcquireProductiveAssets",
  // IFRS aliases — the SPOT companyfacts payload uses the
  // ClassifiedAsInvestingActivities suffix, NVO uses the bare
  // PurchaseOfPropertyPlantAndEquipment. Try both.
  "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
  "PurchaseOfPropertyPlantAndEquipment",
];
const CONCEPT_OCF = [
  "NetCashProvidedByUsedInOperatingActivities",
  "CashFlowsFromUsedInOperatingActivities",
];
const CONCEPT_AR = ["AccountsReceivableNetCurrent", "TradeAndOtherCurrentReceivables"];
const CONCEPT_INVENTORY = ["InventoryNet", "Inventories"];

export function extractAnnualMetrics(
  facts: CompanyFacts | null,
  years = 5,
): AnnualMetrics[] {
  if (!facts) return [];
  const revenue = pickBestEntries(facts, CONCEPT_REVENUE, PREFERRED_MONEY_UNITS);
  const grossProfit = pickBestEntries(
    facts,
    CONCEPT_GROSS_PROFIT,
    PREFERRED_MONEY_UNITS,
  );
  const operatingIncome = pickBestEntries(
    facts,
    CONCEPT_OPERATING_INCOME,
    PREFERRED_MONEY_UNITS,
  );
  const netIncome = pickBestEntries(facts, CONCEPT_NET_INCOME, PREFERRED_MONEY_UNITS);
  const eps = pickBestEntries(
    facts,
    [...CONCEPT_EPS_BASIC, ...CONCEPT_EPS_DILUTED],
    PREFERRED_SHARE_UNITS,
  );
  const cash = pickBestEntries(facts, CONCEPT_CASH, PREFERRED_MONEY_UNITS);
  const debt = pickBestEntries(facts, CONCEPT_DEBT, PREFERRED_MONEY_UNITS);

  const allYears = new Set<number>();
  for (const m of [revenue, grossProfit, operatingIncome, netIncome, eps, cash, debt]) {
    for (const y of Array.from(m.byYear.keys())) allYears.add(y);
  }
  const sorted = Array.from(allYears).sort((a, b) => b - a).slice(0, years);
  sorted.sort((a, b) => a - b);

  return sorted.map((year) => ({
    year,
    revenue: revenue.byYear.get(year)?.val ?? null,
    grossProfit: grossProfit.byYear.get(year)?.val ?? null,
    operatingIncome: operatingIncome.byYear.get(year)?.val ?? null,
    netIncome: netIncome.byYear.get(year)?.val ?? null,
    eps: eps.byYear.get(year)?.val ?? null,
    cash: cash.byYear.get(year)?.val ?? null,
    debt: debt.byYear.get(year)?.val ?? null,
  }));
}

export function extractDCFExtras(
  facts: CompanyFacts | null,
  years = 5,
): DCFAnnualExtras[] {
  if (!facts) return [];
  const da = pickBestEntries(facts, CONCEPT_DA, PREFERRED_MONEY_UNITS);
  const capex = pickBestEntries(facts, CONCEPT_CAPEX, PREFERRED_MONEY_UNITS);
  const ocf = pickBestEntries(facts, CONCEPT_OCF, PREFERRED_MONEY_UNITS);
  const ar = pickBestEntries(facts, CONCEPT_AR, PREFERRED_MONEY_UNITS);
  const inventory = pickBestEntries(
    facts,
    CONCEPT_INVENTORY,
    PREFERRED_MONEY_UNITS,
  );

  const allYears = new Set<number>();
  for (const m of [da, capex, ocf, ar, inventory]) {
    for (const y of Array.from(m.byYear.keys())) allYears.add(y);
  }
  const sorted = Array.from(allYears).sort((a, b) => b - a).slice(0, years);
  sorted.sort((a, b) => a - b);

  return sorted.map((year) => ({
    year,
    da: da.byYear.get(year)?.val ?? null,
    // Capex flips negative (cash outflow on CFS) to a positive
    // magnitude so downstream FCF math reads consistently.
    capex:
      capex.byYear.get(year)?.val !== undefined
        ? Math.abs(capex.byYear.get(year)!.val!)
        : null,
    ocf: ocf.byYear.get(year)?.val ?? null,
    ar: ar.byYear.get(year)?.val ?? null,
    inventory: inventory.byYear.get(year)?.val ?? null,
  }));
}

// Inspects a few common concepts to determine the company's reporting
// currency, taxonomy, and the form type that fed the latest annual
// numbers. Returns nulls for any field that can't be inferred (rare —
// usually means the company has no annual filings on EDGAR).
export function getReportingInfo(facts: CompanyFacts | null): ReportingInfo {
  if (!facts) return { currency: null, taxonomy: null, formType: null };
  const probe = pickBestEntries(facts, CONCEPT_REVENUE, PREFERRED_MONEY_UNITS);
  // The form on the most recent revenue entry stands in for "the form
  // this company files annually."
  let formType: string | null = null;
  if (probe.byYear.size > 0) {
    const years = Array.from(probe.byYear.keys()).sort((a, b) => b - a);
    formType = probe.byYear.get(years[0])?.form ?? null;
  }
  return {
    currency: probe.unit,
    taxonomy: probe.taxonomy,
    formType,
  };
}

// In-process FX rate cache. open.er-api.com publishes daily mid-market
// rates; we cache per currency for ~1h to avoid hammering a free
// service. Returns null on failure so callers can degrade gracefully
// (skipping conversion = surfacing native currency, which the UI can
// still flag).
const fxCache = new Map<string, { rate: number; fetchedAt: number }>();
const FX_TTL_MS = 60 * 60 * 1000;

export async function fetchFxToUsd(
  currency: string,
): Promise<number | null> {
  const cur = currency.toUpperCase();
  if (cur === "USD") return 1;
  const cached = fxCache.get(cur);
  if (cached && Date.now() - cached.fetchedAt < FX_TTL_MS) {
    return cached.rate;
  }
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(cur)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: string;
      rates?: Record<string, number>;
    };
    if (json.result !== "success") return null;
    const rate = json.rates?.USD;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      return null;
    }
    fxCache.set(cur, { rate, fetchedAt: Date.now() });
    return rate;
  } catch (e) {
    console.warn(
      `[sec-edgar] fetchFxToUsd(${cur}) failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

// Multiplies every monetary field by the FX rate. EPS counts as
// monetary (it's a per-share dollar amount). Year is unchanged.
export function convertAnnualToUsd(
  rows: AnnualMetrics[],
  fxRate: number,
): AnnualMetrics[] {
  if (fxRate === 1) return rows;
  return rows.map((r) => ({
    year: r.year,
    revenue: r.revenue !== null ? r.revenue * fxRate : null,
    grossProfit: r.grossProfit !== null ? r.grossProfit * fxRate : null,
    operatingIncome:
      r.operatingIncome !== null ? r.operatingIncome * fxRate : null,
    netIncome: r.netIncome !== null ? r.netIncome * fxRate : null,
    eps: r.eps !== null ? r.eps * fxRate : null,
    cash: r.cash !== null ? r.cash * fxRate : null,
    debt: r.debt !== null ? r.debt * fxRate : null,
  }));
}

export function convertDCFExtrasToUsd(
  rows: DCFAnnualExtras[],
  fxRate: number,
): DCFAnnualExtras[] {
  if (fxRate === 1) return rows;
  return rows.map((r) => ({
    year: r.year,
    da: r.da !== null ? r.da * fxRate : null,
    capex: r.capex !== null ? r.capex * fxRate : null,
    ocf: r.ocf !== null ? r.ocf * fxRate : null,
    ar: r.ar !== null ? r.ar * fxRate : null,
    inventory: r.inventory !== null ? r.inventory * fxRate : null,
  }));
}

// ---------------- Quarterly (10-Q) data ----------------
//
// Quarterly extraction is structurally similar to the annual path but
// keys facts on (fy, fp) instead of just year, accepts 10-Q for
// Q1/Q2/Q3 and 10-K/20-F/40-F for FY (so Q4 can be derived from
// FY − Q1 − Q2 − Q3), and filters out cumulative-period entries that
// some filers post under the same fp tag (e.g. a 6-month entry tagged
// fp="Q2"). EDGAR puts the period start/end on every income-statement
// fact, so a span filter (≈ 90 days for quarters, ≈ 365 days for FY)
// reliably separates the 3-month Q2 value from the 6-month cumulative.
//
// Foreign private issuers (20-F filers) generally don't have quarterly
// XBRL data in companyfacts — they file 6-K interims that aren't
// structured. Their quarterly[] will come back empty; the UI hides
// the section in that case.

export type QuarterlyMetrics = {
  fiscalLabel: string; // "Q1 2026", "Q4 2025"
  fiscalYear: number;
  fiscalQuarter: 1 | 2 | 3 | 4;
  periodEnd: string; // YYYY-MM-DD
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  // EPS for Q4 is left null even when the FY and Q1-Q3 EPS values are
  // all present — share-count drift across the year makes naive
  // subtraction unreliable, and EDGAR doesn't carry a derived Q4 EPS.
  eps: number | null;
};

type QuarterlyPick = {
  byKey: Map<string, FactEntry>;
  unit: string | null;
  taxonomy: string | null;
};

function pickBestQuarterlyEntries(
  facts: CompanyFacts,
  concepts: string[],
  preferredUnits: string[],
): QuarterlyPick {
  for (const taxonomy of TAXONOMIES) {
    const tax = facts.facts?.[taxonomy];
    if (!tax) continue;
    for (const concept of concepts) {
      const c = tax[concept];
      const unitsRaw = c?.units;
      if (!unitsRaw) continue;
      const sortedUnits = sortUnitsByPreference(
        Object.keys(unitsRaw),
        preferredUnits,
      );
      for (const unit of sortedUnits) {
        const entries = unitsRaw[unit];
        if (!entries) continue;
        const byKey = new Map<string, FactEntry>();
        for (const e of entries) {
          if (!e.end || typeof e.val !== "number") continue;
          if (typeof e.fy !== "number" || !e.fp) continue;
          const isQuarter =
            e.form === "10-Q" &&
            (e.fp === "Q1" || e.fp === "Q2" || e.fp === "Q3");
          const isAnnual =
            ACCEPTED_FORMS.has(e.form ?? "") && e.fp === "FY";
          if (!isQuarter && !isAnnual) continue;
          // Span filter knocks out cumulative-period rows. Skipped
          // when start is missing (some EPS facts omit it — accepted
          // because the fp tag alone is enough for per-share data).
          if (e.start) {
            const days =
              (new Date(e.end).getTime() - new Date(e.start).getTime()) /
              86_400_000;
            if (e.fp === "FY") {
              if (days < 350 || days > 380) continue;
            } else {
              if (days < 80 || days > 100) continue;
            }
          }
          // EDGAR companyfacts attaches the FILING's fiscal year to BOTH
          // the current period AND the prior-year comparative figures
          // disclosed in that filing — so HOOD's Q3 2025 10-Q produces
          // (fy=2025, fp=Q3, end=2025-09-30) AND (fy=2025, fp=Q3,
          // end=2024-09-30). Keying by `${fy}|${fp}` collides those, and
          // the latest-filed wins logic lets the prior-year row stomp the
          // current one. Key by the calendar year of `end` instead so
          // each unique period gets its own slot. fp is still used to
          // separate quarters from the FY annual entries that drive Q4
          // derivation.
          const endYear = Number(e.end.slice(0, 4));
          if (!Number.isFinite(endYear)) continue;
          const key = `${endYear}|${e.fp}`;
          const existing = byKey.get(key);
          if (!existing || (e.filed ?? "") > (existing.filed ?? "")) {
            byKey.set(key, e);
          }
        }
        if (byKey.size > 0) {
          return { byKey, unit, taxonomy };
        }
      }
    }
  }
  return { byKey: new Map(), unit: null, taxonomy: null };
}

export function extractQuarterlyMetrics(
  facts: CompanyFacts | null,
  quarters = 6,
): QuarterlyMetrics[] {
  if (!facts) return [];
  const revenue = pickBestQuarterlyEntries(
    facts,
    CONCEPT_REVENUE,
    PREFERRED_MONEY_UNITS,
  );
  const opInc = pickBestQuarterlyEntries(
    facts,
    CONCEPT_OPERATING_INCOME,
    PREFERRED_MONEY_UNITS,
  );
  const netInc = pickBestQuarterlyEntries(
    facts,
    CONCEPT_NET_INCOME,
    PREFERRED_MONEY_UNITS,
  );
  const eps = pickBestQuarterlyEntries(
    facts,
    [...CONCEPT_EPS_BASIC, ...CONCEPT_EPS_DILUTED],
    PREFERRED_SHARE_UNITS,
  );

  // Collect every calendar end-year any picker saw. Keys are now
  // `${endYear}|${fp}` so split[0] is the calendar year of the period.
  const yearSet = new Set<number>();
  for (const m of [revenue, opInc, netInc, eps]) {
    for (const k of Array.from(m.byKey.keys())) {
      const y = Number(k.split("|")[0]);
      if (Number.isFinite(y)) yearSet.add(y);
    }
  }

  function lookupVal(
    pick: QuarterlyPick,
    year: number,
    q: 1 | 2 | 3 | 4,
  ): number | null {
    if (q < 4) {
      const e = pick.byKey.get(`${year}|Q${q}`);
      return typeof e?.val === "number" ? e.val : null;
    }
    const fyEntry = pick.byKey.get(`${year}|FY`);
    const q1 = pick.byKey.get(`${year}|Q1`);
    const q2 = pick.byKey.get(`${year}|Q2`);
    const q3 = pick.byKey.get(`${year}|Q3`);
    if (
      typeof fyEntry?.val !== "number" ||
      typeof q1?.val !== "number" ||
      typeof q2?.val !== "number" ||
      typeof q3?.val !== "number"
    ) {
      return null;
    }
    const derived = fyEntry.val - q1.val - q2.val - q3.val;
    // Guard: a negative Q4 derivation almost always means the picker
    // matched a stale FY entry (e.g. a prior-year comparative tagged
    // with the current filing's fy). EDGAR is internally consistent on
    // units — both annual and quarterly come back in raw dollars from
    // the same picker — so a real unit mismatch isn't the cause.
    // Surface null rather than a misleading negative figure; the next
    // re-extract from EDGAR will produce the correct value.
    if (derived < 0) return null;
    return derived;
  }

  function lookupEnd(year: number, q: 1 | 2 | 3 | 4): string | null {
    if (q < 4) {
      for (const m of [revenue, opInc, netInc, eps]) {
        const e = m.byKey.get(`${year}|Q${q}`);
        if (e?.end) return e.end;
      }
      return null;
    }
    for (const m of [revenue, opInc, netInc, eps]) {
      const e = m.byKey.get(`${year}|FY`);
      if (e?.end) return e.end;
    }
    return null;
  }

  const built: QuarterlyMetrics[] = [];
  for (const year of Array.from(yearSet)) {
    for (const q of [1, 2, 3, 4] as const) {
      const end = lookupEnd(year, q);
      if (!end) continue;
      const rev = lookupVal(revenue, year, q);
      const op = lookupVal(opInc, year, q);
      const ni = lookupVal(netInc, year, q);
      // Q4 EPS by subtraction is unreliable — see type comment above.
      const epsVal =
        q < 4
          ? (eps.byKey.get(`${year}|Q${q}`)?.val ?? null)
          : null;
      if (rev === null && op === null && ni === null && epsVal === null) {
        continue;
      }
      built.push({
        fiscalLabel: `Q${q} ${year}`,
        fiscalYear: year,
        fiscalQuarter: q,
        periodEnd: end,
        revenue: rev,
        operatingIncome: op,
        netIncome: ni,
        eps: epsVal,
      });
    }
  }

  built.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  return built.slice(0, quarters);
}

export function convertQuarterlyToUsd(
  rows: QuarterlyMetrics[],
  fxRate: number,
): QuarterlyMetrics[] {
  if (fxRate === 1) return rows;
  return rows.map((r) => ({
    ...r,
    revenue: r.revenue !== null ? r.revenue * fxRate : null,
    operatingIncome:
      r.operatingIncome !== null ? r.operatingIncome * fxRate : null,
    netIncome: r.netIncome !== null ? r.netIncome * fxRate : null,
    eps: r.eps !== null ? r.eps * fxRate : null,
  }));
}

// ---------------- Recent filings list (8-K / 10-Q / 10-K) ----------------
//
// Returns a slice of the company's recent filings filtered to the
// requested forms. EDGAR's full-text search endpoint at
// efts.sec.gov is flaky (returns 500 unauthenticated); the
// submissions JSON at data.sec.gov is the stable path and includes
// every form along with the accession number, primary document,
// filing date, and primary-doc description we need to construct the
// archive URL.

export type SecFiling = {
  form: string; // "8-K" | "10-Q" | "10-K" | "20-F" | etc.
  accessionNumber: string; // "0001783879-26-000061"
  primaryDocument: string; // "hood-20260428.htm"
  filingDate: string; // YYYY-MM-DD
  reportDate: string | null; // YYYY-MM-DD (period end / event date)
  primaryDocDescription: string | null;
};

// Convert "0001783879-26-000061" → "000178387926000061" for archive
// directory paths.
function accessionNoDashes(acc: string): string {
  return acc.replace(/-/g, "");
}

export function filingArchiveDirUrl(
  cik: string,
  accessionNumber: string,
): string {
  const accNoDash = accessionNoDashes(accessionNumber);
  // CIK in the archive URL is unpadded, but the data.sec.gov CIK we
  // already pad to 10 digits — strip leading zeros for the archive path.
  const cikInt = String(parseInt(cik, 10));
  return `${EDGAR_FILES_BASE}/Archives/edgar/data/${cikInt}/${accNoDash}`;
}

export async function getRecentFilings(
  cik: string,
  forms: string[],
  limit = 25,
): Promise<SecFiling[]> {
  const url = `${EDGAR_DATA_BASE}/submissions/CIK${cik}.json`;
  let res: Response;
  try {
    res = await fetch(url, { headers: DEFAULT_HEADERS, cache: "no-store" });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const json = (await res.json()) as {
    filings?: {
      recent?: {
        form?: string[];
        accessionNumber?: string[];
        primaryDocument?: string[];
        filingDate?: string[];
        reportDate?: string[];
        primaryDocDescription?: string[];
      };
    };
  };
  const recent = json.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) return [];
  const wanted = new Set(forms);
  const out: SecFiling[] = [];
  const len = recent.form.length;
  for (let i = 0; i < len; i += 1) {
    const form = recent.form[i];
    if (!form || !wanted.has(form)) continue;
    const accessionNumber = recent.accessionNumber?.[i] ?? "";
    const primaryDocument = recent.primaryDocument?.[i] ?? "";
    if (!accessionNumber || !primaryDocument) continue;
    out.push({
      form,
      accessionNumber,
      primaryDocument,
      filingDate: recent.filingDate?.[i] ?? "",
      reportDate: recent.reportDate?.[i] || null,
      primaryDocDescription: recent.primaryDocDescription?.[i] ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Lists the files inside a filing's archive directory by parsing the
// directory listing HTML EDGAR serves. Returns absolute file URLs and
// their basenames so callers can pick the right exhibit (e.g. the
// q1*exhibit991.htm earnings press release inside an 8-K).
export async function listFilingFiles(
  cik: string,
  accessionNumber: string,
): Promise<Array<{ url: string; name: string }>> {
  const dir = filingArchiveDirUrl(cik, accessionNumber);
  let res: Response;
  try {
    res = await fetch(dir + "/", {
      headers: DEFAULT_HEADERS,
      cache: "no-store",
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const html = await res.text();
  const matches = Array.from(
    html.matchAll(/href="([^"]*\/(?:[^/"]+\.(?:htm|html|txt|pdf)))"/gi),
  );
  const out: Array<{ url: string; name: string }> = [];
  for (const m of matches) {
    const path = m[1];
    if (!path) continue;
    const name = path.slice(path.lastIndexOf("/") + 1);
    const url = path.startsWith("http") ? path : `${EDGAR_FILES_BASE}${path}`;
    if (out.find((o) => o.name === name)) continue;
    out.push({ url, name });
  }
  return out;
}

// Fetches a filing-archive HTML file and returns it stripped to plain
// text (script/style removed, tags collapsed, whitespace normalized)
// so it can be passed to an LLM extractor without burning tokens on
// boilerplate.
export async function fetchFilingTextPlain(
  url: string,
  maxChars = 60_000,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: DEFAULT_HEADERS, cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const raw = await res.text();
  const stripped = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/g, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped;
}

// Build the full archive URL for a filing's primary document (the
// `.htm` whose XBRL backs the structured data). Useful for fetching
// the full 10-Q / 10-K text for downstream extraction.
export function primaryDocumentUrl(
  cik: string,
  accessionNumber: string,
  primaryDocument: string,
): string {
  return `${filingArchiveDirUrl(cik, accessionNumber)}/${primaryDocument}`;
}

// Find the most-recent filing of a given form. For 10-Q lookups we
// also accept a `matchPeriodEnd` so the caller can target a specific
// quarter; falls back to the newest filing when no match is found.
export async function findFilingByForm(
  cik: string,
  forms: string[],
  matchPeriodEnd?: string | null,
): Promise<SecFiling | null> {
  const filings = await getRecentFilings(cik, forms, 25);
  if (filings.length === 0) return null;
  if (matchPeriodEnd) {
    const exact = filings.find((f) => f.reportDate === matchPeriodEnd);
    if (exact) return exact;
  }
  // Filings are returned in submission order (newest first) by EDGAR.
  return filings[0];
}

// Strip a chunk of HTML to plain whitespace-normalized text. Used by
// section extractors that already have the raw HTML in memory.
export function htmlToText(raw: string): string {
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/g, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// Fetch the full text of a filing document (10-Q / 10-K HTML), strip
// to plain text, and return without the cap that fetchFilingTextPlain
// applies. Use for downstream regex section extraction where the cap
// would slice mid-section.
export async function fetchFilingTextFull(
  url: string,
  cap = 2_000_000,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: DEFAULT_HEADERS, cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const raw = await res.text();
  const stripped = htmlToText(raw);
  return stripped.length > cap ? stripped.slice(0, cap) : stripped;
}

// Generic section extractor: locate `headerRegex` in plain text and
// return everything from the match up to the first hit of
// `endRegex`, or the rest of the text if no end is found. The header
// match itself is included so callers can confirm what was extracted.
//
// Skips the first 50 chars after the header before searching for the
// end marker — handles cases where the end-marker pattern overlaps
// a TOC entry that immediately follows the section header.
export function extractTextSection(
  text: string,
  headerRegex: RegExp,
  endRegex: RegExp,
): string | null {
  const start = text.search(headerRegex);
  if (start < 0) return null;
  const tail = text.slice(start);
  const probe = tail.slice(50);
  const endRel = probe.search(endRegex);
  if (endRel < 0) return tail;
  return tail.slice(0, 50 + endRel);
}

// TTM revenue from a sorted-newest-first quarterly array. Returns null
// when fewer than 4 quarters are available OR any of the most recent
// 4 has a null revenue value.
export function ttmRevenueFromQuarters(
  quarterly: QuarterlyMetrics[],
): number | null {
  const sorted = [...quarterly].sort((a, b) =>
    b.periodEnd.localeCompare(a.periodEnd),
  );
  const last4 = sorted.slice(0, 4);
  if (last4.length < 4) return null;
  let sum = 0;
  for (const q of last4) {
    if (q.revenue === null) return null;
    sum += q.revenue;
  }
  return sum;
}
