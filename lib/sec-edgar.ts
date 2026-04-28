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
