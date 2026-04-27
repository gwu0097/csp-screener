// Phase: Robinhood parser support.
//
// Tests 1–4 cover pure helpers (duplicated here from the route — the
// route file is a Next.js handler that can't export arbitrary helpers,
// so we re-declare the same logic and keep it byte-identical). Test 6
// exercises the full /api/trades/parse-screenshot endpoint against the
// real INTC Robinhood screenshot at test/test-robinhood.png.
//
// Run: node --env-file=.env.local --import=tsx test/test-robinhood-parser.ts
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label} ${detail ?? ""}`);
    failed += 1;
  }
}
function section(title: string) {
  console.log(`\n=============== ${title} ===============`);
}

// ----- byte-identical duplicates of the helpers in route.ts -----
function normalizeExpiry(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const mdy = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (mdy) {
    const mm = mdy[1].padStart(2, "0");
    const dd = mdy[2].padStart(2, "0");
    let year = new Date().getUTCFullYear();
    if (mdy[3]) {
      const y = Number(mdy[3]);
      year = y < 100 ? 2000 + y : y;
    }
    return `${year}-${mm}-${dd}`;
  }
  return "";
}
function roundStrikeToHalf(v: number): number {
  return Math.round(v * 2) / 2;
}

// -------- Test 1: strike calc rounds to exact half on a clean input --------
function test1_strikeClean() {
  section("Test 1: strike calc 53.83 + 0.17 → 54.00");
  const raw = 53.83 + 0.17;
  const rounded = roundStrikeToHalf(raw);
  check("raw sum equals 54.00 (within float tolerance)", Math.abs(raw - 54.0) < 1e-9);
  check("rounded to 54.00", rounded === 54.0, `got ${rounded}`);
}

// -------- Test 2: strike calc rounds to nearest 0.50 on a messy input --------
function test2_strikeMessy() {
  section("Test 2: strike calc 347.13 + 0.37 → 347.50 (nearest half)");
  const raw = 347.13 + 0.37;
  const rounded = roundStrikeToHalf(raw);
  check("raw ≈ 347.50 (floating-point noise OK)", Math.abs(raw - 347.5) < 1e-3);
  check("rounded to 347.50", rounded === 347.5, `got ${rounded}`);
  // Also check rounding when the raw lands between halves.
  check("53.76 → 54.00", roundStrikeToHalf(53.76) === 54.0);
  check("53.74 → 53.50", roundStrikeToHalf(53.74) === 53.5);
  check("347.24 → 347.00", roundStrikeToHalf(347.24) === 347.0);
}

// -------- Test 3: contracts absolute value (negative from Robinhood) --------
function test3_contractsAbs() {
  section("Test 3: contracts abs('-10') === 10");
  const n = Math.abs(Number("-10"));
  check("Math.abs(Number('-10')) === 10", n === 10);
  check("Math.abs(Number(-10)) === 10", Math.abs(Number(-10)) === 10);
}

// -------- Test 4: expiry year inference from "4/24" --------
function test4_expiryYear() {
  section("Test 4: expiry MM/DD year inference");
  const currentYear = new Date().getUTCFullYear();
  check(
    `"4/24" → "${currentYear}-04-24"`,
    normalizeExpiry("4/24") === `${currentYear}-04-24`,
    normalizeExpiry("4/24"),
  );
  check(
    `"04/24" → "${currentYear}-04-24"`,
    normalizeExpiry("04/24") === `${currentYear}-04-24`,
  );
  check(
    `"04/24/26" → "2026-04-24"`,
    normalizeExpiry("04/24/26") === "2026-04-24",
  );
  check(
    `"4/24/2026" → "2026-04-24"`,
    normalizeExpiry("4/24/2026") === "2026-04-24",
  );
  check(
    `"2026-04-24" → "2026-04-24"`,
    normalizeExpiry("2026-04-24") === "2026-04-24",
  );
}

// -------- Test 6: real round-trip through /api/trades/parse-screenshot --------
async function test6_realRoundTrip() {
  section("Test 6: real INTC Robinhood screenshot → /api/trades/parse-screenshot");
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const imgPath = path.resolve("test/test-robinhood.png");
  if (!fs.existsSync(imgPath)) {
    console.log(`  (no image at ${imgPath} — skipping)`);
    return;
  }
  const b64 = fs.readFileSync(imgPath).toString("base64");
  const dataUrl = `data:image/png;base64,${b64}`;

  let res: Response;
  try {
    res = await fetch(`${base}/api/trades/parse-screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, broker: "robinhood" }),
    });
  } catch (e) {
    console.log(`  fetch failed: ${e instanceof Error ? e.message : e}`);
    console.log("  (is the dev server running on the URL above?)");
    failed += 1;
    return;
  }
  const json = (await res.json()) as {
    trades?: Array<{
      symbol: string;
      action: string;
      contracts: number;
      strike: number;
      expiry: string;
      optionType: string;
      premium: number;
      broker: string;
      timePlaced?: string;
    }>;
    error?: string;
  };
  if (!res.ok || json.error) {
    console.log(`  API error (${res.status}): ${json.error}`);
    failed += 1;
    return;
  }
  console.log(`  API returned ${json.trades?.length ?? 0} trade(s)`);
  console.log(`  full response: ${JSON.stringify(json.trades, null, 2)}`);
  const trades = json.trades ?? [];
  check("at least 1 trade extracted", trades.length >= 1);
  if (trades.length === 0) return;
  const t = trades[0];
  check("symbol === 'INTC'", t.symbol === "INTC", t.symbol);
  check("strike === 54.00", t.strike === 54.0, String(t.strike));
  check("contracts === 10", t.contracts === 10, String(t.contracts));
  check("premium === 0.17", Math.abs(t.premium - 0.17) < 1e-6, String(t.premium));
  const currentYear = new Date().getUTCFullYear();
  check(`expiry === '${currentYear}-04-24'`, t.expiry === `${currentYear}-04-24`, t.expiry);
  check("action === 'open'", t.action === "open", t.action);
  check("broker === 'robinhood'", t.broker === "robinhood", t.broker);
  check("optionType === 'put'", t.optionType === "put", t.optionType);
}

async function main() {
  test1_strikeClean();
  test2_strikeMessy();
  test3_contractsAbs();
  test4_expiryYear();
  await test6_realRoundTrip();
  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test error:", e);
  process.exit(1);
});
