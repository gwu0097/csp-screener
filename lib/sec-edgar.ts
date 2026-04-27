// SEC EDGAR client — free, no key. Used by the Fundamental Health
// research module to pull 10-K historical financials directly from
// XBRL filings. Always send a User-Agent the SEC accepts (any
// identifier + email is fine; missing UA returns 403).

const EDGAR_DATA_BASE = "https://data.sec.gov";
const EDGAR_FILES_BASE = "https://www.sec.gov";
const USER_AGENT =
  process.env.SEC_USER_AGENT ?? "csp-screener research@example.com";

const DEFAULT_HEADERS: HeadersInit = {
  "User-Agent": USER_AGENT,
  Accept: "application/json",
};

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
// facts.<taxonomy>.<concept>.units.<unit>[]. We only care about
// us-gaap concepts in USD or USD/shares.
type FactEntry = {
  end?: string; // YYYY-MM-DD period end
  val?: number;
  form?: string; // '10-K' | '10-Q' | '8-K' | etc.
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

// Pulls the latest annual (10-K) value for a us-gaap concept. Many
// companies report the same concept under multiple aliases — the
// caller passes a fallback list and we return the first match.
function latestAnnualByYear(
  facts: CompanyFacts,
  concepts: string[],
  unit: string,
): Map<number, FactEntry> {
  const byYear = new Map<number, FactEntry>();
  const usgaap = facts.facts?.["us-gaap"];
  if (!usgaap) return byYear;
  for (const concept of concepts) {
    const c = usgaap[concept];
    const entries = c?.units?.[unit];
    if (!entries) continue;
    for (const e of entries) {
      if (e.form !== "10-K") continue;
      if (!e.end || typeof e.val !== "number") continue;
      const year = Number(e.end.slice(0, 4));
      if (!Number.isFinite(year)) continue;
      // Prefer the most recently filed entry per fiscal year.
      const existing = byYear.get(year);
      if (!existing || (e.filed ?? "") > (existing.filed ?? "")) {
        byYear.set(year, e);
      }
    }
    if (byYear.size > 0) break; // first matching concept wins
  }
  return byYear;
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
// working-capital components. We keep this in a separate extract so the
// fundamental-health module's lighter pull doesn't drag in extra rows.
export type DCFAnnualExtras = {
  year: number;
  da: number | null;
  capex: number | null;
  ocf: number | null;
  ar: number | null;
  inventory: number | null;
};

export function extractDCFExtras(
  facts: CompanyFacts | null,
  years = 5,
): DCFAnnualExtras[] {
  if (!facts) return [];
  const da = latestAnnualByYear(
    facts,
    [
      "DepreciationDepletionAndAmortization",
      "DepreciationAndAmortization",
      "Depreciation",
    ],
    "USD",
  );
  // Capex is reported as a negative cash flow on the statement of cash
  // flows; we flip sign so downstream math treats it as a positive
  // outflow magnitude.
  const capex = latestAnnualByYear(
    facts,
    [
      "PaymentsToAcquirePropertyPlantAndEquipment",
      "PaymentsToAcquireProductiveAssets",
    ],
    "USD",
  );
  const ocf = latestAnnualByYear(
    facts,
    ["NetCashProvidedByUsedInOperatingActivities"],
    "USD",
  );
  const ar = latestAnnualByYear(
    facts,
    ["AccountsReceivableNetCurrent"],
    "USD",
  );
  const inventory = latestAnnualByYear(facts, ["InventoryNet"], "USD");

  const allYears = new Set<number>();
  for (const m of [da, capex, ocf, ar, inventory]) {
    for (const y of Array.from(m.keys())) allYears.add(y);
  }
  const sorted = Array.from(allYears).sort((a, b) => b - a).slice(0, years);
  sorted.sort((a, b) => a - b);

  return sorted.map((year) => ({
    year,
    da: da.get(year)?.val ?? null,
    capex:
      capex.get(year)?.val !== undefined ? Math.abs(capex.get(year)!.val!) : null,
    ocf: ocf.get(year)?.val ?? null,
    ar: ar.get(year)?.val ?? null,
    inventory: inventory.get(year)?.val ?? null,
  }));
}

export function extractAnnualMetrics(
  facts: CompanyFacts | null,
  years = 5,
): AnnualMetrics[] {
  if (!facts) return [];
  const revenue = latestAnnualByYear(
    facts,
    ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"],
    "USD",
  );
  const grossProfit = latestAnnualByYear(facts, ["GrossProfit"], "USD");
  const operatingIncome = latestAnnualByYear(
    facts,
    ["OperatingIncomeLoss"],
    "USD",
  );
  const netIncome = latestAnnualByYear(facts, ["NetIncomeLoss"], "USD");
  const eps = latestAnnualByYear(
    facts,
    ["EarningsPerShareBasic", "EarningsPerShareDiluted"],
    "USD/shares",
  );
  const cash = latestAnnualByYear(
    facts,
    [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    "USD",
  );
  const debt = latestAnnualByYear(
    facts,
    ["LongTermDebt", "LongTermDebtNoncurrent"],
    "USD",
  );

  // Union of all years covered so we don't miss a column when one
  // concept is sparse.
  const allYears = new Set<number>();
  for (const m of [revenue, grossProfit, operatingIncome, netIncome, eps, cash, debt]) {
    for (const y of Array.from(m.keys())) allYears.add(y);
  }
  const sorted = Array.from(allYears).sort((a, b) => b - a).slice(0, years);
  // Re-sort ascending so the UI table reads left-to-right oldest → newest.
  sorted.sort((a, b) => a - b);

  return sorted.map((year) => ({
    year,
    revenue: revenue.get(year)?.val ?? null,
    grossProfit: grossProfit.get(year)?.val ?? null,
    operatingIncome: operatingIncome.get(year)?.val ?? null,
    netIncome: netIncome.get(year)?.val ?? null,
    eps: eps.get(year)?.val ?? null,
    cash: cash.get(year)?.val ?? null,
    debt: debt.get(year)?.val ?? null,
  }));
}
