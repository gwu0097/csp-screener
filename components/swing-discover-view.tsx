"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Signal,
  Telescope,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type Category = "momentum" | "recovery" | "theme" | "social";

type MarketCapCategory = "large" | "mid" | "small" | null;

type Candidate = {
  symbol: string;
  catalyst: string;
  sentiment: string;
  timeframe: string;
  thesis: string;
  confidence: string;
  risk: string;
  signal_basis: string;
  sources: string[];
  category: Category;
  theme?: string | null;
  theme_momentum?: string | null;
  company_name: string | null;
  current_price: number | null;
  week_52_low: number | null;
  week_52_high: number | null;
  forward_pe: number | null;
  analyst_target: number | null;
  price_change_pct: number | null;
  pct_from_52w_high: number | null;
  upside_to_target: number | null;
  fifty_day_ma: number | null;
  vs_50d_ma_pct: number | null;
  market_cap: number | null;
  market_cap_category: MarketCapCategory;
  appearance_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

type DeepDive = {
  recent_news: string;
  fundamental_health: string;
  catalyst_credibility: "high" | "medium" | "low";
  catalyst_timeline: string;
  retail_sentiment: "bullish" | "bearish" | "mixed";
  institutional_activity: "buying" | "selling" | "neutral";
  technical_setup: "good_entry" | "extended" | "oversold";
  entry_comment: string;
  bear_case: string[];
  verdict: "HIGH" | "MEDIUM" | "LOW";
  verdict_reasoning: string;
};

type NewsItem = {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string; // human-readable
};

type Fundamentals = {
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  numberOfAnalystOpinions: number | null;
  recommendationMean: number | null;
  recommendationKey: string | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  targetMeanPrice: number | null;
  heldPercentInsiders: number | null;
  heldPercentInstitutions: number | null;
  shortPercentOfFloat: number | null;
  trailingEps: number | null;
  forwardEps: number | null;
};

type ResearchData = {
  news: NewsItem[];
  fundamentals: Fundamentals | null;
};

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtRel(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " at " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

function confidenceClasses(c: string): string {
  if (c === "high") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (c === "medium") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (c === "low") return "bg-muted/40 text-muted-foreground border-border";
  return "bg-muted/40 text-muted-foreground border-border";
}

function sentimentClasses(s: string): string {
  if (s === "bullish") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (s === "bearish") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  if (s === "mixed") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

function themeMomentumClasses(m: string | null): string {
  if (m === "strong") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (m === "moderate") return "bg-amber-500/20 text-amber-300 border-amber-500/40";
  if (m === "fading") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

// Social/retail cards get a purple accent so they stand apart from
// the analyst-driven sections at a glance.
function categoryAccentClasses(cat: Category): string {
  if (cat === "social")
    return "border-violet-500/40 bg-violet-500/5";
  return "border-border bg-zinc-900/60";
}

// Pill colors for the category-source badge — matches the spec
// (momentum=blue, recovery=emerald, theme=orange, social=violet so
// the inline pill agrees with the social card's accent border).
function categoryBadgeClasses(cat: Category): string {
  if (cat === "momentum")
    return "bg-blue-500/20 text-blue-400 border-blue-500/40";
  if (cat === "recovery")
    return "bg-emerald-500/20 text-emerald-400 border-emerald-500/40";
  if (cat === "theme")
    return "bg-orange-500/20 text-orange-400 border-orange-500/40";
  return "bg-violet-500/20 text-violet-300 border-violet-500/40";
}

function categoryLabel(cat: Category): string {
  if (cat === "momentum") return "MOMENTUM";
  if (cat === "recovery") return "RECOVERY";
  if (cat === "theme") return "THEME";
  return "SOCIAL";
}

function prettyCategory(cat: Category): string {
  if (cat === "momentum") return "Momentum";
  if (cat === "recovery") return "Recovery";
  if (cat === "theme") return "Themes";
  return "Social";
}

function marketCapPillClasses(cat: MarketCapCategory): string {
  if (cat === "large")
    return "bg-blue-500/20 text-blue-400 border-blue-500/40";
  if (cat === "mid")
    return "bg-teal-500/20 text-teal-300 border-teal-500/40";
  if (cat === "small")
    return "bg-orange-500/20 text-orange-400 border-orange-500/40";
  return "bg-muted/40 text-muted-foreground border-border";
}

function marketCapLabel(cat: MarketCapCategory): string {
  if (cat === "large") return "Large-cap";
  if (cat === "mid") return "Mid-cap";
  if (cat === "small") return "Small-cap";
  return "";
}

// Extract a clean display domain from a full URL. Returns the input
// string if the parse fails so we still render *something* clickable
// instead of crashing the page. Perplexity occasionally returns
// non-URL strings (raw page titles, "indeed.com" without a scheme,
// etc.) and `new URL()` throws on those.
function domainOf(url: unknown): string {
  if (typeof url !== "string" || url.length === 0) return "source";
  try {
    return new URL(ensureHttp(url)).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Coerce a possibly schemeless citation ("stocktitan.net/news/...")
// into a fully qualified URL. Without this the browser treats the href
// as a relative path and the link goes nowhere.
function ensureHttp(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url.replace(/^\/+/, "")}`;
}

// Defensive normalizer for candidates loaded from the API. Earlier
// scans persisted to swing_scan_results don't have the newer fields
// (signal_basis, sources, market_cap_category, vs_50d_ma_pct,
// company_name); rendering against undefined would throw on the
// first .length / .slice / .map call. Run every payload through here
// at the boundary so the rest of the view can rely on the type.
function normalizeCandidate(raw: unknown): Candidate {
  const r = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {});
  const cat = r.category;
  const category: Category =
    cat === "momentum" || cat === "recovery" || cat === "theme" || cat === "social"
      ? cat
      : "momentum";
  const sources = Array.isArray(r.sources)
    ? (r.sources as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const mcc = r.market_cap_category;
  const market_cap_category: MarketCapCategory =
    mcc === "large" || mcc === "mid" || mcc === "small" ? mcc : null;
  const appearance_count =
    typeof r.appearance_count === "number" && Number.isFinite(r.appearance_count)
      ? r.appearance_count
      : 0;
  const first_seen_at =
    typeof r.first_seen_at === "string" ? r.first_seen_at : null;
  const last_seen_at =
    typeof r.last_seen_at === "string" ? r.last_seen_at : null;
  return {
    symbol: str(r.symbol).toUpperCase(),
    catalyst: str(r.catalyst),
    sentiment: str(r.sentiment),
    timeframe: str(r.timeframe),
    thesis: str(r.thesis),
    confidence: str(r.confidence),
    risk: str(r.risk),
    signal_basis: str(r.signal_basis),
    sources,
    category,
    theme: typeof r.theme === "string" ? r.theme : null,
    theme_momentum:
      typeof r.theme_momentum === "string" ? r.theme_momentum : null,
    company_name: typeof r.company_name === "string" ? r.company_name : null,
    current_price: num(r.current_price),
    week_52_low: num(r.week_52_low),
    week_52_high: num(r.week_52_high),
    forward_pe: num(r.forward_pe),
    analyst_target: num(r.analyst_target),
    price_change_pct: num(r.price_change_pct),
    pct_from_52w_high: num(r.pct_from_52w_high),
    upside_to_target: num(r.upside_to_target),
    fifty_day_ma: num(r.fifty_day_ma),
    vs_50d_ma_pct: num(r.vs_50d_ma_pct),
    market_cap: num(r.market_cap),
    market_cap_category,
    appearance_count,
    first_seen_at,
    last_seen_at,
  };
}

function timeframeLabel(tf: string): string {
  if (tf === "1month") return "1 month";
  if (tf === "3months") return "3 months";
  if (tf === "6months") return "6 months";
  return tf;
}

function verdictClasses(v: DeepDive["verdict"]): string {
  if (v === "HIGH")
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-200";
  if (v === "MEDIUM")
    return "border-amber-500/40 bg-amber-500/15 text-amber-200";
  return "border-zinc-500/40 bg-zinc-500/15 text-zinc-200";
}

function technicalLabel(t: DeepDive["technical_setup"]): string {
  if (t === "good_entry") return "Good entry point";
  if (t === "oversold") return "Oversold";
  return "Extended";
}

// Sortable column keys. "confidence" uses an ordered HIGH > MEDIUM > LOW
// scale; the rest sort by the underlying numeric field. Default is
// confidence desc with a signal_basis alphabetical tiebreak.
type SortKey =
  | "current_price"
  | "price_change_pct"
  | "pct_from_52w_high"
  | "vs_50d_ma_pct"
  | "forward_pe"
  | "confidence";
type SortDir = "asc" | "desc";
type SortState = { key: SortKey; dir: SortDir };

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function compareCandidates(
  a: Candidate,
  b: Candidate,
  sort: SortState,
): number {
  const dirMul = sort.dir === "desc" ? -1 : 1;
  if (sort.key === "confidence") {
    const av = CONFIDENCE_RANK[a.confidence] ?? 0;
    const bv = CONFIDENCE_RANK[b.confidence] ?? 0;
    if (av !== bv) return (av - bv) * dirMul;
    // Stable tiebreak — alphabetical by signal basis (always asc).
    return (a.signal_basis || "").localeCompare(b.signal_basis || "");
  }
  const av = a[sort.key];
  const bv = b[sort.key];
  const aNull = av === null || !Number.isFinite(av);
  const bNull = bv === null || !Number.isFinite(bv);
  // Nulls always sort to the end regardless of direction.
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (av === bv) {
    return (a.signal_basis || "").localeCompare(b.signal_basis || "");
  }
  return (av - bv) * dirMul;
}

function sortCandidates(list: Candidate[], sort: SortState): Candidate[] {
  return list.slice().sort((a, b) => compareCandidates(a, b, sort));
}

const DEFAULT_SORT: SortState = { key: "confidence", dir: "desc" };

type CategoryBucket = { candidates: Candidate[]; scannedAt: string | null };
type PerCategoryState = Record<Category, CategoryBucket>;
const EMPTY_PER_CATEGORY: PerCategoryState = {
  momentum: { candidates: [], scannedAt: null },
  recovery: { candidates: [], scannedAt: null },
  theme: { candidates: [], scannedAt: null },
  social: { candidates: [], scannedAt: null },
};
type ActiveTab = "all" | Category;
const SCANNABLE_CATEGORIES: Category[] = [
  "momentum",
  "recovery",
  "theme",
  "social",
];

export function SwingDiscoverView() {
  // Each category holds its own candidate list + timestamp. The All tab
  // derives its data from the union; partial scans replace one bucket
  // and leave the others alone.
  const [perCategory, setPerCategory] =
    useState<PerCategoryState>(EMPTY_PER_CATEGORY);
  const [activeTab, setActiveTab] = useState<ActiveTab>("momentum");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ideasSymbols, setIdeasSymbols] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  // Toggle sort direction on repeat clicks; switch keys reset to a sensible
  // default for that column (asc for "from high" so most-beaten-down sit
  // on top, desc otherwise — matches how the user thinks about each).
  function handleHeaderClick(key: SortKey) {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      const dir: SortDir = key === "pct_from_52w_high" ? "asc" : "desc";
      return { key, dir };
    });
  }

  // Deep-dive state. The modal renders whichever symbol is "active" and
  // looks up the cached payload (or shows a loading state if the fetch
  // is still in flight). Cache is keyed by symbol so re-opening the same
  // candidate is instant.
  const [deepDives, setDeepDives] = useState<Record<string, DeepDive>>({});
  const [deepDiveLoading, setDeepDiveLoading] = useState<Set<string>>(new Set());
  const [deepDiveError, setDeepDiveError] = useState<Record<string, string>>({});
  const [activeDeepDive, setActiveDeepDive] = useState<Candidate | null>(null);

  // Per-symbol research cache (Yahoo news + fundamentals for the
  // Research tab in the deep-dive drawer). Lazily populated the first
  // time the user opens that tab on a candidate.
  const [research, setResearch] = useState<Record<string, ResearchData>>({});
  const [researchLoading, setResearchLoading] = useState<Set<string>>(new Set());
  const [researchError, setResearchError] = useState<Record<string, string>>({});

  async function loadLatest() {
    setLoading(true);
    try {
      const res = await fetch("/api/swings/discover", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const next = { ...EMPTY_PER_CATEGORY };
      const pc = json.per_category as
        | Record<string, { candidates?: unknown; scanned_at?: string | null }>
        | undefined;
      if (pc) {
        for (const cat of SCANNABLE_CATEGORIES) {
          const bucket = pc[cat];
          const rawList = Array.isArray(bucket?.candidates) ? bucket.candidates : [];
          next[cat] = {
            candidates: rawList.map(normalizeCandidate),
            scannedAt: bucket?.scanned_at ?? null,
          };
        }
      } else if (Array.isArray(json.candidates)) {
        // Fallback for older API shapes — split a flat list by category.
        for (const raw of json.candidates) {
          const c = normalizeCandidate(raw);
          next[c.category].candidates.push(c);
          if (!next[c.category].scannedAt) {
            next[c.category].scannedAt = json.scanned_at ?? null;
          }
        }
      }
      setPerCategory(next);
    } catch (e) {
      console.warn("[swing-discover] load failed:", e);
    } finally {
      setLoading(false);
    }
  }

  async function loadIdeasSymbols() {
    try {
      const res = await fetch("/api/swings/ideas", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) return;
      const set = new Set<string>();
      for (const i of (json.ideas ?? []) as Array<{ symbol: string }>) {
        if (typeof i.symbol === "string") set.add(i.symbol.toUpperCase());
      }
      setIdeasSymbols(set);
    } catch {
      /* non-fatal */
    }
  }

  useEffect(() => {
    loadLatest();
    loadIdeasSymbols();
  }, []);

  async function runScan() {
    setScanning(true);
    setError(null);
    const scope = activeTab; // capture: tab might change while scanning
    try {
      const body: { category?: Category } = scope === "all" ? {} : { category: scope };
      const res = await fetch("/api/swings/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);

      const scannedAt = (json.scanned_at as string) ?? new Date().toISOString();
      const pc = json.per_category as
        | Record<string, { candidates?: unknown; scanned_at?: string | null }>
        | undefined;

      setPerCategory((prev) => {
        const next: PerCategoryState = { ...prev };
        const updateCat = (cat: Category) => {
          const bucket = pc?.[cat];
          if (!bucket) return;
          const rawList = Array.isArray(bucket.candidates) ? bucket.candidates : [];
          next[cat] = {
            candidates: rawList.map(normalizeCandidate),
            scannedAt: bucket.scanned_at ?? scannedAt,
          };
        };
        if (scope === "all") {
          for (const cat of SCANNABLE_CATEGORIES) updateCat(cat);
        } else {
          updateCat(scope);
          // Fallback: if the response didn't include per_category, use the
          // flat list with the scanned scope.
          if (!pc?.[scope] && Array.isArray(json.candidates)) {
            const rawList = json.candidates as unknown[];
            next[scope] = {
              candidates: rawList.map(normalizeCandidate),
              scannedAt,
            };
          }
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function addToIdeas(c: Candidate) {
    setAdding((prev) => {
      const next = new Set(prev);
      next.add(c.symbol);
      return next;
    });
    setError(null);
    try {
      const res = await fetch("/api/swings/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol,
          catalyst: c.catalyst || null,
          user_thesis: c.thesis || null,
          timeframe: c.timeframe,
          analyst_sentiment: c.sentiment === "neutral" ? null : c.sentiment,
          analyst_target: c.analyst_target,
          forward_pe: c.forward_pe,
          price_at_discovery: c.current_price,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setIdeasSymbols((prev) => {
        const next = new Set(prev);
        next.add(c.symbol);
        return next;
      });
    } catch (e) {
      setError(`Add ${c.symbol}: ${e instanceof Error ? e.message : "failed"}`);
    } finally {
      setAdding((prev) => {
        const next = new Set(prev);
        next.delete(c.symbol);
        return next;
      });
    }
  }

  async function openDeepDive(c: Candidate) {
    // Always show the modal immediately — if we have cached data the
    // body renders instantly; otherwise the modal shows a spinner while
    // the Perplexity call resolves.
    setActiveDeepDive(c);
    if (deepDives[c.symbol]) return;
    if (deepDiveLoading.has(c.symbol)) return;

    setDeepDiveLoading((prev) => {
      const next = new Set(prev);
      next.add(c.symbol);
      return next;
    });
    setDeepDiveError((prev) => {
      const next = { ...prev };
      delete next[c.symbol];
      return next;
    });
    try {
      const res = await fetch("/api/swings/discover/deep-dive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol,
          companyName: c.company_name ?? "",
          catalyst: c.catalyst,
          current_price: c.current_price,
          week_52_low: c.week_52_low,
          week_52_high: c.week_52_high,
          forward_pe: c.forward_pe,
          analyst_target: c.analyst_target,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDeepDives((prev) => ({
        ...prev,
        [c.symbol]: json.deep_dive as DeepDive,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Deep dive failed";
      setDeepDiveError((prev) => ({ ...prev, [c.symbol]: msg }));
    } finally {
      setDeepDiveLoading((prev) => {
        const next = new Set(prev);
        next.delete(c.symbol);
        return next;
      });
    }
  }

  function closeDeepDive() {
    setActiveDeepDive(null);
  }

  // Lazy fetch for the Research tab — Yahoo news + fundamentals for the
  // active candidate's symbol. Cached per-symbol so re-opening the tab
  // (or the drawer on the same symbol) is instant.
  async function loadResearch(symbol: string) {
    if (!symbol) return;
    if (research[symbol]) return;
    if (researchLoading.has(symbol)) return;
    setResearchLoading((prev) => {
      const next = new Set(prev);
      next.add(symbol);
      return next;
    });
    setResearchError((prev) => {
      const next = { ...prev };
      delete next[symbol];
      return next;
    });
    try {
      const res = await fetch(
        `/api/swings/discover/research?symbol=${encodeURIComponent(symbol)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResearch((prev) => ({
        ...prev,
        [symbol]: {
          news: Array.isArray(json.news) ? (json.news as NewsItem[]) : [],
          fundamentals: (json.fundamentals as Fundamentals | null) ?? null,
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Research load failed";
      setResearchError((prev) => ({ ...prev, [symbol]: msg }));
    } finally {
      setResearchLoading((prev) => {
        const next = new Set(prev);
        next.delete(symbol);
        return next;
      });
    }
  }

  // Bucket candidates per category from the per-category state. Each
  // category bucket is whatever was last persisted for that category —
  // partial scans only refresh one bucket at a time.
  const buckets = useMemo(() => {
    return {
      momentum: perCategory.momentum.candidates,
      recovery: perCategory.recovery.candidates,
      theme: perCategory.theme.candidates,
      social: perCategory.social.candidates,
    } as Record<Category, Candidate[]>;
  }, [perCategory]);

  // Flat union for the All tab and ideas-symbol matching. Dedup by symbol
  // so a name appearing in two buckets renders once.
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const cat of SCANNABLE_CATEGORIES) {
      for (const c of perCategory[cat].candidates) {
        if (seen.has(c.symbol)) continue;
        seen.add(c.symbol);
        out.push(c);
      }
    }
    return out;
  }, [perCategory]);

  // For the scan-button label and the per-tab timestamp display.
  const scanLabel = (() => {
    if (activeTab === "all") return "Scan All";
    if (activeTab === "momentum") return "Scan Momentum";
    if (activeTab === "recovery") return "Scan Recovery";
    if (activeTab === "theme") return "Scan Themes";
    return "Scan Social";
  })();

  const lastScannedLabel = (() => {
    if (activeTab === "all") {
      const stamps = SCANNABLE_CATEGORIES.map((c) => perCategory[c].scannedAt).filter(
        (s): s is string => s !== null,
      );
      if (stamps.length === 0) return "No scan run yet";
      // Oldest of the four — surfaces "the dataset is stale because X
      // was last scanned days ago" without hiding it behind the newest.
      const oldest = stamps.slice().sort()[0];
      return `Oldest scan: ${fmtRel(oldest)}`;
    }
    const stamp = perCategory[activeTab].scannedAt;
    if (!stamp) return `${prettyCategory(activeTab)} not scanned yet`;
    return `${prettyCategory(activeTab)} last scanned: ${fmtRel(stamp)}`;
  })();

  const themeGroups = useMemo(() => {
    const groups = new Map<string, { momentum: string | null; items: Candidate[] }>();
    for (const c of buckets.theme) {
      const key = c.theme?.trim() || "Other themes";
      const g = groups.get(key) ?? { momentum: c.theme_momentum ?? null, items: [] };
      if (!g.momentum && c.theme_momentum) g.momentum = c.theme_momentum;
      g.items.push(c);
      groups.set(key, g);
    }
    return Array.from(groups.entries());
  }, [buckets.theme]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={runScan} disabled={scanning}>
          {scanning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Scanning…
            </>
          ) : (
            <>
              <RefreshCw className="mr-2 h-4 w-4" />
              {scanLabel}
            </>
          )}
        </Button>
        <span className="text-xs text-muted-foreground">
          {scanning
            ? activeTab === "all"
              ? "Four Perplexity queries + Yahoo enrichment — takes ~25-30s"
              : `Scanning ${prettyCategory(activeTab as Category).toLowerCase()} — takes ~7-10s`
            : lastScannedLabel}
        </span>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs text-rose-200 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {loading && candidates.length === 0 && !scanning ? (
        <div className="text-sm text-muted-foreground">Loading previous scan…</div>
      ) : candidates.length === 0 && !scanning ? (
        <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
          No scan results yet. Click &ldquo;Scan Now&rdquo; to run the AI catalyst
          scanner — it takes about 25-30 seconds.
        </div>
      ) : (
        (() => {
          const rowProps = (c: Candidate) => ({
            candidate: c,
            inIdeas: ideasSymbols.has(c.symbol),
            adding: adding.has(c.symbol),
            deepDiveLoading: deepDiveLoading.has(c.symbol),
            onAdd: () => addToIdeas(c),
            onOpenDeepDive: () => openDeepDive(c),
          });
          const counts = {
            all: candidates.length,
            momentum: buckets.momentum.length,
            recovery: buckets.recovery.length,
            theme: buckets.theme.length,
            social: buckets.social.length,
          };
          return (
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as ActiveTab)}
              className="space-y-4"
            >
              <TabsList className="flex flex-wrap">
                <TabTrigger value="all" label="All" count={counts.all} />
                <TabTrigger
                  value="momentum"
                  label="Momentum"
                  count={counts.momentum}
                />
                <TabTrigger
                  value="recovery"
                  label="Recovery"
                  count={counts.recovery}
                />
                <TabTrigger value="theme" label="Themes" count={counts.theme} />
                <TabTrigger value="social" label="Social" count={counts.social} />
              </TabsList>

              <TabsContent value="all">
                <CandidateTable
                  candidates={sortCandidates(candidates, sort)}
                  sort={sort}
                  onSort={handleHeaderClick}
                  rowProps={rowProps}
                />
              </TabsContent>

              <TabsContent value="momentum">
                {buckets.momentum.length === 0 ? (
                  <EmptyTab label="momentum candidates" />
                ) : (
                  <CandidateTable
                    candidates={sortCandidates(buckets.momentum, sort)}
                    sort={sort}
                    onSort={handleHeaderClick}
                    rowProps={rowProps}
                  />
                )}
              </TabsContent>

              <TabsContent value="recovery">
                {buckets.recovery.length === 0 ? (
                  <EmptyTab label="recovery candidates" />
                ) : (
                  <CandidateTable
                    candidates={sortCandidates(buckets.recovery, sort)}
                    sort={sort}
                    onSort={handleHeaderClick}
                    rowProps={rowProps}
                  />
                )}
              </TabsContent>

              <TabsContent value="theme">
                {themeGroups.length === 0 ? (
                  <EmptyTab label="theme candidates" />
                ) : (
                  <div className="space-y-5">
                    {themeGroups.map(([theme, group]) => (
                      <div key={theme} className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">{theme}</span>
                          {group.momentum && (
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${themeMomentumClasses(group.momentum)}`}
                            >
                              {group.momentum} momentum
                            </span>
                          )}
                        </div>
                        <CandidateTable
                          candidates={sortCandidates(group.items, sort)}
                          sort={sort}
                          onSort={handleHeaderClick}
                          rowProps={rowProps}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="social">
                <div className="mb-3 flex items-start gap-2 rounded border border-violet-500/30 bg-violet-500/5 p-2.5 text-[11px] text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" />
                  <span>
                    Social signals are sourced from financial media coverage of
                    retail sentiment. For direct X / Reddit data, connect a
                    social API.
                  </span>
                </div>
                {buckets.social.length === 0 ? (
                  <EmptyTab label="social/retail candidates" />
                ) : (
                  <>
                    <p className="mb-3 text-xs text-muted-foreground">
                      What retail traders and financial communities are talking
                      about — ahead of analyst consensus
                    </p>
                    <CandidateTable
                      candidates={sortCandidates(buckets.social, sort)}
                      sort={sort}
                      onSort={handleHeaderClick}
                      rowProps={rowProps}
                    />
                  </>
                )}
              </TabsContent>
            </Tabs>
          );
        })()
      )}

      <DeepDiveDrawer
        candidate={activeDeepDive}
        dive={activeDeepDive ? (deepDives[activeDeepDive.symbol] ?? null) : null}
        loading={
          activeDeepDive ? deepDiveLoading.has(activeDeepDive.symbol) : false
        }
        error={
          activeDeepDive ? (deepDiveError[activeDeepDive.symbol] ?? null) : null
        }
        inIdeas={
          activeDeepDive ? ideasSymbols.has(activeDeepDive.symbol) : false
        }
        adding={activeDeepDive ? adding.has(activeDeepDive.symbol) : false}
        research={
          activeDeepDive ? (research[activeDeepDive.symbol] ?? null) : null
        }
        researchLoading={
          activeDeepDive ? researchLoading.has(activeDeepDive.symbol) : false
        }
        researchError={
          activeDeepDive ? (researchError[activeDeepDive.symbol] ?? null) : null
        }
        onLoadResearch={loadResearch}
        onAdd={() => activeDeepDive && addToIdeas(activeDeepDive)}
        onClose={closeDeepDive}
      />
    </div>
  );
}

function TabTrigger({
  value,
  label,
  count,
}: {
  value: string;
  label: string;
  count: number;
}) {
  return (
    <TabsTrigger value={value} className="gap-2">
      <span>{label}</span>
      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium">
        {count}
      </span>
    </TabsTrigger>
  );
}

function EmptyTab({ label }: { label: string }) {
  return (
    <div className="rounded border border-border bg-background/40 p-6 text-sm text-muted-foreground">
      No {label} in this scan.
    </div>
  );
}

// 14-column desktop grid + a 6-column mobile grid. Cells in the JSX flow
// in desktop order; mobile-only cells get `hidden md:block` (or similar)
// to drop out of the grid on small screens, leaving the 6 visible cells
// to fill the 6-column mobile template precisely.
const ROW_GRID =
  "grid w-full items-center gap-2 px-3 grid-cols-[24px_minmax(50px,1fr)_70px_60px_60px_minmax(70px,1fr)] md:grid-cols-[24px_80px_minmax(120px,1.5fr)_80px_70px_80px_80px_60px_minmax(100px,1fr)_70px_70px_70px_60px_140px]";

type RowProps = {
  candidate: Candidate;
  inIdeas: boolean;
  adding: boolean;
  deepDiveLoading: boolean;
  onAdd: () => void;
  onOpenDeepDive: () => void;
};

function CandidateTable({
  candidates,
  sort,
  onSort,
  rowProps,
}: {
  candidates: Candidate[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  rowProps: (c: Candidate) => RowProps;
}) {
  return (
    <div className="space-y-1">
      <CandidateTableHeader sort={sort} onSort={onSort} />
      <div className="space-y-1">
        {candidates.map((c) => (
          <CandidateRow key={c.symbol} {...rowProps(c)} />
        ))}
      </div>
    </div>
  );
}

function CandidateTableHeader({
  sort,
  onSort,
}: {
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div
      className={`${ROW_GRID} border-b border-border/60 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground`}
    >
      <div />
      <SortHeader label="Symbol" />
      <SortHeader label="Company" className="hidden md:block" />
      <SortHeader
        label="Price"
        sortKey="current_price"
        sort={sort}
        onSort={onSort}
        align="right"
      />
      <SortHeader
        label="Chg %"
        sortKey="price_change_pct"
        sort={sort}
        onSort={onSort}
        align="right"
      />
      <SortHeader
        label="From High"
        sortKey="pct_from_52w_high"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
      />
      <SortHeader
        label="vs 50d MA"
        sortKey="vs_50d_ma_pct"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
      />
      <SortHeader
        label="Fwd P/E"
        sortKey="forward_pe"
        sort={sort}
        onSort={onSort}
        align="right"
        className="hidden md:block"
      />
      <SortHeader label="Signal" className="hidden md:block" />
      <SortHeader label="Seen" className="hidden md:block" align="center" />
      <SortHeader
        label="Confidence"
        sortKey="confidence"
        sort={sort}
        onSort={onSort}
        align="center"
      />
      <SortHeader
        label="Sentiment"
        className="hidden md:block"
        align="center"
      />
      <SortHeader label="Cap" className="hidden md:block" align="center" />
      <SortHeader label="Actions" align="right" />
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className = "",
  align = "left",
}: {
  label: string;
  sortKey?: SortKey;
  sort?: SortState;
  onSort?: (key: SortKey) => void;
  className?: string;
  align?: "left" | "right" | "center";
}) {
  const alignCls =
    align === "right"
      ? "justify-end text-right"
      : align === "center"
        ? "justify-center text-center"
        : "justify-start text-left";
  const isActive = !!sortKey && sort?.key === sortKey;
  if (!sortKey) {
    return <div className={`flex ${alignCls} ${className}`}>{label}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onSort?.(sortKey)}
      className={`flex items-center gap-0.5 ${alignCls} ${className} hover:text-foreground ${isActive ? "text-foreground" : ""}`}
    >
      <span>{label}</span>
      {isActive && (
        <span className="text-[9px]">{sort?.dir === "asc" ? "▲" : "▼"}</span>
      )}
    </button>
  );
}

function CandidateRow({
  candidate: c,
  inIdeas,
  adding,
  deepDiveLoading,
  onAdd,
  onOpenDeepDive,
}: RowProps) {
  const [expanded, setExpanded] = useState(false);
  const changeColor =
    c.price_change_pct === null
      ? "text-muted-foreground"
      : c.price_change_pct >= 0
        ? "text-emerald-300"
        : "text-rose-300";
  const fromHigh = fmtFromHighShort(c.pct_from_52w_high);
  const ma50 = fmt50dMAShort(c.vs_50d_ma_pct);
  const accent = categoryAccentClasses(c.category);

  return (
    <div
      className={`overflow-hidden rounded-md border ${accent} ${expanded ? "border-foreground/20" : ""}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`${ROW_GRID} py-2 text-xs hover:bg-white/[0.02]`}
      >
        {/* 1. Chevron */}
        <div className="flex h-4 w-4 items-center justify-center text-muted-foreground">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </div>
        {/* 2. Symbol */}
        <div className="truncate text-left font-mono text-sm font-semibold text-foreground">
          {c.symbol}
        </div>
        {/* 3. Company — hidden on mobile */}
        <div className="hidden truncate text-left text-[11px] text-muted-foreground md:block">
          {c.company_name ?? ""}
        </div>
        {/* 4. Price */}
        <div className="text-right font-mono text-foreground">
          {fmtMoney(c.current_price)}
        </div>
        {/* 5. Chg% */}
        <div className={`text-right ${changeColor}`}>
          {c.price_change_pct !== null
            ? `${c.price_change_pct >= 0 ? "▲" : "▼"}${Math.abs(c.price_change_pct).toFixed(2)}%`
            : "—"}
        </div>
        {/* 6. From High — hidden mobile */}
        <div
          className={`hidden text-right md:block ${fromHigh ? fromHigh.cls : "text-muted-foreground"}`}
        >
          {fromHigh ? fromHigh.text : "—"}
        </div>
        {/* 7. vs 50d MA — hidden mobile */}
        <div
          className={`hidden text-right md:block ${ma50 ? ma50.cls : "text-muted-foreground"}`}
        >
          {ma50 ? ma50.text : "—"}
        </div>
        {/* 8. Fwd P/E — hidden mobile */}
        <div className="hidden text-right text-foreground md:block">
          {c.forward_pe !== null ? `${c.forward_pe.toFixed(1)}x` : "—"}
        </div>
        {/* 9. Signal basis — hidden mobile */}
        <div className="hidden truncate text-left text-foreground/90 md:block">
          {c.signal_basis ? (
            <span className="inline-flex items-center gap-1">
              <Signal className="h-3 w-3 shrink-0 text-sky-300" />
              <span className="truncate">{c.signal_basis}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
        {/* 10. Seen — hidden mobile */}
        <div className="hidden justify-center md:flex">
          <SeenBadge
            count={c.appearance_count}
            firstSeenAt={c.first_seen_at}
            category={c.category}
          />
        </div>
        {/* 11. Confidence */}
        <div className="flex justify-center">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${confidenceClasses(c.confidence)}`}
          >
            {c.confidence}
          </span>
        </div>
        {/* 12. Sentiment — hidden mobile */}
        <div className="hidden justify-center md:flex">
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${sentimentClasses(c.sentiment)}`}
          >
            {c.sentiment}
          </span>
        </div>
        {/* 13. Cap — hidden mobile */}
        <div className="hidden justify-center md:flex">
          {c.market_cap_category ? (
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${marketCapPillClasses(c.market_cap_category)}`}
            >
              {marketCapLabel(c.market_cap_category)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
        {/* 14. Actions */}
        <div
          className="flex items-center justify-end gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <RowActions
            inIdeas={inIdeas}
            adding={adding}
            deepDiveLoading={deepDiveLoading}
            onAdd={onAdd}
            onOpenDeepDive={onOpenDeepDive}
          />
        </div>
      </button>
      {expanded && (
        <CandidateRowExpansion
          candidate={c}
          inIdeas={inIdeas}
          adding={adding}
          deepDiveLoading={deepDiveLoading}
          onAdd={onAdd}
          onOpenDeepDive={onOpenDeepDive}
        />
      )}
    </div>
  );
}

function RowActions({
  inIdeas,
  adding,
  deepDiveLoading,
  onAdd,
  onOpenDeepDive,
  size = "compact",
}: {
  inIdeas: boolean;
  adding: boolean;
  deepDiveLoading: boolean;
  onAdd: () => void;
  onOpenDeepDive: () => void;
  size?: "compact" | "full";
}) {
  const padding = size === "full" ? "px-2 py-1" : "px-1.5 py-0.5";
  return (
    <>
      {inIdeas ? (
        <span
          className={`inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 ${padding} text-[10px] font-medium text-emerald-300`}
          title="Already in Ideas"
        >
          <CheckCircle2 className="h-3 w-3" />
          {size === "full" ? "In Ideas" : "Ideas"}
        </span>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          disabled={adding}
          className={`inline-flex items-center gap-1 rounded border border-border bg-white/5 ${padding} text-[10px] font-medium text-foreground hover:bg-white/10 disabled:opacity-50`}
          title="Add to Ideas"
        >
          {adding ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
          <span>Ideas</span>
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenDeepDive();
        }}
        className={`inline-flex items-center gap-1 rounded border border-border ${padding} text-[10px] text-muted-foreground hover:bg-white/5 hover:text-foreground`}
        title="Deep dive"
      >
        {deepDiveLoading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Telescope className="h-3 w-3" />
        )}
        <span>Dive</span>
      </button>
    </>
  );
}

function CandidateRowExpansion({
  candidate: c,
  inIdeas,
  adding,
  deepDiveLoading,
  onAdd,
  onOpenDeepDive,
}: {
  candidate: Candidate;
  inIdeas: boolean;
  adding: boolean;
  deepDiveLoading: boolean;
  onAdd: () => void;
  onOpenDeepDive: () => void;
}) {
  return (
    <div className="border-t border-border/60 bg-background/40 px-3 py-3 text-xs">
      {c.catalyst && (
        <div className="mb-2 italic text-foreground/80">
          &ldquo;{c.catalyst}&rdquo;
        </div>
      )}
      {c.risk && (
        <div className="mb-2 flex items-start gap-1 text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
          <span>Risk: {c.risk}</span>
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-muted-foreground">
          Timeframe: {timeframeLabel(c.timeframe)}
        </span>
        {c.category === "theme" && c.theme && (
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-muted-foreground">
            Theme: {c.theme}
          </span>
        )}
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${categoryBadgeClasses(c.category)}`}
        >
          {categoryLabel(c.category)}
        </span>
      </div>
      {c.sources.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Sources:</span>
          {c.sources.slice(0, 5).map((src, i) => (
            <a
              key={i}
              href={ensureHttp(src)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="rounded border border-white/10 px-2 py-0.5 text-[10px] text-muted-foreground hover:border-white/30 hover:text-foreground"
            >
              {domainOf(src)}
            </a>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <RowActions
          inIdeas={inIdeas}
          adding={adding}
          deepDiveLoading={deepDiveLoading}
          onAdd={onAdd}
          onOpenDeepDive={onOpenDeepDive}
          size="full"
        />
      </div>
    </div>
  );
}

// Compact variants used inline in the row — abbreviate "↓ 35% from high"
// to "-35%" so the cell fits within an 80px column.
function fmtFromHighShort(
  pct: number | null,
): { text: string; cls: string } | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const cls =
    pct < -40
      ? "text-rose-300"
      : pct < -20
        ? "text-amber-300"
        : "text-muted-foreground";
  return { text: `${pct.toFixed(0)}%`, cls };
}

function fmt50dMAShort(
  pct: number | null,
): { text: string; cls: string } | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const cls = pct >= 0 ? "text-emerald-300" : "text-rose-300";
  const sign = pct >= 0 ? "+" : "";
  return { text: `${sign}${pct.toFixed(0)}%`, cls };
}

function SeenBadge({
  count,
  firstSeenAt,
  category,
}: {
  count: number;
  firstSeenAt: string | null;
  category: Category;
}) {
  if (count <= 1) return null;
  // Hide for first-time appearances even if multiple scans were run today —
  // the indicator is meant to flag *recurrence* across days, not within a
  // single session.
  if (firstSeenAt) {
    const f = new Date(firstSeenAt);
    if (!Number.isNaN(f.getTime())) {
      const now = new Date();
      const sameDay =
        f.getFullYear() === now.getFullYear() &&
        f.getMonth() === now.getMonth() &&
        f.getDate() === now.getDate();
      if (sameDay) return null;
    }
  }
  const firstSeenLabel = firstSeenAt
    ? new Date(firstSeenAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "earlier";
  const tooltip = `Appeared ${count} times in ${prettyCategory(category)} scans this month. First seen ${firstSeenLabel}.`;
  if (count >= 5) {
    return (
      <span className="text-[11px] text-emerald-300" title={tooltip}>
        🔥🔥 5x+
      </span>
    );
  }
  if (count >= 3) {
    return (
      <span className="text-[11px] text-amber-300" title={tooltip}>
        🔥 {count}x
      </span>
    );
  }
  return (
    <span className="text-[11px] text-muted-foreground" title={tooltip}>
      🔁 2x
    </span>
  );
}

type DrawerTab = "analysis" | "news" | "research" | "sources";

function DeepDiveDrawer({
  candidate: c,
  dive,
  loading,
  error,
  inIdeas,
  adding,
  research,
  researchLoading,
  researchError,
  onLoadResearch,
  onAdd,
  onClose,
}: {
  candidate: Candidate | null;
  dive: DeepDive | null;
  loading: boolean;
  error: string | null;
  inIdeas: boolean;
  adding: boolean;
  research: ResearchData | null;
  researchLoading: boolean;
  researchError: string | null;
  onLoadResearch: (symbol: string) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const open = c !== null;
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("analysis");

  // Reset to Analysis whenever a new candidate is opened so the user
  // doesn't land on the Sources / Research tab from the previous symbol.
  useEffect(() => {
    if (c) setDrawerTab("analysis");
  }, [c?.symbol]);

  // Lazy-fetch the Yahoo research payload the first time the user opens
  // either the News or Research tab on this candidate. Both tabs read
  // from the same cached response — cache hits short-circuit inside
  // onLoadResearch.
  useEffect(() => {
    if (!c) return;
    if (drawerTab !== "news" && drawerTab !== "research") return;
    onLoadResearch(c.symbol);
  }, [c?.symbol, drawerTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeColor =
    !c || c.price_change_pct === null
      ? "text-muted-foreground"
      : c.price_change_pct >= 0
        ? "text-emerald-300"
        : "text-rose-300";

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex h-full w-[55vw] flex-col gap-0 p-0 sm:max-w-none"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <SheetTitle className="flex flex-wrap items-baseline gap-2 text-lg">
              <span className="font-mono">{c?.symbol}</span>
              {c?.company_name && (
                <span className="truncate text-sm font-normal text-muted-foreground">
                  — {c.company_name}
                </span>
              )}
            </SheetTitle>
            {c && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-foreground">
                  {fmtMoney(c.current_price)}
                </span>
                <span className={changeColor}>
                  {c.price_change_pct !== null
                    ? `${c.price_change_pct >= 0 ? "▲" : "▼"} ${fmtPct(c.price_change_pct, 2)}`
                    : ""}
                </span>
                <span className="text-muted-foreground">|</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${categoryBadgeClasses(c.category)}`}
                >
                  {categoryLabel(c.category)}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${confidenceClasses(c.confidence)}`}
                >
                  {c.confidence}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${sentimentClasses(c.sentiment)}`}
                >
                  {c.sentiment}
                </span>
                {c.market_cap_category && (
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${marketCapPillClasses(c.market_cap_category)}`}
                  >
                    {marketCapLabel(c.market_cap_category)}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body — tabbed. Analysis = the deep-dive sections; Sources &
            Summary = clickable source list with on-demand AI summaries. */}
        <Tabs
          value={drawerTab}
          onValueChange={(v) => setDrawerTab(v as "analysis" | "sources")}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-b border-border px-6 pt-3">
            <TabsList>
              <TabsTrigger value="analysis">📊 Analysis</TabsTrigger>
              <TabsTrigger value="news">📰 News</TabsTrigger>
              <TabsTrigger value="research">🔬 Research</TabsTrigger>
              <TabsTrigger value="sources">
                🔗 Sources
                {c && c.sources.length > 0 && (
                  <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px]">
                    {c.sources.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent
            value="analysis"
            className="min-h-0 flex-1 overflow-y-auto px-6 py-6 text-base"
          >
            {loading && !dive && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="h-7 w-7 animate-spin" />
                <span className="text-base">
                  Researching {c?.symbol ?? ""}…
                </span>
                <span className="text-xs">
                  Pulling recent news, fundamentals, sentiment, and bear case
                </span>
              </div>
            )}

            {!loading && !dive && error && (
              <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">
                {error}
              </div>
            )}

            {dive && (
              <div className="space-y-6">
                <DeepSection title="📰 Recent news">
                  <p className="leading-relaxed text-foreground/90">
                    {dive.recent_news}
                  </p>
                </DeepSection>

                <DeepSection title="💰 Fundamental health">
                  <p className="leading-relaxed text-foreground/90">
                    {dive.fundamental_health}
                  </p>
                </DeepSection>

                <DeepSection title="⚡ Catalyst">
                  <div className="mb-2 flex flex-wrap gap-4 text-sm">
                    <span className="text-muted-foreground">
                      Credibility:{" "}
                      <span className="font-medium uppercase text-foreground">
                        {dive.catalyst_credibility}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      Timeline:{" "}
                      <span className="text-foreground">
                        {dive.catalyst_timeline}
                      </span>
                    </span>
                  </div>
                  {c?.catalyst && (
                    <p className="leading-relaxed text-foreground/90">
                      &ldquo;{c.catalyst}&rdquo;
                    </p>
                  )}
                </DeepSection>

                <DeepSection title="👥 Sentiment">
                  <div className="flex flex-wrap gap-6 text-sm">
                    <span className="text-muted-foreground">
                      Retail:{" "}
                      <span className="font-medium capitalize text-foreground">
                        {dive.retail_sentiment}
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      Institutional:{" "}
                      <span className="font-medium capitalize text-foreground">
                        {dive.institutional_activity}
                      </span>
                    </span>
                  </div>
                </DeepSection>

                <DeepSection title="📊 Technical setup">
                  <div className="text-foreground/90">
                    {technicalLabel(dive.technical_setup)}
                  </div>
                  {dive.entry_comment && (
                    <p className="mt-1 leading-relaxed text-muted-foreground">
                      {dive.entry_comment}
                    </p>
                  )}
                </DeepSection>

                {dive.bear_case.length > 0 && (
                  <DeepSection title="⚠ Bear case">
                    <ul className="list-disc space-y-1 pl-5 leading-relaxed text-foreground/90">
                      {dive.bear_case.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </DeepSection>
                )}

                <div
                  className={`rounded border p-5 ${verdictClasses(dive.verdict)}`}
                >
                  <div className="text-xs font-semibold uppercase tracking-wider">
                    Verdict: {dive.verdict} priority
                  </div>
                  {dive.verdict_reasoning && (
                    <p className="mt-2 text-base leading-relaxed">
                      {dive.verdict_reasoning}
                    </p>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent
            value="news"
            className="min-h-0 flex-1 overflow-y-auto px-6 py-6 text-base"
          >
            <ResearchNews
              data={research}
              loading={researchLoading}
              error={researchError}
            />
          </TabsContent>

          <TabsContent
            value="research"
            className="min-h-0 flex-1 overflow-y-auto px-6 py-6 text-base"
          >
            {c && (
              <div className="space-y-6">
                <ResearchFundamentals
                  candidate={c}
                  data={research}
                  loading={researchLoading}
                />
                <ResearchQuickLinks candidate={c} />
              </div>
            )}
          </TabsContent>

          <TabsContent
            value="sources"
            className="min-h-0 flex-1 overflow-y-auto px-6 py-6 text-base"
          >
            {!c || c.sources.length === 0 ? (
              <div className="rounded border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                No sources attached to this candidate.
              </div>
            ) : (
              <ol className="space-y-2 pl-5 text-sm leading-relaxed text-foreground/90">
                {c.sources.map((rawSrc, i) => {
                  const src = ensureHttp(rawSrc);
                  return (
                    <li key={i} className="list-decimal">
                      <a
                        href={src}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sky-300 underline-offset-2 hover:underline"
                      >
                        <span className="font-medium">{domainOf(src)}</span>
                        <ExternalLink className="h-3 w-3 opacity-60" />
                      </a>
                      <div className="ml-1 truncate text-[11px] text-muted-foreground">
                        {src}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </TabsContent>
        </Tabs>

        {/* Footer — sticky */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          {!inIdeas && c && (
            <Button
              onClick={onAdd}
              disabled={adding}
              variant="outline"
              size="sm"
            >
              {adding ? (
                <>
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  Adding…
                </>
              ) : (
                <>
                  <Plus className="mr-1 h-3 w-3" />
                  Add to Ideas
                </>
              )}
            </Button>
          )}
          {inIdeas && (
            <span className="flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />
              Already in Ideas
            </span>
          )}
          <Button onClick={onClose} variant="ghost" size="sm">
            <X className="mr-1 h-3 w-3" />
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ----- News tab content (lazy-loaded Yahoo Finance headlines) -----

function ResearchNews({
  data,
  loading,
  error,
}: {
  data: ResearchData | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <DeepSection title="📰 Recent news (last 7)">
      {loading && !data && <SkeletonList rows={4} />}
      {!loading && error && !data && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">
          {error}
        </div>
      )}
      {data && data.news.length === 0 && (
        <div className="text-sm text-muted-foreground">
          No recent news found.
        </div>
      )}
      {data && data.news.length > 0 && (
        <ul className="space-y-2">
          {data.news.map((n, i) => (
            <li
              key={i}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-background/40 p-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-sm leading-relaxed text-foreground/90">
                  {n.title}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {[n.publisher, n.publishedAt].filter(Boolean).join(" · ")}
                </div>
              </div>
              <a
                href={ensureHttp(n.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-white/5 px-2 py-1 text-[11px] text-foreground hover:bg-white/10"
              >
                <ExternalLink className="h-3 w-3" />
                Open
              </a>
            </li>
          ))}
        </ul>
      )}
    </DeepSection>
  );
}

// ----- Fundamentals grid -----

function ResearchFundamentals({
  candidate: c,
  data,
  loading,
}: {
  candidate: Candidate;
  data: ResearchData | null;
  loading: boolean;
}) {
  const f = data?.fundamentals ?? null;

  return (
    <DeepSection title="💰 Key fundamentals">
      {loading && !f && <SkeletonList rows={4} />}
      {!loading && !f && (
        <div className="text-sm text-muted-foreground">
          Yahoo did not return fundamentals for {c.symbol}.
        </div>
      )}
      {f && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <FundRow
            label="Revenue Growth"
            value={fmtGrowth(f.revenueGrowth)}
            tone={growthTone(f.revenueGrowth)}
          />
          <FundRow
            label="Earnings Growth"
            value={fmtGrowth(f.earningsGrowth)}
            tone={growthTone(f.earningsGrowth)}
          />
          <FundRow
            label="EPS (TTM)"
            value={f.trailingEps !== null ? `$${f.trailingEps.toFixed(2)}` : "—"}
          />
          <FundRow
            label="EPS (Fwd)"
            value={f.forwardEps !== null ? `$${f.forwardEps.toFixed(2)}` : "—"}
          />
          <FundRow
            label="Analyst Rating"
            value={fmtRating(f.recommendationKey, f.recommendationMean)}
            tone={ratingTone(f.recommendationMean)}
          />
          <FundRow
            label="# Analysts"
            value={
              f.numberOfAnalystOpinions !== null
                ? String(f.numberOfAnalystOpinions)
                : "—"
            }
          />
          <FundRow
            label="Target Range"
            value={fmtTargetRange(f.targetLowPrice, f.targetHighPrice)}
          />
          <FundRow
            label="Target Mean"
            value={
              f.targetMeanPrice !== null
                ? `$${f.targetMeanPrice.toFixed(2)}`
                : "—"
            }
          />
          <FundRow
            label="Insider Owned"
            value={fmtPctDecimal(f.heldPercentInsiders)}
          />
          <FundRow
            label="Institution Owned"
            value={fmtPctDecimal(f.heldPercentInstitutions)}
          />
          <FundRow
            label="Short Float"
            value={fmtPctDecimal(f.shortPercentOfFloat)}
            tone={shortTone(f.shortPercentOfFloat)}
          />
        </div>
      )}
    </DeepSection>
  );
}

function FundRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  const cls =
    tone === "good"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : "text-foreground/90";
  return (
    <div className="flex items-center justify-between border-b border-border/40 pb-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${cls}`}>{value}</span>
    </div>
  );
}

function fmtGrowth(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(0)}% YoY`;
}
function growthTone(v: number | null): "good" | "warn" | "bad" | undefined {
  if (v === null || !Number.isFinite(v)) return undefined;
  const pct = v * 100;
  if (pct > 15) return "good";
  if (pct >= 5) return "warn";
  return "bad";
}
function fmtPctDecimal(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
function shortTone(v: number | null): "good" | "warn" | "bad" | undefined {
  if (v === null || !Number.isFinite(v)) return undefined;
  const pct = v * 100;
  if (pct < 5) return "good";
  if (pct < 15) return "warn";
  return "bad";
}
function fmtRating(key: string | null, mean: number | null): string {
  const label = (() => {
    if (!key) return null;
    if (key === "strong_buy") return "Strong Buy";
    if (key === "buy") return "Buy";
    if (key === "hold") return "Hold";
    if (key === "sell") return "Sell";
    if (key === "strong_sell") return "Strong Sell";
    return key;
  })();
  if (label && mean !== null) return `${label} (${mean.toFixed(1)}/5)`;
  if (label) return label;
  if (mean !== null) return `${mean.toFixed(1)}/5`;
  return "—";
}
function ratingTone(mean: number | null): "good" | "warn" | "bad" | undefined {
  if (mean === null || !Number.isFinite(mean)) return undefined;
  if (mean < 2) return "good";
  if (mean <= 3) return "warn";
  return "bad";
}
function fmtTargetRange(low: number | null, high: number | null): string {
  if (low === null && high === null) return "—";
  const l = low !== null ? `$${low.toFixed(0)}` : "—";
  const h = high !== null ? `$${high.toFixed(0)}` : "—";
  return `${l} - ${h}`;
}

// ----- Quick research links -----

function ResearchQuickLinks({ candidate: c }: { candidate: Candidate }) {
  const sym = encodeURIComponent(c.symbol);
  const links: Array<{ label: string; href: string }> = [
    {
      label: `▶ YouTube · "${c.symbol} stock analysis"`,
      href: `https://www.youtube.com/results?search_query=${sym}+stock+analysis`,
    },
    {
      label: `𝕏 · $${c.symbol}`,
      href: `https://x.com/search?q=%24${sym}&src=typed_query&f=live`,
    },
    {
      label: `👥 Reddit · r/stocks + WSB`,
      href: `https://www.reddit.com/search/?q=${sym}&sort=new`,
    },
    {
      label: `📋 SEC filings`,
      href: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${sym}&type=10-K`,
    },
    {
      label: `📖 Encyclopedia`,
      href: `/encyclopedia?symbol=${sym}`,
    },
  ];
  return (
    <DeepSection title="🔍 Research links">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-sm text-foreground/90 hover:bg-background/60"
          >
            <span className="truncate">{l.label}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </a>
        ))}
      </div>
    </DeepSection>
  );
}

function SkeletonList({ rows }: { rows: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded-md border border-border bg-background/40"
        />
      ))}
    </div>
  );
}

function DeepSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-base font-semibold tracking-wide text-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}
