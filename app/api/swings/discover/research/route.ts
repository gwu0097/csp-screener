import { NextRequest, NextResponse } from "next/server";
import { getResearchSnapshot, getYahooNews } from "@/lib/yahoo";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Format Yahoo's unix-seconds timestamp into "X minutes/hours/days ago"
// for the news list. Anything older than 30 days falls back to a
// "MMM D, YYYY" date.
function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const ms = unixSeconds * 1000;
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 0) return "";
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  if (diff < hour) {
    const m = Math.max(1, Math.round(diff / minute));
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < day) {
    const h = Math.round(diff / hour);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (diff < 30 * day) {
    const d = Math.round(diff / day);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "")
    .trim()
    .toUpperCase();
  if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  // Two independent Yahoo calls — kicked off in parallel since neither
  // depends on the other and each can fail without taking down the page.
  const [news, snapshot] = await Promise.all([
    getYahooNews(symbol, 7),
    getResearchSnapshot(symbol),
  ]);

  return NextResponse.json({
    symbol,
    news: news.map((n) => ({
      title: n.title,
      url: n.link,
      publisher: n.publisher,
      publishedAt: relativeTime(n.publishedAt),
      publishedAtUnix: n.publishedAt,
    })),
    fundamentals: snapshot ?? null,
  });
}
