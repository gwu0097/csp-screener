"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookMarked,
  BookOpen,
  BookSearch,
  Briefcase,
  ChevronDown,
  ChevronRight,
  Layers,
  Lightbulb,
  Menu,
  PieChart,
  Search,
  Settings,
  Star,
  Telescope,
  X,
  Zap,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };
type SubItem = { href: string; label: string };

// Collapsible group: a top-level entry that expands to show sub-items on
// desktop, and collapses to a single tablet icon that links to the first
// sub-item when there's no room for the expanded list.
type NavGroup = {
  key: string;
  icon: LucideIcon;
  label: string;
  basePath: string;
  subItems: SubItem[];
};

// ------------ OPTIONS ------------
const SCREENER_GROUP: NavGroup = {
  key: "screener",
  icon: BarChart3,
  label: "Screener",
  basePath: "/screener-group", // virtual — no route of its own
  subItems: [
    { href: "/", label: "Candidates" },
    { href: "/watchlist", label: "CSP Watchlist" },
  ],
};

const POSITIONS: NavItem = { href: "/positions", label: "Positions", icon: Briefcase };

const INTELLIGENCE_GROUP: NavGroup = {
  key: "intelligence",
  icon: Lightbulb,
  label: "Intelligence",
  basePath: "/intelligence",
  subItems: [
    { href: "/intelligence/efficiency", label: "Efficiency" },
    { href: "/intelligence/patterns", label: "Patterns" },
  ],
};

// ------------ SWINGS ------------
const SWINGS_DISCOVER: NavItem = {
  href: "/swings/discover",
  label: "Discover",
  icon: Zap,
};
const SWINGS_IDEAS: NavItem = {
  href: "/swings/ideas",
  label: "Ideas",
  icon: Layers,
};

const SWINGS_JOURNAL_GROUP: NavGroup = {
  key: "swings-journal",
  icon: BookOpen,
  label: "Journal",
  basePath: "/swings/journal",
  subItems: [
    { href: "/swings/journal/performance", label: "Performance" },
    { href: "/swings/journal/trades", label: "Trades" },
  ],
};

// ------------ LONG TERM ------------
const LONGTERM_RESEARCH: NavItem = {
  href: "/longterm/research",
  label: "Research",
  icon: Search,
};
const LONGTERM_IDEAS: NavItem = {
  href: "/longterm/ideas",
  label: "Ideas",
  icon: Telescope,
};
const LONGTERM_WATCHLIST: NavItem = {
  href: "/longterm/watchlist",
  label: "Watchlist",
  icon: Star,
};
const LONGTERM_PORTFOLIO: NavItem = {
  href: "/longterm/portfolio",
  label: "Portfolio",
  icon: PieChart,
};

// ------------ TOOLS ------------
const RESEARCH: NavItem = {
  href: "/research",
  label: "Deep Research",
  icon: BookSearch,
};
const ENCYCLOPEDIA: NavItem = {
  href: "/encyclopedia",
  label: "Encyclopedia",
  icon: BookMarked,
};
const SETTINGS: NavItem = { href: "/settings", label: "Settings", icon: Settings };

function itemActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

// A sub-item is active only on an exact path match — otherwise two
// siblings inside the same group would both highlight.
function subActive(pathname: string, href: string): boolean {
  return pathname === href;
}

function groupActive(pathname: string, group: NavGroup): boolean {
  // Active if any sub-item matches. Prefer exact/prefix check on sub hrefs
  // over basePath so "Candidates" (href "/") doesn't leak into unrelated
  // root-relative routes.
  return group.subItems.some((s) => itemActive(pathname, s.href));
}

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  // Auto-expand any group whose sub-item is currently active. Don't
  // collapse groups on navigation away — respect the user's last toggle.
  useEffect(() => {
    for (const g of [SCREENER_GROUP, INTELLIGENCE_GROUP, SWINGS_JOURNAL_GROUP]) {
      if (groupActive(pathname, g)) {
        setOpenGroups((prev) => (prev[g.key] ? prev : { ...prev, [g.key]: true }));
      }
    }
  }, [pathname]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  function toggleGroup(key: string) {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <TooltipProvider delayDuration={150}>
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-40 rounded-md border border-white/10 bg-zinc-900 p-2 text-gray-300 shadow md:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-white/10 bg-zinc-900 transition-transform",
          "fixed inset-y-0 left-0 z-50 w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "md:static md:translate-x-0 md:w-14",
          "lg:w-60",
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-white/10 px-3">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold text-white"
          >
            <BarChart3 className="h-5 w-5 shrink-0 text-emerald-400" />
            <span className="text-sm md:hidden lg:inline">CSP Screener</span>
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white md:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          <SectionHeader label="Options" />
          <CollapsibleGroup
            group={SCREENER_GROUP}
            pathname={pathname}
            open={openGroups[SCREENER_GROUP.key] ?? false}
            onToggle={() => toggleGroup(SCREENER_GROUP.key)}
          />
          <SidebarLink item={POSITIONS} pathname={pathname} />
          {/* Performance is conceptually part of the Positions section
              — it summarises the equity curve and per-trade ROC built
              from the positions table. Indented sub-link, visible on
              mobile drawer + desktop, hidden in the icon-only tablet
              rail (no room for indented labels). */}
          <Link
            href="/intelligence/performance"
            className={cn(
              "rounded-md py-1.5 pl-11 pr-3 text-sm",
              subActive(pathname, "/intelligence/performance")
                ? "bg-white/5 font-medium text-white"
                : "text-gray-500 hover:text-gray-200",
              "block md:hidden lg:block",
            )}
          >
            Performance
          </Link>
          <CollapsibleGroup
            group={INTELLIGENCE_GROUP}
            pathname={pathname}
            open={openGroups[INTELLIGENCE_GROUP.key] ?? false}
            onToggle={() => toggleGroup(INTELLIGENCE_GROUP.key)}
          />

          <SectionHeader label="Swings" />
          <SidebarLink item={SWINGS_DISCOVER} pathname={pathname} />
          <SidebarLink item={SWINGS_IDEAS} pathname={pathname} />
          <CollapsibleGroup
            group={SWINGS_JOURNAL_GROUP}
            pathname={pathname}
            open={openGroups[SWINGS_JOURNAL_GROUP.key] ?? false}
            onToggle={() => toggleGroup(SWINGS_JOURNAL_GROUP.key)}
          />

          <SectionHeader label="Long Term" />
          <SidebarLink item={LONGTERM_RESEARCH} pathname={pathname} />
          <SidebarLink item={LONGTERM_IDEAS} pathname={pathname} />
          <SidebarLink item={LONGTERM_WATCHLIST} pathname={pathname} />
          <SidebarLink item={LONGTERM_PORTFOLIO} pathname={pathname} />

          <SectionHeader label="Tools" />
          <SidebarLink item={RESEARCH} pathname={pathname} />
          <SidebarLink item={ENCYCLOPEDIA} pathname={pathname} />
          <SidebarLink item={SETTINGS} pathname={pathname} />
        </nav>
      </aside>
    </TooltipProvider>
  );
}

