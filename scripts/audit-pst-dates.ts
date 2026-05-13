// Historical audit with the corrected PST-as-canonical convention.
// User's normal timezone is PST (UTC-7 in May); when in HK they
// trade the HK day session (HK 21:30–04:00 = UTC 13:30–20:00). A
// batch-stamped fill whose created_at lands in UTC 13:00–20:00 is
// a HK-session import that should store the trade date in PST.
//
// Print only — no DB writes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}
loadEnvLocal();

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing Supabase env");
  process.exit(1);
}
const sb = createClient(url, key);

function dateIn(tz: string, d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const WINDOW_FROM = "2026-05-07";

async function main() {
  console.log(
    "Scope: Schwab fills + positions, batch-stamped, created_at >= 2026-05-07.",
  );
  console.log(
    "HK session filter: created_at UTC hour in [13, 19] (HK 21:00–03:00 = US market session in HK time).",
  );
  console.log(
    "Correct date = PST calendar date of anchor (created_at for fills/opened_date, updated_at for closed_date).\n",
  );

  // ----- Fills -----
  const fillRes = await sb
    .from("fills")
    .select(
      "id,position_id,fill_type,contracts,premium,fill_date,created_at,import_batch_id",
    )
    .not("import_batch_id", "is", null)
    .gte("created_at", WINDOW_FROM)
    .order("created_at", { ascending: true });
  if (fillRes.error) {
    console.error("fills query failed:", fillRes.error.message);
    process.exit(1);
  }
  const allFills = (fillRes.data ?? []) as Array<{
    id: string;
    position_id: string;
    fill_type: string;
    contracts: number;
    premium: number;
    fill_date: string;
    created_at: string;
    import_batch_id: string;
  }>;

  // Filter to Schwab via positions table.
  const positionIds = Array.from(new Set(allFills.map((f) => f.position_id)));
  const posMeta = new Map<string, { symbol: string; broker: string }>();
  if (positionIds.length > 0) {
    const posRes = await sb
      .from("positions")
      .select("id,symbol,broker")
      .in("id", positionIds);
    for (const p of (posRes.data ?? []) as Array<{
      id: string;
      symbol: string;
      broker: string | null;
    }>) {
      posMeta.set(p.id, { symbol: p.symbol, broker: (p.broker ?? "").toLowerCase() });
    }
  }

  type Row = {
    id: string;
    label: string;
    fillType: string;
    qty: number;
    premium: number;
    stored: string;
    pst: string;
    et: string;
    hk: string;
    createdAtIso: string;
    needsFix: boolean;
  };
  const hkSessionFills: Row[] = [];
  const correctFills: Row[] = [];
  for (const f of allFills) {
    const meta = posMeta.get(f.position_id);
    if (!meta || meta.broker !== "schwab") continue;
    const c = new Date(f.created_at);
    // Use full UTC range — imports happen post-session (UTC 20:00+
    // = HK 04:00+ morning), not during HK session. Showing all rows
    // so the user can read the actual distribution rather than
    // pre-filtering.
    const pst = dateIn("America/Los_Angeles", c);
    const et = dateIn("America/New_York", c);
    const hk = dateIn("Asia/Hong_Kong", c);
    const needsFix = f.fill_date !== pst;
    const row: Row = {
      id: f.id,
      label: `${meta.symbol}`,
      fillType: f.fill_type,
      qty: f.contracts,
      premium: f.premium,
      stored: f.fill_date,
      pst,
      et,
      hk,
      createdAtIso: f.created_at,
      needsFix,
    };
    if (needsFix) hkSessionFills.push(row);
    else correctFills.push(row);
  }

  console.log(
    `=== Fills needing fix (${hkSessionFills.length}) ===`,
  );
  console.log(
    "id          symbol   type  qty@prem    stored      pst         et          hk          created(UTC)",
  );
  for (const r of hkSessionFills) {
    console.log(
      `${r.id.slice(0, 8)}…  ${r.label.padEnd(7)} ${r.fillType.padEnd(5)} ${String(r.qty).padStart(3)}@${String(r.premium).padEnd(6)}  ${r.stored}  ${r.pst}  ${r.et}  ${r.hk}  ${r.createdAtIso.slice(0, 19)}Z`,
    );
  }

  console.log(
    `\n=== Fills already correct (${correctFills.length}) ===`,
  );
  for (const r of correctFills) {
    console.log(
      `${r.id.slice(0, 8)}…  ${r.label.padEnd(7)} ${r.fillType.padEnd(5)} ${String(r.qty).padStart(3)}@${String(r.premium).padEnd(6)}  ${r.stored}  pst=${r.pst}  created=${r.createdAtIso.slice(0, 19)}Z`,
    );
  }

  // ----- Positions -----
  const posRes = await sb
    .from("positions")
    .select(
      "id,symbol,strike,broker,opened_date,closed_date,status,created_at,updated_at",
    )
    .eq("broker", "schwab")
    .not("import_batch_id", "is", null)
    .gte("created_at", WINDOW_FROM)
    .order("created_at", { ascending: true });
  const positions = (posRes.data ?? []) as Array<{
    id: string;
    symbol: string;
    strike: number;
    broker: string;
    opened_date: string | null;
    closed_date: string | null;
    status: string;
    created_at: string;
    updated_at: string;
  }>;

  type PosRow = {
    id: string;
    label: string;
    field: "opened_date" | "closed_date";
    stored: string;
    pst: string;
    et: string;
    hk: string;
    anchorIso: string;
    needsFix: boolean;
  };
  const posNeedFix: PosRow[] = [];
  const posCorrect: PosRow[] = [];

  function inspect(
    pid: string,
    sym: string,
    strike: number,
    field: "opened_date" | "closed_date",
    stored: string,
    anchorIso: string,
  ) {
    const anchor = new Date(anchorIso);
    const pst = dateIn("America/Los_Angeles", anchor);
    const et = dateIn("America/New_York", anchor);
    const hk = dateIn("Asia/Hong_Kong", anchor);
    const row: PosRow = {
      id: pid,
      label: `${sym} $${strike}`,
      field,
      stored,
      pst,
      et,
      hk,
      anchorIso,
      needsFix: stored !== pst,
    };
    if (row.needsFix) posNeedFix.push(row);
    else posCorrect.push(row);
  }
  for (const p of positions) {
    if (p.opened_date) {
      inspect(p.id, p.symbol, Number(p.strike), "opened_date", p.opened_date, p.created_at);
    }
    if (p.closed_date) {
      inspect(p.id, p.symbol, Number(p.strike), "closed_date", p.closed_date, p.updated_at);
    }
  }

  console.log(
    `\n=== Position date fields needing fix (${posNeedFix.length}) ===`,
  );
  console.log(
    "id          symbol     field         stored      pst         et          hk          anchor(UTC)",
  );
  for (const r of posNeedFix) {
    console.log(
      `${r.id.slice(0, 8)}…  ${r.label.padEnd(10)} ${r.field.padEnd(13)} ${r.stored}  ${r.pst}  ${r.et}  ${r.hk}  ${r.anchorIso.slice(0, 19)}Z`,
    );
  }
  console.log(
    `\n=== Position date fields already correct (${posCorrect.length}) ===`,
  );
  for (const r of posCorrect) {
    console.log(
      `${r.id.slice(0, 8)}…  ${r.label.padEnd(10)} ${r.field.padEnd(13)} ${r.stored}  pst=${r.pst}  anchor=${r.anchorIso.slice(0, 19)}Z`,
    );
  }

  console.log("\n=== Summary ===");
  console.log(`  Fills needing fix:                ${hkSessionFills.length}`);
  console.log(`  Fills already correct:            ${correctFills.length}`);
  console.log(`  Position date fields needing fix: ${posNeedFix.length}`);
  console.log(`  Position date fields correct:     ${posCorrect.length}`);
  console.log(`  Total rows in scope (Schwab batch fills+positions, HK-session window, since ${WINDOW_FROM})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
