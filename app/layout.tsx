import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";

export const metadata: Metadata = {
  title: "CSP Screener",
  description: "Cash-Secured Put earnings screener",
};

// Without this, iPad Safari falls back to its 980px desktop viewport
// and renders the page zoomed in. Forcing device-width keeps the
// layout at the actual viewport pixel count so the iPad-portrait
// (768px) / iPad-landscape (1024px) render matches a similarly sized
// desktop window.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
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
