// Curated classification maps. These are intentionally conservative and editable.
// The screener falls through to Supabase cache, then Yahoo sector lookup, when a
// ticker is missing from INDUSTRY_MAP.

import { createServerClient } from "@/lib/supabase";
import { getCompanyProfile } from "@/lib/yahoo";

export type IndustryClass =
  | "consumer_staples"
  | "utilities"
  | "large_pharma_stable"
  | "enterprise_software"
  | "large_diversified_financials"
  | "business_services"
  | "healthcare_equipment"
  | "industrials"
  | "cyclicals"
  | "commodities"
  | "consumer_discretionary"
  | "healthcare_services"
  | "narrative_tech"
  | "unknown";

export const PASSING_CLASSES: ReadonlySet<IndustryClass> = new Set<IndustryClass>([
  "consumer_staples",
  "utilities",
  "large_pharma_stable",
  "enterprise_software",
  "large_diversified_financials",
  "business_services",
  "healthcare_equipment",
]);

export const INDUSTRY_MAP: Record<string, IndustryClass> = {
  // ---------------- Passing ----------------

  // Consumer staples
  KO: "consumer_staples",
  PEP: "consumer_staples",
  PG: "consumer_staples",
  CL: "consumer_staples",
  KMB: "consumer_staples",
  WMT: "consumer_staples",
  COST: "consumer_staples",
  MDLZ: "consumer_staples",
  GIS: "consumer_staples",
  MO: "consumer_staples",
  PM: "consumer_staples",
  MNST: "consumer_staples",
  STZ: "consumer_staples",
  TSN: "consumer_staples",
  HRL: "consumer_staples",
  SJM: "consumer_staples",
  K: "consumer_staples",
  CPB: "consumer_staples",
  CAG: "consumer_staples",

  // Utilities
  NEE: "utilities",
  SO: "utilities",
  DUK: "utilities",
  D: "utilities",
  AEP: "utilities",
  XEL: "utilities",
  SRE: "utilities",
  ED: "utilities",
  WEC: "utilities",
  ES: "utilities",
  ETR: "utilities",
  PPL: "utilities",
  CMS: "utilities",
  NI: "utilities",
  ATO: "utilities",
  OKE: "utilities",

  // Large, stable pharma / non-binary healthcare
  JNJ: "large_pharma_stable",
  PFE: "large_pharma_stable",
  MRK: "large_pharma_stable",
  ABBV: "large_pharma_stable",
  LLY: "large_pharma_stable",
  BMY: "large_pharma_stable",
  AZN: "large_pharma_stable",
  NVS: "large_pharma_stable",
  AMGN: "large_pharma_stable",
  GILD: "large_pharma_stable",
  BIIB: "large_pharma_stable",
  REGN: "large_pharma_stable",
  ZTS: "large_pharma_stable",
  MCK: "large_pharma_stable",
  ABC: "large_pharma_stable",
  CAH: "large_pharma_stable",

  // Enterprise software / stable large-cap tech
  MSFT: "enterprise_software",
  ORCL: "enterprise_software",
  CRM: "enterprise_software",
  ADBE: "enterprise_software",
  INTU: "enterprise_software",
  NOW: "enterprise_software",
  SAP: "enterprise_software",
  IBM: "enterprise_software",
  GOOGL: "enterprise_software",
  GOOG: "enterprise_software",
  META: "enterprise_software",
  AAPL: "enterprise_software",
  DOCU: "enterprise_software",
  ZM: "enterprise_software",
  WORK: "enterprise_software",
  TEAM: "enterprise_software",
  HUBS: "enterprise_software",
  WDAY: "enterprise_software",
  VEEV: "enterprise_software",
  OKTA: "enterprise_software",
  PANW: "enterprise_software",
  FTNT: "enterprise_software",
  CDNS: "enterprise_software",
  SNPS: "enterprise_software",
  ANSS: "enterprise_software",
  PTC: "enterprise_software",
  NUAN: "enterprise_software",
  CTSH: "enterprise_software",
  ACN: "enterprise_software",
  INFY: "enterprise_software",
  WIT: "enterprise_software",

  // Large diversified financials
  JPM: "large_diversified_financials",
  BAC: "large_diversified_financials",
  WFC: "large_diversified_financials",
  C: "large_diversified_financials",
  GS: "large_diversified_financials",
  MS: "large_diversified_financials",
  BLK: "large_diversified_financials",
  BRK_B: "large_diversified_financials",
  V: "large_diversified_financials",
  MA: "large_diversified_financials",
  AXP: "large_diversified_financials",
  USB: "large_diversified_financials",
  PNC: "large_diversified_financials",
  TFC: "large_diversified_financials",
  COF: "large_diversified_financials",
  SCHW: "large_diversified_financials",
  SPGI: "large_diversified_financials",
  MCO: "large_diversified_financials",
  ICE: "large_diversified_financials",
  CME: "large_diversified_financials",
  CBOE: "large_diversified_financials",
  NDAQ: "large_diversified_financials",

  // Business services — predictable B2B revenue, clean crush profile
  ADP: "business_services",
  PAYX: "business_services",
  CTAS: "business_services",
  CINF: "business_services",
  ROP: "business_services",
  VRSK: "business_services",
  CPRT: "business_services",
  FAST: "business_services",
  GPC: "business_services",
  EXPD: "business_services",
  CHRW: "business_services",
  XPO: "business_services",
  JBHT: "business_services",
  ODFL: "business_services",
  NSC: "business_services",
  UNP: "business_services",
  CSX: "business_services",

  // Healthcare equipment — predictable device revenue (not managed care)
  ABT: "healthcare_equipment",
  MDT: "healthcare_equipment",
  SYK: "healthcare_equipment",
  BSX: "healthcare_equipment",
  EW: "healthcare_equipment",
  ISRG: "healthcare_equipment",
  DXCM: "healthcare_equipment",
  BDX: "healthcare_equipment",
  BAX: "healthcare_equipment",
  ZBH: "healthcare_equipment",
  HOLX: "healthcare_equipment",
  IDXX: "healthcare_equipment",
  MTD: "healthcare_equipment",
  WAT: "healthcare_equipment",
  A: "healthcare_equipment",

  // ---------------- Failing (pre-filter drops these immediately) ----------------

  CAT: "industrials",
  DE: "industrials",
  BA: "industrials",
  GE: "industrials",
  HON: "industrials",
  F: "cyclicals",
  GM: "cyclicals",
  XOM: "commodities",
  CVX: "commodities",
  COP: "commodities",
  FCX: "commodities",
  NUE: "commodities",
  TGT: "consumer_discretionary",
  HD: "consumer_discretionary",
  LOW: "consumer_discretionary",
  AMZN: "consumer_discretionary",
  NKE: "consumer_discretionary",
  TSLA: "narrative_tech",
  NVDA: "narrative_tech",
  PLTR: "narrative_tech",
  SNOW: "narrative_tech",
  NET: "narrative_tech",
  UNH: "healthcare_services",
  CVS: "healthcare_services",
  HUM: "healthcare_services",
};

