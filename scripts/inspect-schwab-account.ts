// Read-only inspection of the "Account Data" Schwab connection
// (lib/schwab-account.ts). Confirms accountHash resolution, then pulls
// a real transactions response and a real orders response and prints
// them raw — no parsing, no classification, no writes anywhere. This
// is the "First deliverable" inspection this script exists for; it
// does not touch positions/campaigns and does not decide what any
// transaction "means."
//
// Usage:
//   npx tsx scripts/inspect-schwab-account.ts
//   npx tsx scripts/inspect-schwab-account.ts --days 180
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): void {
  const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvLocal();

async function main() {
  const {
    checkAcctEnv,
    isSchwabAcctConnected,
    getAccountNumbers,
    getAccountTransactions,
    getAccountOrders,
  } = await import("../lib/schwab-account");

  console.log("=== env check (presence only, never values) ===");
  console.log(JSON.stringify(checkAcctEnv(), null, 2));

  console.log("\n=== connection status ===");
  console.log(JSON.stringify(await isSchwabAcctConnected(), null, 2));

  console.log("\n=== GET /trader/v1/accounts/accountNumbers ===");
  const accounts = await getAccountNumbers();
  console.log(`resolved ${accounts.length} account(s)`);
  const accountHash = accounts[0]?.hashValue;
  if (!accountHash) {
    console.log("no accountHash — stopping here");
    return;
  }
  console.log("using first account's hash for the rest of this run");

  const daysArgIdx = process.argv.indexOf("--days");
  const days = daysArgIdx !== -1 ? Number(process.argv[daysArgIdx + 1]) || 90 : 90;
  const today = new Date();
  const start = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  // Confirmed live: a bare YYYY-MM-DD startDate/endDate 400s
  // ("not a valid value for startDate") — the Trader API transactions
  // endpoint wants a full ISO-8601 datetime, not a date.
  const startDate = start.toISOString();
  const endDate = today.toISOString();

  console.log(`\n=== GET .../transactions?startDate=${startDate}&endDate=${endDate} ===`);
  const transactions = await getAccountTransactions(accountHash, { startDate, endDate });
  console.log(`${transactions.length} transaction(s) in window`);
  console.log(JSON.stringify(transactions, null, 2));

  const fromEnteredTime = start.toISOString();
  const toEnteredTime = today.toISOString();
  console.log(`\n=== GET .../orders?fromEnteredTime=${fromEnteredTime}&toEnteredTime=${toEnteredTime} ===`);
  const orders = await getAccountOrders(accountHash, { fromEnteredTime, toEnteredTime });
  console.log(`${orders.length} order(s) in window`);
  console.log(JSON.stringify(orders, null, 2));
}

main().catch((e) => {
  console.error("[inspect-schwab-account] fatal:", e);
  process.exit(1);
});
