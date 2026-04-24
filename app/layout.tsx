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
            main content on the right. Sidebar handles its own mobile /
            tablet / desktop responsive behavior. Main area uses
            flex-1 so it absorbs whatever width the sidebar leaves. */}
        <div className="flex h-screen">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <div className="container py-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
