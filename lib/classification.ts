// Curated classification maps. These are intentionally conservative and editable.
// The screener falls back to Yahoo sector/industry when a ticker is missing.

export type IndustryClass =
  | "consumer_staples"
  | "utilities"
  | "large_pharma_stable"
  | "enterprise_software"
  | "large_diversified_financials"
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
]);

export const INDUSTRY_MAP: Record<string, IndustryClass> = {
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

  // Utilities
  NEE: "utilities",
  SO: "utilities",
  DUK: "utilities",
  D: "utilities",
  AEP: "utilities",
  XEL: "utilities",
  SRE: "utilities",
  ED: "utilities",

  // Large, stable pharma / healthcare non-binary
  JNJ: "large_pharma_stable",
  PFE: "large_pharma_stable",
  MRK: "large_pharma_stable",
  ABBV: "large_pharma_stable",
  LLY: "large_pharma_stable",
  BMY: "large_pharma_stable",
  AZN: "large_pharma_stable",
  NVS: "large_pharma_stable",

  // Enterprise software / stable SaaS
  MSFT: "enterprise_software",
  ORCL: "enterprise_software",
  CRM: "enterprise_software",
  ADBE: "enterprise_software",
  INTU: "enterprise_software",
  NOW: "enterprise_software",
  SAP: "enterprise_software",
  IBM: "enterprise_software",

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

  // Failing categories — industrials / cyclicals / commodities / retail / narrative tech / services
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
    if (i.includes("drug manufacturers") && (i.includes("general") || i.includes("major"))) return "large_pharma_stable";
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
