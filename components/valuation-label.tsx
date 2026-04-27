"use client";

// Label with optional tooltip — dotted underline indicates the cell has
// help content available. Used for editable-row labels in the
// projection / DCF input grids.

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function LabelWithTooltip({
  label,
  help,
}: {
  label: string;
  help?: React.ReactNode;
}) {
  if (!help) {
    return <span>{label}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 hover:decoration-foreground/80">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        className="max-w-[340px] whitespace-normal text-left"
      >
        {help}
      </TooltipContent>
    </Tooltip>
  );
}

// Standardised body layout for the long-form copy in the valuation
// tooltips. We keep the markup here so the tooltip-content factories
// stay readable.
export function TooltipBody({
  intro,
  howToSet,
  current,
  affects,
  warning,
}: {
  intro: React.ReactNode;
  howToSet?: React.ReactNode;
  current?: React.ReactNode;
  affects?: React.ReactNode;
  warning?: React.ReactNode;
}) {
  return (
    <div className="space-y-2 text-xs leading-relaxed">
      <div>{intro}</div>
      {howToSet && (
        <div>
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            How to set this
          </div>
          <div>{howToSet}</div>
        </div>
      )}
      {current && (
        <div>
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Current values
          </div>
          <div className="font-mono text-[11px]">{current}</div>
        </div>
      )}
      {warning && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-[11px] text-amber-200">
          {warning}
        </div>
      )}
      {affects && (
        <div className="border-t border-border pt-1.5 text-[10px] text-muted-foreground">
          {affects}
        </div>
      )}
    </div>
  );
}
