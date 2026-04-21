"use client";

import { useMemo, useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Entry = { symbol: string; addedAt: string };
type Props = {
  initialWhitelist: Entry[];
  initialBlacklist: Entry[];
};

export function WatchlistView({ initialWhitelist, initialBlacklist }: Props) {
  const [whitelist, setWhitelist] = useState<Entry[]>(initialWhitelist);
  const [blacklist, setBlacklist] = useState<Entry[]>(initialBlacklist);

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
        <p className="text-sm text-muted-foreground">
          Whitelisted symbols auto-add on &quot;Apply Watchlist&quot; when they report earnings. Blacklisted
          symbols are always excluded from screens.
        </p>
      </header>

      <Tabs defaultValue="whitelist" className="w-full">
        <TabsList>
          <TabsTrigger value="whitelist">Whitelist ({whitelist.length})</TabsTrigger>
          <TabsTrigger value="blacklist">Blacklist ({blacklist.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="whitelist">
          <ListPanel
            title="Whitelist"
            description="Always include these symbols when they have today-AMC or tomorrow-BMO earnings."
            listType="whitelist"
            entries={whitelist}
            onUpdate={setWhitelist}
          />
        </TabsContent>

        <TabsContent value="blacklist">
          <ListPanel
            title="Blacklist"
            description="Never include these symbols, even if they otherwise pass every filter."
            listType="blacklist"
            entries={blacklist}
            onUpdate={setBlacklist}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ListPanel({
  title,
  description,
  listType,
  entries,
  onUpdate,
}: {
  title: string;
  description: string;
  listType: "whitelist" | "blacklist";
  entries: Entry[];
  onUpdate: (next: Entry[]) => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(() => [...entries].sort((a, b) => a.symbol.localeCompare(b.symbol)), [entries]);

  async function onAdd(e?: React.FormEvent) {
    e?.preventDefault();
    const sym = input.trim().toUpperCase();
    if (!sym) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, list_type: listType }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Add failed");
      const entry: Entry = { symbol: json.entry.symbol, addedAt: json.entry.addedAt };
      const next = entries.filter((e) => e.symbol !== entry.symbol).concat(entry);
      onUpdate(next);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(symbol: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? "Remove failed");
      }
      onUpdate(entries.filter((e) => e.symbol !== symbol));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={onAdd} className="flex items-center gap-2">
          <input
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm uppercase placeholder:text-muted-foreground"
            placeholder="Ticker, e.g. MSFT"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            maxLength={10}
            disabled={busy}
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            <Plus className="mr-2 h-4 w-4" />
            Add
          </Button>
        </form>

        {error && <div className="text-xs text-rose-300">{error}</div>}

        {sorted.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No symbols in this list yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Date added</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((entry) => (
                  <TableRow key={entry.symbol}>
                    <TableCell className="font-medium">{entry.symbol}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(entry.addedAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRemove(entry.symbol)}
                        disabled={busy}
                        aria-label={`Remove ${entry.symbol}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
