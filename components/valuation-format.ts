// Shared formatters + input helpers for the valuation tab. Lives in
// /components so the valuation-tab files can import without spreading
// formatting logic across them.

export function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}
export function fmtSignedPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  const v = (n * 100).toFixed(digits);
  return n >= 0 ? `+${v}%` : `${v}%`;
}
export function fmtPE(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}x`;
}
export function fmtBigDollars(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}
export function fmtRoundPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${Math.round(n)}`;
}
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
// Date + time, used wherever multiple entries can land on the same day
// (version dropdown, version history list).
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}
export function fmtMillions(rawShares: number): string {
  if (!Number.isFinite(rawShares)) return "—";
  return `${(rawShares / 1e6).toFixed(1)}M`;
}

// Two input flavours: percent fields (5 ↔ 0.05) and bare numbers (P/E,
// beta, exit multiple). We accept either form so the user can paste
// values from spreadsheets that use either convention.
export type CellKind = "pct" | "pe" | "beta" | "shares_m" | "raw";

export function parseInputValue(raw: string, kind: CellKind): number | null {
  const trimmed = raw.replace(/[%xX$]/g, "").trim();
  if (trimmed === "" || trimmed === "-") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (kind === "pe" || kind === "beta" || kind === "raw") return n;
  if (kind === "shares_m") return n * 1e6;
  // pct — ≥1.5 (or ≤-1.5) reads as whole-number percent.
  if (Math.abs(n) >= 1.5) return n / 100;
  return n;
}

export function formatInputValue(value: number, kind: CellKind): string {
  if (kind === "pe") return value.toFixed(1);
  if (kind === "beta") return value.toFixed(2);
  if (kind === "raw") return value.toFixed(2);
  if (kind === "shares_m") return (value / 1e6).toFixed(1);
  return (value * 100).toFixed(1);
}

export function displayValue(value: number, kind: CellKind): string {
  if (kind === "pe") return fmtPE(value);
  if (kind === "beta") return value.toFixed(2);
  if (kind === "raw") return value.toFixed(2);
  if (kind === "shares_m") return fmtMillions(value);
  return fmtPct(value);
}
