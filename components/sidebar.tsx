"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookMarked,
  Briefcase,
  ChevronDown,
  ChevronRight,
  Lightbulb,
  Menu,
  Settings,
  Star,
  X,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };

// Top-of-nav items. Screener uses "/" per existing app routing.
const MAIN_ITEMS: NavItem[] = [
  { href: "/", label: "Screener", icon: BarChart3 },
  { href: "/positions", label: "Positions", icon: Briefcase },
];

const INTELLIGENCE_BASE = "/intelligence";
const INTELLIGENCE_SUB_ITEMS: { href: string; label: string }[] = [
  { href: "/intelligence/performance", label: "Performance" },
  { href: "/intelligence/efficiency", label: "Efficiency" },
  { href: "/intelligence/patterns", label: "Patterns" },
];

const SECONDARY_ITEMS: NavItem[] = [
  { href: "/encyclopedia", label: "Encyclopedia", icon: BookMarked },
  { href: "/watchlist", label: "Watchlist", icon: Star },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const [mobileOpen, setMobileOpen] = useState(false);
  const [intelOpen, setIntelOpen] = useState(false);

  // Auto-expand the Intelligence section when navigating into it. Don't
  // collapse it when navigating away — respect whatever the user last
  // toggled. Mobile drawer closes on any pathname change so navigation
  // feels snappy.
  useEffect(() => {
    if (pathname.startsWith(INTELLIGENCE_BASE)) setIntelOpen(true);
  }, [pathname]);
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const inIntelligence = pathname.startsWith(INTELLIGENCE_BASE);

  return (
    <TooltipProvider delayDuration={150}>
      {/* Mobile: hamburger button (hidden on md+) */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-40 rounded-md border border-white/10 bg-zinc-900 p-2 text-gray-300 shadow md:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile: overlay behind the drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar. Mobile: fixed-position drawer that slides in.
          md (tablet): static, 56px icon-only.
          lg (desktop): 240px with labels visible. */}
      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-white/10 bg-zinc-900 transition-transform",
          // Mobile drawer baseline
          "fixed inset-y-0 left-0 z-50 w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // Tablet+: static, icon-only
          "md:static md:translate-x-0 md:w-14",
          // Desktop: wider with labels
          "lg:w-60",
        )}
      >
        {/* Logo / app name. On tablet (md → lg) the label is hidden. */}
        <div className="flex h-14 items-center justify-between border-b border-white/10 px-3">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold text-white"
          >
            <BarChart3 className="h-5 w-5 shrink-0 text-emerald-400" />
            <span className="text-sm md:hidden lg:inline">CSP Screener</span>
          </Link>
          {/* Mobile-only close button */}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-white md:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrolling nav body */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {MAIN_ITEMS.map((item) => (
            <SidebarLink key={item.href} item={item} pathname={pathname} />
          ))}

          <Divider />

          {/* Intelligence (collapsible). Desktop renders a toggle +
              inline sub-items. Tablet renders a single icon that
              links directly to the default sub-page since there's no
              room for the sub-list. */}
          <div className="hidden lg:block">
            <button
              type="button"
              onClick={() => setIntelOpen((v) => !v)}
              className={cn(
                "group flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm",
                inIntelligence
                  ? "bg-white/10 text-white"
                  : "text-gray-400 hover:bg-white/5 hover:text-white",
              )}
            >
              <Lightbulb className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">Intelligence</span>
              {intelOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
            {intelOpen && (
              <div className="mt-0.5 space-y-0.5">
                {INTELLIGENCE_SUB_ITEMS.map((sub) => {
                  const active = pathname === sub.href;
                  return (
                    <Link
                      key={sub.href}
                      href={sub.href}
                      className={cn(
                        "block rounded-md py-1.5 pl-11 pr-3 text-sm",
                        active
                          ? "bg-white/5 font-medium text-white"
                          : "text-gray-500 hover:text-gray-200",
                      )}
                    >
                      {sub.label}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
          {/* Tablet: single icon linking to the default sub-page */}
          <div className="block lg:hidden">
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href="/intelligence/performance"
                  className={cn(
                    "flex items-center justify-center rounded-md px-3 py-2",
                    inIntelligence
                      ? "bg-white/10 text-white"
                      : "text-gray-400 hover:bg-white/5 hover:text-white",
                  )}
                  aria-label="Intelligence"
                >
                  <Lightbulb className="h-4 w-4" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">Intelligence</TooltipContent>
            </Tooltip>
          </div>

          <Divider />

          {SECONDARY_ITEMS.map((item) => (
            <SidebarLink key={item.href} item={item} pathname={pathname} />
          ))}
        </nav>

        {/* Settings pinned to the bottom */}
        <div className="border-t border-white/5 p-2">
          <SidebarLink
            item={{ href: "/settings", label: "Settings", icon: Settings }}
            pathname={pathname}
          />
        </div>
      </aside>
    </TooltipProvider>
  );
}

function Divider() {
  return <div className="my-2 border-t border-white/5" />;
}

function SidebarLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  // Hide label at md (56px icon-only), show again at lg.
  const linkClasses = cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
    active
      ? "bg-white/10 text-white"
      : "text-gray-400 hover:bg-white/5 hover:text-white",
  );
  return (
    <>
      {/* Desktop + mobile drawer: icon + label */}
      <Link href={item.href} className={cn(linkClasses, "hidden lg:flex")}>
        <Icon className="h-4 w-4 shrink-0" />
        <span>{item.label}</span>
      </Link>
      {/* Tablet: icon only, tooltip on hover */}
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
      {/* Mobile drawer: full label (drawer is 240px wide so labels fit) */}
      <Link href={item.href} className={cn(linkClasses, "md:hidden")}>
        <Icon className="h-4 w-4 shrink-0" />
        <span>{item.label}</span>
      </Link>
    </>
  );
}
