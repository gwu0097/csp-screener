"use client";

// Qualtrim-style structured signal-card renderer for the Earnings
// Reports Stage A analysis (lib/earnings-analysis-cards.ts on the
// server side). Type-only import — this file never touches the
// server-only module the types live in (Supabase/Perplexity), so it's
// safe to bundle client-side.
import type { Card, CardsPayload, PendingStub, SectionKey } from "@/lib/earnings-analysis-cards";
import { cn } from "@/lib/utils";

const SECTION_ORDER: SectionKey[] = ["ai_generated_insights", "what_changed_this_quarter", "red_flags", "strengths"];
const SECTION_LABELS: Record<SectionKey, string> = {
  ai_generated_insights: "AI Generated Insights",
  what_changed_this_quarter: "What Changed This Quarter",
  red_flags: "Red Flags",
  strengths: "Strengths",
};

function isPendingStub(c: Card | PendingStub): c is PendingStub {
  return (c as PendingStub).status === "pending_10q";
}

// Signal is the loudest tag on the card — filled background, full
// color weight. Bullish/bearish reuse the same emerald/rose the rest
// of this app already uses for positive/negative figures
// (research-sec-filings.tsx's pctColor); neutral gets amber, a color
// not otherwise used for signal so it doesn't read as "good" or "bad."
const SIGNAL_STYLES: Record<Card["signal"], string> = {
  bullish: "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
  bearish: "border-rose-500/50 bg-rose-500/15 text-rose-300",
  neutral: "border-amber-500/50 bg-amber-500/15 text-amber-300",
};

// Severity is a second, deliberately DIFFERENT-weight tag (red_flags
// only) — high is louder than the signal tag itself (a genuine
// high-severity flag should read as more alarming than a routine
// bearish signal), medium is on par, low is quiet/outlined so a minor
// flag doesn't visually compete with the real ones.
const SEVERITY_STYLES: Record<"high" | "medium" | "low", string> = {
  high: "border-rose-400 bg-rose-500/30 text-rose-100",
  medium: "border-amber-500/50 bg-amber-500/15 text-amber-300",
  low: "border-border bg-background/40 text-muted-foreground",
};

function SignalTag({ signal }: { signal: Card["signal"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        SIGNAL_STYLES[signal],
      )}
    >
      {signal}
    </span>
  );
}

function SeverityTag({ severity }: { severity: "high" | "medium" | "low" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
        SEVERITY_STYLES[severity],
      )}
    >
      {severity} severity
    </span>
  );
}

// Basis is deliberately the subtlest marker on the card — plain small
// text, no border/fill, so it never competes with the signal tag for
// attention. It's still visually distinguishable (stated is quieter/
// muted, inferred gets a faint violet tint, echoing this app's existing
// "AI-derived" violet convention from the AiSummaryBadge) but reads as
// a footnote, not a verdict.
function BasisMarker({ basis }: { basis: Card["basis"] }) {
  return (
    <span
      className={cn(
        "text-[9px] uppercase tracking-wide",
        basis === "inferred" ? "text-violet-300/70" : "text-muted-foreground/70",
      )}
    >
      {basis}
    </span>
  );
}

function SignalCardBlock({ card }: { card: Card }) {
  return (
    <div className="rounded-md border border-border bg-background/60 p-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <SignalTag signal={card.signal} />
        {card.severity && <SeverityTag severity={card.severity} />}
        <span className="ml-auto">
          <BasisMarker basis={card.basis} />
        </span>
      </div>
      <div className="text-[12px] font-semibold text-foreground">{card.title}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-foreground/85">{card.argument}</p>
      <div className="mt-1.5 border-t border-border/40 pt-1.5">
        <div className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Metric Evidence</div>
        <ul className="mt-0.5 space-y-0.5">
          {card.metric_evidence.map((e, i) => (
            <li key={i} className="text-[10px] font-mono leading-snug text-foreground/70">
              · {e}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PendingStubBlock({ stub }: { stub: PendingStub }) {
  return (
    <div className="rounded-md border border-dashed border-border/60 bg-background/30 p-2.5 text-[11px] text-muted-foreground">
      <span className="mr-1.5 inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
        pending 10-Q
      </span>
      <span className="font-medium text-foreground/80">{stub.title}</span>
      <span> — {stub.note}</span>
    </div>
  );
}

export function EarningsCardsView({ cards }: { cards: CardsPayload }) {
  return (
    <div className="space-y-3">
      {SECTION_ORDER.map((key) => {
        const items = cards.sections[key];
        return (
          <div key={key}>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-300/90">
              {SECTION_LABELS[key]}
            </div>
            {items.length === 0 ? (
              <div className="text-[10px] text-muted-foreground/70">None disclosed this quarter.</div>
            ) : (
              <div className="space-y-1.5">
                {items.map((item, i) =>
                  isPendingStub(item) ? (
                    <PendingStubBlock key={i} stub={item} />
                  ) : (
                    <SignalCardBlock key={i} card={item} />
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
      {cards.pending_stage_b.length > 0 && (
        <div className="text-[9px] italic text-muted-foreground/60">
          Pending Stage B: {cards.pending_stage_b.join("; ")}
        </div>
      )}
    </div>
  );
}
