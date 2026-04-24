import Link from "next/link";
import { BookMarked, LineChart, BookOpen, Briefcase, Settings, Star } from "lucide-react";

export function Nav() {
  return (
    <header className="border-b border-border bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <LineChart className="h-5 w-5" />
            <span>CSP Screener</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">
              Screener
            </Link>
            <Link href="/positions" className="inline-flex items-center gap-1 hover:text-foreground">
              <Briefcase className="h-4 w-4" /> Positions
            </Link>
            <Link href="/intelligence" className="inline-flex items-center gap-1 hover:text-foreground">
              <BookOpen className="h-4 w-4" /> Intelligence
            </Link>
            <Link href="/watchlist" className="inline-flex items-center gap-1 hover:text-foreground">
              <Star className="h-4 w-4" /> Watchlist
            </Link>
            <Link href="/encyclopedia" className="inline-flex items-center gap-1 hover:text-foreground">
              <BookMarked className="h-4 w-4" /> Encyclopedia
            </Link>
            <Link href="/settings" className="inline-flex items-center gap-1 hover:text-foreground">
              <Settings className="h-4 w-4" /> Settings
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}