export function classifyFromSector(sector: string | null, industry: string | null): IndustryClass {
  const s = (sector ?? "").toLowerCase();
  const i = (industry ?? "").toLowerCase();
  if (s.includes("consumer defensive") || s.includes("consumer staples")) return "consumer_staples";
  if (s.includes("utilities")) return "utilities";
  if (s.includes("healthcare")) {
    if (isManagedCareIndustry(i)) return "healthcare_services";
    if (i.includes("drug manufacturers") && (i.includes("general") || i.includes("major"))) return "large_pharma_stable";
    if (i.includes("medical devices") || i.includes("medical instruments") || i.includes("diagnostics & research")) {
      return "healthcare_equipment";
    }
    return "healthcare_services";
  }
  if (s.includes("financial")) return "large_diversified_financials";
  if (s.includes("technology") && i.includes("software")) return "enterprise_software";
  if (s.includes("technology")) return "narrative_tech";
  if (s.includes("industrial")) return "industrials";
  if (s.includes("basic materials") || s.includes("energy")) return "commodities";
  if (s.includes("consumer cyclical") || s.includes("consumer discretionary")) return "consumer_discretionary";
  if (s.includes("communication") || s.includes("real estate")) return "unknown";
  return "unknown";
}

// Business simplicity: 3 = mono-line, 2 = 2-3 segments, 1 = complex, 0 = conglomerate.
export const BUSINESS_SIMPLICITY: Record<string, number> = {
  KO: 3, PEP: 2, PG: 2, CL: 3, KMB: 3,
  WMT: 2, COST: 3,
  MSFT: 2, ORCL: 2, ADBE: 3, CRM: 3, INTU: 2, NOW: 3, SAP: 2,
  JPM: 1, BAC: 1, WFC: 1, C: 1, GS: 1, MS: 1, BLK: 2, V: 3, MA: 3,
  BRK_B: 0, GE: 1, IBM: 1,
  NEE: 3, SO: 3, DUK: 3, D: 3, XEL: 3,
  JNJ: 1, PFE: 2, MRK: 2, ABBV: 2, LLY: 2, BMY: 2,
};

// Known overhangs — stocks with active drag factors that undermine CSP reliability.
// Intentionally small; curate over time.
export const ACTIVE_OVERHANG: ReadonlySet<string> = new Set<string>([
  "BA",
  "INTC",
  "PFE",
  "WBA",
]);

// ---------------- Yahoo-fallback classifier ----------------

export type ClassificationSource = "map" | "cache" | "yahoo" | "unknown";

export type ClassificationResult = {
  pass: boolean;
  industry: string;
  source: ClassificationSource;
};

function normalizeSymbol(symbol: string): string {
  return symbol.replace(/\./g, "_").replace(/-/g, "_").toUpperCase();
}

function isManagedCareIndustry(industry: string): boolean {
  const i = industry.toLowerCase();
  return (
    i.includes("healthcare plans") ||
    i.includes("medical care facilities") ||
    i.includes("insurance—healthcare") ||
    i.includes("insurance - healthcare")
  );
}