function SectionHeader({ label }: { label: string }) {
  // Hidden on tablet (56px icon-only) — the uppercase label is too long
  // to fit. Replaced by a thin divider instead so groups stay visually
  // separated at that width.
  return (
    <>
      <div className="mt-4 block px-3 py-2 text-xs uppercase tracking-wider text-gray-500 md:hidden lg:block">
        {label}
      </div>
      <div className="my-2 hidden border-t border-white/5 md:block lg:hidden" />
    </>
  );
}

function CollapsibleGroup({
  group,
  pathname,
  open,
  onToggle,
}: {
  group: NavGroup;
  pathname: string;
  open: boolean;
  onToggle: () => void;
}) {
  const active = groupActive(pathname, group);
  const Icon = group.icon;

  return (
    <>
      {/* Desktop: expandable toggle with inline sub-items */}
      <div className="hidden lg:block">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm",
            active
              ? "bg-white/10 text-white"
              : "text-gray-400 hover:bg-white/5 hover:text-white",
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">{group.label}</span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        {open && (
          <div className="mt-0.5 space-y-0.5">
            {group.subItems.map((sub) => (
              <Link
                key={sub.href}
                href={sub.href}
                className={cn(
                  "block rounded-md py-1.5 pl-11 pr-3 text-sm",
                  subActive(pathname, sub.href)
                    ? "bg-white/5 font-medium text-white"
                    : "text-gray-500 hover:text-gray-200",
                )}
              >
                {sub.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Tablet: single icon → first sub-item */}
      <div className="hidden md:block lg:hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={group.subItems[0].href}
              className={cn(
                "flex items-center justify-center rounded-md px-3 py-2",
                active
                  ? "bg-white/10 text-white"
                  : "text-gray-400 hover:bg-white/5 hover:text-white",
              )}
              aria-label={group.label}
            >
              <Icon className="h-4 w-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">{group.label}</TooltipContent>
        </Tooltip>
      </div>

      {/* Mobile drawer: same as desktop (drawer is wide enough) */}
      <div className="md:hidden">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm",
            active
              ? "bg-white/10 text-white"
              : "text-gray-400 hover:bg-white/5 hover:text-white",
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">{group.label}</span>
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        {open && (
          <div className="mt-0.5 space-y-0.5">
            {group.subItems.map((sub) => (
              <Link
                key={sub.href}
                href={sub.href}
                className={cn(
                  "block rounded-md py-1.5 pl-11 pr-3 text-sm",
                  subActive(pathname, sub.href)
                    ? "bg-white/5 font-medium text-white"
                    : "text-gray-500 hover:text-gray-200",
                )}
              >
                {sub.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function SidebarLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = itemActive(pathname, item.href);
  const Icon = item.icon;
  const linkClasses = cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
    active
      ? "bg-white/10 text-white"
      : "text-gray-400 hover:bg-white/5 hover:text-white",
  );
  return (
    <>
      <Link href={item.href} className={cn(linkClasses, "hidden lg:flex")}>
        <Icon className="h-4 w-4 shrink-0" />
        <span>{item.label}</span>
      </Link>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={item.href}
            className={cn(
              linkClasses,
              "justify-center md:flex lg:hidden",
            )}
            aria-label={item.label}
          >
            <Icon className="h-4 w-4" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
      <Link href={item.href} className={cn(linkClasses, "md:hidden")}>
        <Icon className="h-4 w-4 shrink-0" />
        <span>{item.label}</span>
      </Link>
    </>
  );
}
