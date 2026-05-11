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
  ChevronLeft,
  ChevronRight,
  Layers,
  Lightbulb,
  Menu,
  PieChart,
  Search,
  Settings,
  Star,
  Telescope,
  TrendingUp,
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

// Collapsible group: a top-level entry that expands to show sub-items
// when the sidebar is in expanded mode, and collapses to a single
// tooltip-tagged icon (linking to the first sub-item) when the
// sidebar is in collapsed mode.
type NavGroup = {
  key: string;
  icon: LucideIcon;
  label: string;
  basePath: string;
  subItems: SubItem[];
};

// Effective rendering mode for sidebar children. The mobile drawer
// always uses "expanded"; desktop honors the persisted collapse
// toggle.
type Mode = "expanded" | "collapsed";

// localStorage key for the persisted desktop collapse state.
const LS_COLLAPSED = "sidebar_collapsed";

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
const PERFORMANCE: NavItem = {
  href: "/intelligence/performance",
  label: "Performance",
  icon: TrendingUp,
};

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
  // Desktop collapse state. Defaults to false on the server; the
  // useEffect below hydrates it from localStorage on the client.
  const [collapsed, setCollapsed] = useState<boolean>(false);
  // Viewport tracker — mobile drawer always renders the expanded
  // view regardless of the persisted desktop collapse state.
  const [isMobile, setIsMobile] = useState<boolean>(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_COLLAPSED);
      if (raw !== null) setCollapsed(raw === "1");
    } catch {
      /* ignore — localStorage unavailable (private mode, etc.) */
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(LS_COLLAPSED, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

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

  const mode: Mode = isMobile ? "expanded" : collapsed ? "collapsed" : "expanded";

  return (
    <TooltipProvider delayDuration={150}>
      {/* Mobile hamburger — opens the drawer overlay. The drawer
          always renders in expanded mode regardless of the desktop
          collapse state. */}
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
          "flex shrink-0 flex-col border-r border-white/10 bg-zinc-900",
          // Mobile drawer: fixed overlay, slides in/out
          "fixed inset-y-0 left-0 z-50 w-60 transition-transform",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop: in-flow, width controlled by the collapse state.
          // Width transitions smoothly when the user toggles.
          "md:static md:translate-x-0 md:transition-[width]",
          mode === "collapsed" ? "md:w-14" : "md:w-60",
        )}
      >
        <div className="flex h-14 items-center border-b border-white/10 px-3">
          {mode === "expanded" ? (
            <>
              <Link
                href="/"
                className="flex flex-1 items-center gap-2 font-semibold text-white"
                aria-label="CSP Screener"
              >
                <BarChart3 className="h-5 w-5 shrink-0 text-emerald-400" />
                <span className="text-sm">CSP Screener</span>
              </Link>
              {/* Desktop collapse toggle — sits in the header's right
                  edge. Hidden on mobile since the drawer is always
                  expanded; the X close handles the mobile dismissal. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleCollapsed}
                    className="hidden rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white md:inline-flex"
                    aria-label="Collapse sidebar"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Collapse sidebar</TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="ml-1 rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white md:hidden"
                aria-label="Close navigation"
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            // Collapsed mode is desktop-only (mobile drawer always
            // renders expanded) — render just the centered expand
            // chevron, replacing the logo/title.
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  className="flex w-full items-center justify-center rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white"
                  aria-label="Expand sidebar"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Expand sidebar</TooltipContent>
            </Tooltip>
          )}
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          <SectionHeader label="Options" mode={mode} />
          <CollapsibleGroup
            group={SCREENER_GROUP}
            pathname={pathname}
            open={openGroups[SCREENER_GROUP.key] ?? false}
            onToggle={() => toggleGroup(SCREENER_GROUP.key)}
            mode={mode}
          />
          <SidebarLink item={POSITIONS} pathname={pathname} mode={mode} />
          <SidebarLink item={PERFORMANCE} pathname={pathname} mode={mode} />
          <CollapsibleGroup
            group={INTELLIGENCE_GROUP}
            pathname={pathname}
            open={openGroups[INTELLIGENCE_GROUP.key] ?? false}
            onToggle={() => toggleGroup(INTELLIGENCE_GROUP.key)}
            mode={mode}
          />

          <SectionHeader label="Swings" mode={mode} />
          <SidebarLink item={SWINGS_DISCOVER} pathname={pathname} mode={mode} />
          <SidebarLink item={SWINGS_IDEAS} pathname={pathname} mode={mode} />
          <CollapsibleGroup
            group={SWINGS_JOURNAL_GROUP}
            pathname={pathname}
            open={openGroups[SWINGS_JOURNAL_GROUP.key] ?? false}
            onToggle={() => toggleGroup(SWINGS_JOURNAL_GROUP.key)}
            mode={mode}
          />

          <SectionHeader label="Long Term" mode={mode} />
          <SidebarLink item={LONGTERM_RESEARCH} pathname={pathname} mode={mode} />
          <SidebarLink item={LONGTERM_IDEAS} pathname={pathname} mode={mode} />
          <SidebarLink item={LONGTERM_WATCHLIST} pathname={pathname} mode={mode} />
          <SidebarLink item={LONGTERM_PORTFOLIO} pathname={pathname} mode={mode} />

          <SectionHeader label="Tools" mode={mode} />
          <SidebarLink item={RESEARCH} pathname={pathname} mode={mode} />
          <SidebarLink item={ENCYCLOPEDIA} pathname={pathname} mode={mode} />
          <SidebarLink item={SETTINGS} pathname={pathname} mode={mode} />
        </nav>

      </aside>
    </TooltipProvider>
  );
}

function SectionHeader({ label, mode }: { label: string; mode: Mode }) {
  // In collapsed mode the uppercase label doesn't fit — replace with
  // a thin divider so groups stay visually separated at narrow width.
  if (mode === "collapsed") {
    return <div className="my-2 border-t border-white/5" />;
  }
  return (
    <div className="mt-4 px-3 py-2 text-xs uppercase tracking-wider text-gray-500">
      {label}
    </div>
  );
}

function CollapsibleGroup({
  group,
  pathname,
  open,
  onToggle,
  mode,
}: {
  group: NavGroup;
  pathname: string;
  open: boolean;
  onToggle: () => void;
  mode: Mode;
}) {
  const active = groupActive(pathname, group);
  const Icon = group.icon;

  if (mode === "collapsed") {
    return (
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
    );
  }

  return (
    <>
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
    </>
  );
}

function SidebarLink({
  item,
  pathname,
  mode,
}: {
  item: NavItem;
  pathname: string;
  mode: Mode;
}) {
  const active = itemActive(pathname, item.href);
  const Icon = item.icon;
  const base = cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
    active
      ? "bg-white/10 text-white"
      : "text-gray-400 hover:bg-white/5 hover:text-white",
  );
  if (mode === "collapsed") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            href={item.href}
            className={cn(base, "justify-center")}
            aria-label={item.label}
          >
            <Icon className="h-4 w-4" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link href={item.href} className={base}>
      <Icon className="h-4 w-4 shrink-0" />
      <span>{item.label}</span>
    </Link>
  );
}
