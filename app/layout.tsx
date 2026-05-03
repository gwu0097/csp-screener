import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";

export const metadata: Metadata = {
  title: "CSP Screener",
  description: "Cash-Secured Put earnings screener",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {/* Two-column shell: fixed-width sidebar on the left, scrolling
            main content on the right. On desktop the shell is locked
            to viewport height and <main> scrolls inside so the
            sidebar stays fixed. On mobile the shell grows with
            content and the window scrolls naturally — a nested
            overflow-y-auto on mobile fights iOS Safari's touch-scroll
            and prevents the URL bar from auto-hiding. */}
        <div className="flex min-h-screen md:h-screen">
          <Sidebar />
          <main className="flex-1 md:overflow-y-auto">
            <div className="container py-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