// Yahoo sector → pass/fail as specified by the user.
// PASS: Technology, Financial Services, Healthcare (not managed care),
//       Consumer Defensive, Utilities, Communication Services (large cap only).
// FAIL: Energy, Basic Materials, Industrials, Consumer Cyclical, Real Estate.
function mapYahooToPass(profile: {
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
}): { pass: boolean; industry: string } {
  const sector = (profile.sector ?? "").toLowerCase();
  const industry = profile.industry ?? profile.sector ?? "unknown";
  const industryLc = industry.toLowerCase();

  // Explicit fails
  if (
    sector.includes("energy") ||
    sector.includes("basic materials") ||
    sector.includes("industrials") ||
    sector.includes("consumer cyclical") ||
    sector.includes("real estate")
  ) {
    return { pass: false, industry };
  }

  // Always-pass sectors
  if (
    sector.includes("technology") ||
    sector.includes("financial") ||
    sector.includes("consumer defensive") ||
    sector.includes("utilities")
  ) {
    return { pass: true, industry };
  }

  // Healthcare passes unless managed care / healthcare plans
  if (sector.includes("healthcare")) {
    return { pass: !isManagedCareIndustry(industryLc), industry };
  }

  // Communication Services: large-cap only (>= $10B)
  if (sector.includes("communication")) {
    const largeCap = (profile.marketCap ?? 0) >= 10_000_000_000;
    return { pass: largeCap, industry };
  }

  return { pass: false, industry };
}

type CachedProfile = {
  industry: string | null;
  industry_pass: boolean | null;
  // Supabase numeric(10,2) deserializes to either number or string depending
  // on the client version — handle both at the consumer.
  market_cap_billions: number | string | null;
  updated_at: string | null;
};

async function readProfileCache(symbol: string): Promise<CachedProfile | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("stock_profiles")
      .select("industry, industry_pass, market_cap_billions, updated_at")
      .eq("symbol", symbol.toUpperCase())
      .maybeSingle();
    if (error) return null;
    return (data as CachedProfile) ?? null;
  } catch {
    return null;
  }
}

async function writeProfileCache(
  symbol: string,
  record: { industry: string | null; industry_pass: boolean; marketCapBillions: number | null },
): Promise<void> {
  try {
    const supabase = createServerClient();
    await supabase.from("stock_profiles").upsert(
      {
        symbol: symbol.toUpperCase(),
        industry: record.industry,
        industry_pass: record.industry_pass,
        market_cap_billions: record.marketCapBillions,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "symbol" },
    );
  } catch (e) {
    console.error(`[classify] cache write failed for ${symbol}:`, e instanceof Error ? e.message : e);
  }
}

// Reads just the cached market cap (in billions). Returns null if the symbol
// is not in the profile cache or market_cap_billions is null.
export async function getCachedMarketCapBillions(symbol: string): Promise<number | null> {
  const cached = await readProfileCache(symbol);
  const v = cached?.market_cap_billions;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  // Supabase numeric columns can come back as strings; handle that too.
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// Upserts the market cap (in billions) for a symbol. Leaves industry columns
// untouched if the row already exists (supabase-js upsert only updates the
// columns provided).
export async function cacheMarketCapBillions(
  symbol: string,
  billions: number,
): Promise<void> {
  try {
    const supabase = createServerClient();
    await supabase.from("stock_profiles").upsert(
      {
        symbol: symbol.toUpperCase(),
        market_cap_billions: Math.round(billions * 100) / 100,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "symbol" },
    );
  } catch (e) {
    console.error(
      `[classify] cacheMarketCapBillions write failed for ${symbol}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

async function classifyFromYahoo(symbol: string): Promise<ClassificationResult> {
  const profile = await getCompanyProfile(symbol);
  if (!profile || (!profile.sector && !profile.industry)) {
    // No usable data — cache the failure so we don't re-query.
    await writeProfileCache(symbol, { industry: null, industry_pass: false, marketCapBillions: null });
    return { pass: false, industry: "unknown", source: "yahoo" };
  }
  const { pass, industry } = mapYahooToPass(profile);
  const mcapBillions =
    typeof profile.marketCap === "number" && profile.marketCap > 0
      ? Math.round((profile.marketCap / 1e9) * 100) / 100
      : null;
  await writeProfileCache(symbol, { industry, industry_pass: pass, marketCapBillions: mcapBillions });
  return { pass, industry, source: "yahoo" };
}

// Public entrypoint — map → cache → (if allowed) Yahoo.
export async function getIndustryClassification(
  symbol: string,
  options: { yahooAllowed?: boolean } = {},
): Promise<ClassificationResult> {
  const norm = normalizeSymbol(symbol);

  const mapped = INDUSTRY_MAP[norm];
  if (mapped !== undefined) {
    return { pass: PASSING_CLASSES.has(mapped), industry: mapped, source: "map" };
  }

  const cached = await readProfileCache(symbol);
  if (cached && cached.industry_pass !== null) {
    return {
      pass: cached.industry_pass === true,
      industry: cached.industry ?? "cached",
      source: "cache",
    };
  }

  if (!options.yahooAllowed) {
    return { pass: false, industry: "unknown", source: "unknown" };
  }

  return await classifyFromYahoo(symbol);
}
