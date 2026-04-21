import Link from "next/link";
import { LineChart, History, Settings } from "lucide-react";

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
            <Link href="/history" className="inline-flex items-center gap-1 hover:text-foreground">
              <History className="h-4 w-4" /> History
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
